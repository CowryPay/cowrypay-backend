// Confirms whether a provider-claimed refund actually landed on-chain,
// before ever trusting it. Built after a live incident (2026-09-03, send
// 071dec74): Centiiv reported a Solana order REFUNDED while its own
// fulfillments array showed a real-looking NGN payout — the exact
// self-contradiction centiivSettlementPoller.ts already refuses to
// auto-credit on. Manually tracing the treasury's own transaction history
// found the real answer: 2.178 USDC (the net amount) had genuinely
// arrived back at our Solana treasury 9 seconds after the payout
// broadcast — Centiiv's refund was real, its fulfillments data was just
// stale/wrong. This automates that same trace instead of requiring it by
// hand every time, for all three chains Centiiv actually operates on.
//
// Deliberately conservative in one direction only: any failure here
// (a chain we don't recognize, an RPC error, ambiguous/missing amount
// data) returns { confirmed: false } — the caller's existing behavior is
// to hold for manual review, which was already safe. This can only ever
// add confidence to auto-crediting, never remove the existing safety net.
import { createSolanaRpc, address as toSolanaAddress } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Horizon } from "@stellar/stellar-sdk";
import { env } from "../../config/env.js";
import type { Send } from "../../types.js";
import { getSolanaTreasurySigner } from "../wallets/solanaKms.js";
import { getSolanaMint, SOLANA_TOKEN_DECIMALS } from "../wallets/solanaAdapter.js";
import { getWalletAddress } from "../wallets/awsKmsAdapter.js";
import { getTokenConfig } from "../wallets/chains.js";

export interface RefundVerificationResult {
  confirmed: boolean;
  txHash: string | null;
}

// How far the observed amount is allowed to drift from the expected net
// amount and still count as a match — covers float/decimal-formatting
// noise, not a loose tolerance. Combined with the time-window check below,
// not a substitute for it: amount alone is nowhere near unique enough on
// a treasury that receives many small transfers (fee sweeps, deposits,
// other refunds) day to day.
const AMOUNT_TOLERANCE = 0.000005;

function amountsMatch(observed: number, expected: number): boolean {
  return Math.abs(observed - expected) <= AMOUNT_TOLERANCE;
}

function expectedNetAmount(send: Send): number {
  const gross = Number(send.amountHuman);
  const fee = Number(send.feeAmount ?? "0");
  return gross - fee;
}

async function verifySolanaRefund(send: Send): Promise<RefundVerificationResult> {
  const treasury = await getSolanaTreasurySigner();
  const rpc = createSolanaRpc(env.solanaRpcUrl);
  const owner = toSolanaAddress(treasury.address);
  const mint = toSolanaAddress(getSolanaMint(send.tokenSymbol));
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const sinceUnix = Math.floor(new Date(send.createdAt).getTime() / 1000);
  const expected = expectedNetAmount(send);

  const sigs = await rpc.getSignaturesForAddress(ata, { limit: 50 }).send();
  for (const sig of sigs) {
    if (sig.blockTime != null && Number(sig.blockTime) < sinceUnix) break; // signatures come back newest-first — once we're before the send, nothing older can match
    if (sig.err) continue;
    const tx = await rpc
      .getTransaction(sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 })
      .send()
      .catch(() => null);
    if (!tx) continue;

    const pre = tx.meta?.preTokenBalances?.find((b) => b.owner === treasury.address && b.mint === getSolanaMint(send.tokenSymbol));
    const post = tx.meta?.postTokenBalances?.find((b) => b.owner === treasury.address && b.mint === getSolanaMint(send.tokenSymbol));
    if (!pre || !post) continue;

    const delta = (Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount)) / 10 ** SOLANA_TOKEN_DECIMALS;
    if (delta > 0 && amountsMatch(delta, expected)) {
      return { confirmed: true, txHash: sig.signature };
    }
  }
  return { confirmed: false, txHash: null };
}

// Alchemy-specific RPC extension (alchemy_getAssetTransfers), not part of
// the standard eth_* JSON-RPC surface — a deliberate tradeoff, not an
// oversight. Standard eth_getLogs would be provider-agnostic, but this
// account's plan restricts it to a 10-block range per call (confirmed
// live this session), making a real search window impractical without a
// slow chunked scan. Every EVM RPC URL in this codebase already points at
// this same Alchemy account in production; if that ever changes, this
// function needs revisiting, not just its config.
async function verifyEvmRefund(send: Send): Promise<RefundVerificationResult> {
  const rpcUrl = send.chain.toLowerCase() === "base" ? env.baseRpcUrl : send.chain.toLowerCase() === "celo" ? env.celoRpcUrl : env.optimismRpcUrl;
  if (!env.awsKmsPayoutKeyArn) return { confirmed: false, txHash: null };
  const payoutAddress = await getWalletAddress(env.awsKmsPayoutKeyArn);
  const { address: tokenAddress, decimals } = getTokenConfig(send.chain, send.tokenSymbol);
  const expected = expectedNetAmount(send);
  const sinceMs = new Date(send.createdAt).getTime();

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [
        {
          fromBlock: "0x0",
          toBlock: "latest",
          toAddress: payoutAddress,
          contractAddresses: [tokenAddress],
          category: ["erc20"],
          order: "desc",
          maxCount: "0x32",
        },
      ],
    }),
  });
  const json = (await res.json()) as { result?: { transfers: Array<{ value: number; hash: string; metadata: { blockTimestamp: string } }> }; error?: unknown };
  if (!json.result) return { confirmed: false, txHash: null };

  for (const t of json.result.transfers) {
    const ts = new Date(t.metadata.blockTimestamp).getTime();
    if (ts < sinceMs) continue;
    if (amountsMatch(t.value, expected)) {
      return { confirmed: true, txHash: t.hash };
    }
  }
  void decimals; // getTokenConfig's decimals aren't needed — alchemy_getAssetTransfers already returns a human-readable `value`
  return { confirmed: false, txHash: null };
}

async function verifyStellarRefund(send: Send): Promise<RefundVerificationResult> {
  if (!env.stellarDepositAddress || !env.stellarUsdcIssuer) return { confirmed: false, txHash: null };
  const server = new Horizon.Server(env.stellarHorizonUrl);
  const expected = expectedNetAmount(send);
  const sinceMs = new Date(send.createdAt).getTime();

  const page = await server.payments().forAccount(env.stellarDepositAddress).order("desc").limit(50).call();
  for (const op of page.records) {
    if (new Date(op.created_at).getTime() < sinceMs) break; // newest-first — once before the send, nothing older can match

    // Horizon's /payments returns classic `payment` ops AND Soroban
    // `invoke_host_function` ops that moved a token. Centiiv's Stellar
    // refunds are the latter — an `execute_refund_transfer` contract call
    // whose transfer details live in `asset_balance_changes`, not on the
    // op itself — so a `op.type === "payment"` check silently misses every
    // one of them. Real incident: a send paid out 2026-09-08 08:35:44Z,
    // Centiiv's refund (tx 5eb2fef8…) landed back at the treasury 67s
    // later via exactly this kind of op, and this function returned
    // { confirmed: false }, so centiivSettlementPoller.ts held it for
    // manual review instead of crediting the user. Collect every USDC
    // credit to our address this op represents, from whichever shape.
    const observedAmounts: number[] = [];
    if (
      op.type === "payment" &&
      op.to === env.stellarDepositAddress &&
      op.asset_type !== "native" &&
      op.asset_code === "USDC" &&
      op.asset_issuer === env.stellarUsdcIssuer
    ) {
      observedAmounts.push(Number(op.amount));
    }
    const balanceChanges =
      (op as { asset_balance_changes?: Array<Record<string, unknown>> }).asset_balance_changes ?? [];
    for (const change of balanceChanges) {
      if (
        change.type === "transfer" &&
        change.to === env.stellarDepositAddress &&
        change.asset_code === "USDC" &&
        change.asset_issuer === env.stellarUsdcIssuer
      ) {
        observedAmounts.push(Number(change.amount));
      }
    }

    if (observedAmounts.some((amount) => amountsMatch(amount, expected))) {
      return { confirmed: true, txHash: op.transaction_hash };
    }
  }
  return { confirmed: false, txHash: null };
}

export async function verifyRefundOnChain(send: Send): Promise<RefundVerificationResult> {
  try {
    const chain = send.chain.toLowerCase();
    if (chain === "solana") return await verifySolanaRefund(send);
    if (chain === "stellar") return await verifyStellarRefund(send);
    if (["base", "celo", "optimism"].includes(chain)) return await verifyEvmRefund(send);
    return { confirmed: false, txHash: null };
  } catch (err) {
    console.error(`[refund-verification] on-chain check failed for send ${send.id}:`, err);
    return { confirmed: false, txHash: null };
  }
}
