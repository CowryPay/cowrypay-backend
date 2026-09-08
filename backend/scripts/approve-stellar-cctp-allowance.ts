// One-off: grant Circle's Stellar TokenMessengerMinter contract a SEP-41
// allowance to pull USDC from our shared treasury account.
//
// Real incident (2026-09-08): the first live Stellar->Base cross-chain send
// failed with HostError(Contract, #9) — "not enough allowance to spend, 0,
// 20800000". deposit_for_burn internally calls the USDC token contract's
// transfer_from(caller, tokenMessengerMinter, amount) to pull the burn
// amount, which requires caller to have already approved the
// TokenMessengerMinter contract as spender. This is the standard CCTP
// pattern (identical in spirit to the EVM side's own approve-then-burn,
// see cctpBridge.ts's initiateCctpBurn) — just never set up on the Stellar
// side since Stellar-as-source never got as far as needing it before now.
//
// Deliberately a one-off setup step, NOT an inline approve-before-every-
// burn in stellarCctpAdapter.ts: Soroban's prepareTransaction simulates
// against the LATEST ledger snapshot, and this codebase's broadcast-then-
// poll architecture (submitStellarContractCall) never waits for a
// transaction to actually close before returning — so an inline approve
// immediately followed by deposit_for_burn would very likely simulate the
// burn against a stale allowance=0 snapshot (the approve not yet landed)
// and fail nondeterministically. A large, long-lived allowance set once
// (this script) and confirmed closed avoids that race entirely.
//
// A large but bounded amount (not literal max i128) and an expiration
// several months out (not the network's absolute max) — needs periodic
// renewal, which is an acceptable operational tradeoff over an unbounded
// approval that never expires.
//
// Dry-run by default (prints current allowance); pass --apply to sign and
// submit for real, then polls for confirmation and re-reads the allowance
// to prove it actually landed.
import "dotenv/config";
import { Contract, TransactionBuilder, Networks, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { env } from "../src/config/env.js";
import { getStellarSigningKeypair } from "../src/domain/wallets/stellarKms.js";
import { withAdvisoryLock } from "../src/db/advisoryLock.js";
import { getStellarCctpContracts, getStellarUsdcContractId, checkStellarTxStatus } from "../src/domain/crossChainSend/bridge/stellarCctpSoroban.js";

const apply = process.argv.includes("--apply");
const networkPassphrase = env.stellarNetwork === "public" ? Networks.PUBLIC : Networks.TESTNET;

// 1,000,000 USDC (7 decimals) — generous headroom over the treasury's real
// balance so ordinary growth never needs a re-approval before expiration.
const APPROVE_AMOUNT = 10_000_000_0000000n;
// ~170 days at ~5s/ledger — comfortably under Soroban's max entry TTL
// (~3,110,400 ledgers / ~6 months), leaving margin rather than maxing it out.
const APPROVE_TTL_LEDGERS = 3_000_000;

async function readAllowance(server: rpc.Server, usdcContractId: string, from: string, spender: string): Promise<bigint> {
  const account = await server.getAccount(from);
  const contract = new Contract(usdcContractId);
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase })
    .addOperation(
      contract.call("allowance", nativeToScVal(from, { type: "address" }), nativeToScVal(spender, { type: "address" })),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`allowance simulation failed: ${sim.error}`);
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) throw new Error("allowance simulation returned no result");
  return BigInt(scValToNative(retval));
}

async function main() {
  const keypair = await getStellarSigningKeypair();
  if (keypair.publicKey() !== env.stellarDepositAddress) {
    throw new Error(
      `signing key's own address (${keypair.publicKey()}) doesn't match STELLAR_DEPOSIT_ADDRESS (${env.stellarDepositAddress}) — aborting, this would approve from the wrong account`,
    );
  }

  const server = new rpc.Server(env.stellarSorobanRpcUrl);
  const usdcContractId = getStellarUsdcContractId();
  const contracts = getStellarCctpContracts();

  console.log("=== account ===");
  console.log("treasury (from):", keypair.publicKey());
  console.log("spender (TokenMessengerMinter):", contracts.tokenMessengerMinter);
  console.log("USDC SAC contract:", usdcContractId);

  const currentAllowance = await readAllowance(server, usdcContractId, keypair.publicKey(), contracts.tokenMessengerMinter);
  console.log("\ncurrent allowance:", currentAllowance.toString(), "(base units, 7 decimals)");

  if (currentAllowance >= APPROVE_AMOUNT / 2n) {
    console.log("\nAllowance already sufficient — nothing to do.");
    return;
  }

  const latestLedger = await server.getLatestLedger();
  const expirationLedger = latestLedger.sequence + APPROVE_TTL_LEDGERS;
  console.log(`\nPlanned: approve ${APPROVE_AMOUNT.toString()} (expires at ledger ${expirationLedger}, current ${latestLedger.sequence})`);

  if (!apply) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  const hash = await withAdvisoryLock("stellar-sequence", async () => {
    const account = await server.getAccount(keypair.publicKey());
    const contract = new Contract(usdcContractId);
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase })
      .addOperation(
        contract.call(
          "approve",
          nativeToScVal(keypair.publicKey(), { type: "address" }),
          nativeToScVal(contracts.tokenMessengerMinter, { type: "address" }),
          nativeToScVal(APPROVE_AMOUNT, { type: "i128" }),
          nativeToScVal(expirationLedger, { type: "u32" }),
        ),
      )
      .setTimeout(60)
      .build();
    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);
    const sendResult = await server.sendTransaction(prepared);
    if (sendResult.status === "ERROR") {
      throw new Error(`approve submission failed: ${JSON.stringify(sendResult.errorResult ?? sendResult)}`);
    }
    return sendResult.hash;
  });

  console.log(`\nSubmitted: ${hash} — waiting for confirmation...`);
  for (let i = 0; i < 20; i++) {
    const status = await checkStellarTxStatus(hash);
    if (status === "success") {
      console.log("CONFIRMED.");
      break;
    }
    if (status === "failed") throw new Error("approve transaction failed on-chain");
    await new Promise((r) => setTimeout(r, 3000));
  }

  const newAllowance = await readAllowance(server, usdcContractId, keypair.publicKey(), contracts.tokenMessengerMinter);
  console.log("\nnew allowance (re-read from chain):", newAllowance.toString());
  if (newAllowance < APPROVE_AMOUNT / 2n) throw new Error("allowance did not increase as expected after confirmation");
  console.log("APPLIED successfully.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
