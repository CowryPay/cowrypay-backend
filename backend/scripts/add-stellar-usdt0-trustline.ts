// One-off: establish a trustline for USDT0 on the shared Stellar omnibus
// account (env.stellarDepositAddress / the same account
// stellarKms.getStellarSigningKeypair signs for) — required before that
// account can hold or receive USDT0 at all; Stellar rejects any payment
// of an asset the destination hasn't explicitly trusted (op_no_trust).
//
// Must run with the real app environment (railway run), not standalone —
// unlike credit-centiiv-stellar-refund.ts, this needs the actual KMS
// signing key, not just DATABASE_URL. Uses the exact same advisory lock
// (stellarAdapter.ts's "stellar-sequence" key) a real withdraw() takes,
// so this can never race a concurrent payout for the account's one
// shared sequence-number counter — same safety property, just a
// changeTrust operation instead of a payment.
//
// Dry-run by default (prints the trustline that would be added and the
// account's current trustlines); pass --apply to actually sign and submit.
import "dotenv/config";
import { Asset, Horizon, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { env } from "../src/config/env.js";
import { getStellarSigningKeypair } from "../src/domain/wallets/stellarKms.js";
import { withAdvisoryLock } from "../src/db/advisoryLock.js";

const apply = process.argv.includes("--apply");

async function main() {
  if (!env.stellarUsdt0Issuer) throw new Error("STELLAR_USDT0_ISSUER must be set");

  const keypair = await getStellarSigningKeypair();
  const server = new Horizon.Server(env.stellarHorizonUrl);
  const account = await server.loadAccount(keypair.publicKey());

  console.log("=== account ===");
  console.log("address:", keypair.publicKey());
  console.log("expected (STELLAR_DEPOSIT_ADDRESS):", env.stellarDepositAddress);
  if (keypair.publicKey() !== env.stellarDepositAddress) {
    throw new Error(
      `signing key's own address (${keypair.publicKey()}) doesn't match STELLAR_DEPOSIT_ADDRESS (${env.stellarDepositAddress}) — aborting, this would add a trustline to the wrong account`,
    );
  }

  console.log("\n=== current trustlines ===");
  for (const b of account.balances as any[]) {
    if (b.asset_type === "native") console.log(`XLM (native): ${b.balance}`);
    else console.log(`${b.asset_code} (issuer ${b.asset_issuer}): balance=${b.balance} limit=${b.limit}`);
  }

  const already = (account.balances as any[]).some(
    (b) => b.asset_code === "USDT0" && b.asset_issuer === env.stellarUsdt0Issuer,
  );
  if (already) {
    console.log("\nTrustline for USDT0 already exists — nothing to do.");
    return;
  }

  const usdt0 = new Asset("USDT0", env.stellarUsdt0Issuer);
  console.log(`\nPlanned change: add trustline for USDT0 (issuer ${env.stellarUsdt0Issuer}) on ${keypair.publicKey()}`);

  if (!apply) {
    console.log("\nDRY RUN — re-run with --apply to write.");
    return;
  }

  const networkPassphrase = env.stellarNetwork === "public" ? Networks.PUBLIC : Networks.TESTNET;

  const result = await withAdvisoryLock("stellar-sequence", async () => {
    const freshAccount = await server.loadAccount(keypair.publicKey());
    const tx = new TransactionBuilder(freshAccount, { fee: "10000", networkPassphrase })
      .addOperation(Operation.changeTrust({ asset: usdt0 }))
      .setTimeout(30)
      .build();
    tx.sign(keypair);
    return server.submitTransaction(tx);
  });

  console.log(`\nAPPLIED. Trustline established. Transaction hash: ${result.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
