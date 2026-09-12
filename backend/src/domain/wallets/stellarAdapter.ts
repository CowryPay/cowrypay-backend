import { Horizon, Memo, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";
import type { CreatedWallet, WalletAdapter, WithdrawInput, WithdrawResult } from "./adapter.js";
import { stellarMemoRepo } from "./stellarMemoRepository.js";
import { getStellarSigningKeypair } from "./stellarKms.js";
import { withAdvisoryLock } from "../../db/advisoryLock.js";
import { resolveStellarAsset } from "./stellarAssets.js";

function requireStellarDepositAddress(): string {
  if (!env.stellarDepositAddress) {
    throw new Error("STELLAR_DEPOSIT_ADDRESS must be set to create Stellar wallets");
  }
  return env.stellarDepositAddress;
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

// Stellar's u64 MEMO_ID ceiling — an out-of-range numeric memo can't be
// expressed at all, so it's checked here rather than left to whatever
// error the SDK/network would surface for it.
const MAX_MEMO_ID = 18446744073709551615n;

// A numeric string becomes MEMO_ID (what exchanges/CowryPay's own deposit
// flow actually use), anything else becomes MEMO_TEXT (28-byte UTF-8
// limit — Memo.text itself throws a clear error if it doesn't fit, no
// need to duplicate that check here). Mirrors stellarDepositScanner.ts's
// own resolveMemoId's "numeric string -> id" rule, just for the outgoing
// side instead of incoming.
export function buildStellarMemo(memo: string): Memo {
  if (/^\d+$/.test(memo)) {
    const asBigInt = BigInt(memo);
    if (asBigInt > MAX_MEMO_ID) {
      throw new Error(`Memo "${memo}" is too large for a Stellar MEMO_ID (max ${MAX_MEMO_ID}) — use a shorter numeric memo, or a text memo instead.`);
    }
    return Memo.id(memo);
  }
  return Memo.text(memo);
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
    const asset = resolveStellarAsset(input.tokenSymbol);
    const keypair = await getStellarSigningKeypair();
    const server = new Horizon.Server(env.stellarHorizonUrl);

    // Built and validated BEFORE loadAccount/withAdvisoryLock below — a bad
    // memo should fail fast, not after already holding the sequence lock.
    const memo = input.memo ? buildStellarMemo(input.memo) : undefined;

    return serialize(() => withAdvisoryLock("stellar-sequence", async () => {
      const account = await server.loadAccount(keypair.publicKey());

      const builder = new TransactionBuilder(account, { fee: "10000", networkPassphrase })
        .addOperation(Operation.payment({ destination: input.toAddress, asset, amount: input.amount }))
        .setTimeout(30);
      if (memo) builder.addMemo(memo);
      const tx = builder.build();
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
