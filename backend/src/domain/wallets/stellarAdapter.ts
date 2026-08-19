import { Asset, Horizon, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";
import type { CreatedWallet, WalletAdapter, WithdrawInput, WithdrawResult } from "./adapter.js";
import { stellarMemoRepo } from "./stellarMemoRepository.js";
import { getStellarSigningKeypair } from "./stellarKms.js";
import { withAdvisoryLock } from "../../db/advisoryLock.js";

function requireStellarDepositAddress(): string {
  if (!env.stellarDepositAddress) {
    throw new Error("STELLAR_DEPOSIT_ADDRESS must be set to create Stellar wallets");
  }
  return env.stellarDepositAddress;
}

function requireStellarUsdcIssuer(): string {
  if (!env.stellarUsdcIssuer) {
    throw new Error("STELLAR_USDC_ISSUER must be set to withdraw Stellar USDC");
  }
  return env.stellarUsdcIssuer;
}

const networkPassphrase = env.stellarNetwork === "public" ? Networks.PUBLIC : Networks.TESTNET;

// Every withdraw shares one account (the shared omnibus wallet) and Stellar
// accounts have a single sequence-number counter, unlike each EVM chain's
// independent per-connection nonce handling — two concurrent withdraws both
// reading the same starting sequence number would race and one would fail
// with tx_bad_seq, not a graceful retry. Serialized here with a simple
// promise chain: at most one loadAccount->build->sign->submit cycle runs at
// a time, regardless of how many callers invoke withdraw() concurrently.
// This alone only protects callers within ONE process — see
// advisoryLock.ts's own comment for why that's not actually guaranteed.
// The withdraw() call below wraps this with a cross-process advisory lock
// too: this in-memory queue stays as the fast path for same-process calls
// (no DB round trip needed to know "am I the only one in this process
// wanting the lock right now"), the advisory lock is the real safety net
// for the case this queue alone can't cover.
let withdrawQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = withdrawQueue.then(fn, fn);
  withdrawQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function extractHorizonErrorDetail(err: unknown): string {
  const resultCodes = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })?.response?.data
    ?.extras?.result_codes;
  return resultCodes ? JSON.stringify(resultCodes) : err instanceof Error ? err.message : String(err);
}

// Shared omnibus deposit address for every user (Bybit/Coinbase/Binance-style
// memo-based deposits), the opposite of every EVM adapter here — there's no
// per-user address, so "creating a wallet" just means allocating this user's
// unique numeric MEMO_ID (see stellarMemoRepository.ts / migration 0013) and
// handing back the one shared address every user is told to send USDC to.
export const stellarWalletAdapter: WalletAdapter = {
  async createWallet({ userId }): Promise<CreatedWallet> {
    const address = requireStellarDepositAddress();
    const memoId = await stellarMemoRepo.allocate(userId);
    return { externalWalletId: memoId.toString(), address, chain: "stellar" };
  },

  // Pays out from the single shared account to input.toAddress — there's no
  // per-user withdraw source, mirroring how deposits land on one shared
  // address rather than a unique one per user.
  async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
    if (input.tokenSymbol.toUpperCase() !== "USDC") {
      throw new Error(`stellar withdraw only supports USDC right now (got tokenSymbol=${input.tokenSymbol})`);
    }
    const issuer = requireStellarUsdcIssuer();
    const keypair = await getStellarSigningKeypair();
    const server = new Horizon.Server(env.stellarHorizonUrl);

    return serialize(() => withAdvisoryLock("stellar-sequence", async () => {
      const account = await server.loadAccount(keypair.publicKey());
      const usdc = new Asset("USDC", issuer);

      const tx = new TransactionBuilder(account, { fee: "10000", networkPassphrase })
        .addOperation(Operation.payment({ destination: input.toAddress, asset: usdc, amount: input.amount }))
        .setTimeout(30)
        .build();
      tx.sign(keypair);

      try {
        // Unlike awsKmsAdapter.withdraw (which deliberately returns before
        // on-chain confirmation — see its comment on the earlier
        // double-spend bug), Horizon's submit endpoint is synchronous: it
        // only returns after the transaction has actually applied to a
        // ledger. So this adapter is naturally confirmed-on-return, not the
        // "broadcast now, confirm later" pattern the EVM adapter uses — do
        // not "fix" this into an async poll later, it doesn't apply here.
        const result = await server.submitTransaction(tx);
        return { txHash: result.hash, status: "CONFIRMED" };
      } catch (err) {
        // A destination with no USDC trustline fails with Horizon's
        // op_no_trust, surfaced here in detail — initiateSend's existing
        // catch block already refunds the ledger balance and marks the
        // send FAILED on any withdraw() rejection, no special handling
        // needed beyond a clear message.
        throw new Error(`Stellar payment failed: ${extractHorizonErrorDetail(err)}`);
      }
    }));
  },
};
