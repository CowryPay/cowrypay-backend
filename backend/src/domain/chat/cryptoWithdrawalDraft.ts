import { StrKey } from "@stellar/stellar-sdk";
import { isAddress as isEvmAddress } from "viem";
import { isAddress as isSolanaAddress } from "@solana/kit";
import { walletsRepo } from "../wallets/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { isValidAddressForChain } from "../cryptoWithdrawals/addressValidation.js";
import { buildStellarMemo } from "../wallets/stellarAdapter.js";
import { walletChainKeyFor } from "../cryptoWithdrawals/service.js";
import { computeCryptoWithdrawalFeeSplit } from "../offramp/fee.js";
import { SUPPORTED_CHAINS as EVM_CHAINS, getTokenConfig } from "../wallets/chains.js";
import { env } from "../../config/env.js";
import { formatAmount } from "../../utils/format.js";
import type { ParsedIntent } from "./schemas.js";

// Ethereum excluded here (2026-09-18, operator decision — see
// ai-agent/chat/intent.ts's DEPOSIT_CHAINS for the same call on deposits)
// — NOT removed from wallets/chains.ts's SUPPORTED_CHAINS itself, which
// this still derives from. Every EVM chain here shares one deposit
// address (one KMS key), so someone can still send USDC to it on
// Ethereum mainnet whether it's offered or not; keeping it in the
// registry is what lets that still be detected, swept, and manually
// recovered rather than becoming permanently invisible to the deposit
// scanner. This array only controls what a user can newly CHOOSE to
// withdraw from going forward (both the offered list and the validation
// below reject an explicit "ethereum" request the same way) — it says
// nothing about whether Ethereum funds can ever move again.
const ALL_WITHDRAW_CHAINS = [...EVM_CHAINS.filter((c) => c !== "mock-chain" && c !== "ethereum"), "stellar", "solana"];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface CryptoWithdrawalDraft {
  amount: string;
  toAddress: string;
  chain: string;
  tokenSymbol: string;
  // Stellar-only — see WithdrawInput's own comment (domain/wallets/
  // adapter.ts) for why this exists.
  memo?: string;
}

export type CryptoWithdrawalIntent = Extract<ParsedIntent, { kind: "cryptoWithdrawal" }>;

export type CryptoWithdrawalResolution =
  | { ok: true; draft: CryptoWithdrawalDraft; summary: string }
  // clearToAddress: real bug found live (2026-09-12) — chat/service.ts
  // saves the full merged intent back to the session on every ok:false,
  // including a toAddress that was JUST rejected as wrong (the treasury
  // guard, an invalid format). mergeCryptoWithdrawalDrafts then happily
  // carries that same bad address forward into the NEXT message too, even
  // a totally unrelated one with no address at all — a user who once hit
  // the treasury-address guard got the identical rejection again on their
  // very next, address-free message. Set only by the two rejections where
  // the CURRENT toAddress is simply wrong and must never be reused.
  | { ok: false; message: string; clearToAddress?: boolean };

// Mirrors remittanceDraft.ts's mergeRemittanceDrafts — new non-empty values
// win, missing ones fall back to what's already known from an earlier
// message in the same multi-turn exchange.
// toAddress is NOT carried forward unconditionally when chainHint actually
// changes — see crossChainSendDraft.ts's mergeCrossChainSendDrafts for the
// full incident this closes. Worse here than there: every EVM chain shares
// one address format, so a stale address surviving a chain-hint change
// (e.g. a stuck draft from days ago meant for Base silently reused for a
// new, unrelated Optimism withdrawal) would never get caught by a format
// mismatch the way a cross-chain Solana address happened to be.
export function mergeCryptoWithdrawalDrafts(
  existing: CryptoWithdrawalIntent,
  incoming: CryptoWithdrawalIntent,
): CryptoWithdrawalIntent {
  const chainChanged =
    incoming.chainHint != null && existing.chainHint != null && incoming.chainHint.toLowerCase() !== existing.chainHint.toLowerCase();
  return {
    kind: "cryptoWithdrawal",
    action: "WITHDRAW_TO_WALLET",
    amount: incoming.amount ?? existing.amount,
    toAddress: incoming.toAddress ?? (chainChanged ? undefined : existing.toAddress),
    chainHint: incoming.chainHint ?? existing.chainHint,
    tokenHint: incoming.tokenHint ?? existing.tokenHint,
    memo: incoming.memo ?? (chainChanged ? undefined : existing.memo),
  };
}

// Stellar and Solana addresses have unambiguous, non-overlapping formats,
// so a bare address alone is enough to know the chain without asking.
// EVM addresses (0x...) are genuinely ambiguous among Celo/Base/Optimism —
// the same address is valid on all three, so the chain has to come from
// the user, never guessed.
function inferChainFromAddress(address: string): string | null {
  if (StrKey.isValidEd25519PublicKey(address)) return "stellar";
  if (!isEvmAddress(address) && isSolanaAddress(address)) return "solana";
  return null;
}

// The one thing this must never do is trust a parsed address as final —
// see schemas.ts's own comment on why. This only ever produces a DRAFT:
// the frontend shows it back to the user (full address, on-screen, not
// buried in a summary) for explicit review before they enter their PIN
// and the app calls the real, unchanged POST /crypto-withdrawals endpoint
// directly — chat never calls it. Same §9 boundary remittanceDraft.ts's
// pendingSend already relies on, just extended to a second money-moving
// flow instead of building a parallel exception to it.
export async function resolveCryptoWithdrawalIntent(
  userId: string,
  intent: CryptoWithdrawalIntent,
): Promise<CryptoWithdrawalResolution> {
  if (intent.amount == null || intent.amount <= 0) {
    return { ok: false, message: "How much USDC would you like to withdraw?" };
  }
  // Same floor the real POST /crypto-withdrawals endpoint enforces (see
  // env.ts's own comment) — caught here too so a too-small amount is
  // rejected on the first message, not after every other question.
  if (intent.amount < Number(env.cryptoWithdrawalMinAmountUsd)) {
    return {
      ok: false,
      message: `${intent.amount} is below the ${env.cryptoWithdrawalMinAmountUsd} ${env.defaultTokenSymbol} minimum for a withdrawal — try a larger amount.`,
    };
  }
  // Real UX request (2026-09-12): asking for the address before the chain
  // meant a chain-specific detail (Stellar's memo — not a concept on
  // EVM/Solana) could only ever be mentioned reactively, after the user
  // already pasted an address. Asking for chain first when NEITHER is
  // known yet lets the address question itself be chain-aware from the
  // start. Only fires when both are missing — a bare address given
  // directly (the common case for Stellar/Solana, whose formats are
  // unambiguous) still resolves immediately below, no extra round-trip
  // forced on it.
  if (!intent.toAddress && !intent.chainHint) {
    return {
      ok: false,
      message: `Which chain would you like to withdraw from — ${ALL_WITHDRAW_CHAINS.map(capitalize).join(", ")}?`,
    };
  }

  let chain = intent.chainHint?.toLowerCase();
  if (chain && !ALL_WITHDRAW_CHAINS.includes(chain)) {
    return {
      ok: false,
      message: `"${intent.chainHint}" isn't a chain I recognize. Which one: ${ALL_WITHDRAW_CHAINS.map(capitalize).join(", ")}?`,
    };
  }
  if (!chain && intent.toAddress) {
    chain = inferChainFromAddress(intent.toAddress) ?? undefined;
  }

  if (!intent.toAddress) {
    // Chain is guaranteed known here (the check above only lets this far
    // when chainHint was already given) — the address question can now
    // mention the one chain-specific detail that matters.
    const memoNote =
      chain === "stellar"
        ? " If you're withdrawing to an exchange or platform account, include the memo too (e.g. \"G... with memo 12345\")."
        : "";
    return { ok: false, message: `What's the destination wallet address on ${capitalize(chain!)}?${memoNote}` };
  }

  if (!chain) {
    return {
      ok: false,
      message: `Which chain is that address on — Celo, Base, or Optimism? (I can tell Stellar and Solana addresses apart automatically, but those three all use the same address format.)`,
    };
  }

  if (!isValidAddressForChain(chain, intent.toAddress)) {
    return {
      ok: false,
      clearToAddress: true,
      message: `"${intent.toAddress}" doesn't look like a valid ${capitalize(chain)} address — double-check it and send it again.`,
    };
  }

  // Real incident (2026-09-08), and reported recurring live in the chat
  // flow specifically (2026-09-15): a user withdrawing Stellar USDC to
  // "another wallet" pasted our own shared Stellar deposit address —
  // trying to send to a CowryPay user the wrong way, since every CowryPay
  // Stellar user's own "address" IS this same shared address (see
  // internalTransfers/service.ts's own comment). The real, PIN-gated
  // POST /crypto-withdrawals endpoint has always had this exact guard
  // (cryptoWithdrawals/service.ts), but this chat DRAFT layer never did —
  // so chat happily built a full "ready to confirm" card for a doomed
  // withdrawal (Confirm would have hit that endpoint's guard and failed,
  // AFTER the user re-entered their PIN) instead of catching it here,
  // immediately, with a message that actually explains what to do
  // instead. Same check, same message, moved earlier.
  if (chain === "stellar" && env.stellarDepositAddress && intent.toAddress === env.stellarDepositAddress) {
    return {
      ok: false,
      clearToAddress: true,
      message:
        "That's CowryPay's own shared Stellar address, not an external wallet — sending here can't reach anyone specific. To send to another CowryPay user, use their memo instead (ask them for their CowryPay memo, then say \"send to memo <number>\").",
    };
  }

  // A memo only means something on Stellar (see WithdrawInput's own
  // comment, domain/wallets/adapter.ts) — rejected here too, same as the
  // real endpoint, rather than silently dropped.
  if (intent.memo && chain !== "stellar") {
    return { ok: false, message: `A memo isn't applicable on ${capitalize(chain)} — it's a Stellar-specific concept.` };
  }
  if (intent.memo) {
    try {
      buildStellarMemo(intent.memo);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Omitted means USDC, the only token that existed before USDT support.
  const tokenSymbol = intent.tokenHint?.toUpperCase() ?? env.defaultTokenSymbol;
  if (EVM_CHAINS.includes(chain)) {
    try {
      getTokenConfig(chain, tokenSymbol);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  const wallet = await walletsRepo.findByUserIdAndChain(userId, walletChainKeyFor(chain));
  if (!wallet) {
    return { ok: false, message: `You don't have a wallet on ${capitalize(chain)} yet.` };
  }

  const amountStr = intent.amount.toString();
  const balances = await ledgerRepo.getBalancesForUser(userId);
  const balance = balances.find((b) => b.chain === chain && b.tokenSymbol === tokenSymbol);
  if (!balance || Number(balance.availableBalance) < intent.amount) {
    // Postgres numeric columns come back full-precision ("0.000000000000000000")
    // — trimmed for a user-facing message the same way every other balance
    // display in this codebase already does (see formatAmount's own comment).
    const available = formatAmount(balance?.availableBalance ?? "0");
    return {
      ok: false,
      message: `You only have ${available} ${tokenSymbol} available on ${capitalize(chain)} — that's less than the ${amountStr} you asked to withdraw.`,
    };
  }

  // Same split the real POST /crypto-withdrawals endpoint computes — shown
  // here up front so the fee isn't a surprise at PIN-entry time. A null
  // split means the amount can't even cover the minimum fee.
  const split = computeCryptoWithdrawalFeeSplit(amountStr);
  if (!split) {
    return {
      ok: false,
      message: `${amountStr} ${tokenSymbol} is too small to withdraw — it wouldn't cover the minimum ${env.cryptoWithdrawalMinFeeUsd} ${tokenSymbol} fee. Try a larger amount.`,
    };
  }

  const draft: CryptoWithdrawalDraft = {
    amount: amountStr,
    toAddress: intent.toAddress,
    chain,
    tokenSymbol,
    ...(intent.memo ? { memo: intent.memo } : {}),
  };

  const memoLine = intent.memo
    ? ` Memo: ${intent.memo}.`
    : // Soft warning, not a block (mirrors crossChainSendDraft.ts's own
      // stellarMemoWarning) — most Stellar addresses are genuine personal
      // wallets that don't need one, so this can't be a hard requirement,
      // but a shared/omnibus destination (an exchange deposit address)
      // silently fails to attribute the payment without it. Tells the
      // user to cancel and resend rather than "just reply with the memo"
      // — a resolved draft clears the chat session (chat/service.ts), so
      // there's no pending draft left for a follow-up message to attach
      // to; confirm/cancel themselves are handled entirely by the app,
      // never routed back through this chat pipeline.
      chain === "stellar"
      ? " If this is an exchange or platform deposit address, it likely needs a memo to credit you correctly — if so, cancel and resend including it (e.g. \"withdraw 20 USDC to G... with memo 12345\")."
      : "";

  return {
    ok: true,
    draft,
    summary: `Ready to withdraw ${amountStr} ${tokenSymbol} to ${intent.toAddress} on ${capitalize(chain)}. Fee: ${split.feeAmount} ${tokenSymbol} — you'll receive ${split.netAmount} ${tokenSymbol}.${memoLine} Double-check that address carefully — crypto sent to the wrong address can't be recovered. Confirm in the app to enter your PIN and complete it.`,
  };
}
