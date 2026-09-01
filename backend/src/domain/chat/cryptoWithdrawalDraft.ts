import { StrKey } from "@stellar/stellar-sdk";
import { isAddress as isEvmAddress } from "viem";
import { isAddress as isSolanaAddress } from "@solana/kit";
import { walletsRepo } from "../wallets/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { isValidAddressForChain } from "../cryptoWithdrawals/addressValidation.js";
import { walletChainKeyFor } from "../cryptoWithdrawals/service.js";
import { computeCryptoWithdrawalFeeSplit } from "../offramp/fee.js";
import { SUPPORTED_CHAINS as EVM_CHAINS, getTokenConfig } from "../wallets/chains.js";
import { env } from "../../config/env.js";
import { formatAmount } from "../../utils/format.js";
import type { ParsedIntent } from "./schemas.js";

const ALL_WITHDRAW_CHAINS = [...EVM_CHAINS.filter((c) => c !== "mock-chain"), "stellar", "solana"];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface CryptoWithdrawalDraft {
  amount: string;
  toAddress: string;
  chain: string;
  tokenSymbol: string;
}

export type CryptoWithdrawalIntent = Extract<ParsedIntent, { kind: "cryptoWithdrawal" }>;

export type CryptoWithdrawalResolution =
  | { ok: true; draft: CryptoWithdrawalDraft; summary: string }
  | { ok: false; message: string };

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
  if (!intent.toAddress) {
    return { ok: false, message: "What's the destination wallet address?" };
  }

  let chain = intent.chainHint?.toLowerCase();
  if (chain && !ALL_WITHDRAW_CHAINS.includes(chain)) {
    return {
      ok: false,
      message: `"${intent.chainHint}" isn't a chain I recognize. Which one: ${ALL_WITHDRAW_CHAINS.map(capitalize).join(", ")}?`,
    };
  }
  if (!chain) {
    chain = inferChainFromAddress(intent.toAddress) ?? undefined;
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
      message: `"${intent.toAddress}" doesn't look like a valid ${capitalize(chain)} address — double-check it and send it again.`,
    };
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

  const draft: CryptoWithdrawalDraft = { amount: amountStr, toAddress: intent.toAddress, chain, tokenSymbol };

  return {
    ok: true,
    draft,
    summary: `Ready to withdraw ${amountStr} ${tokenSymbol} to ${intent.toAddress} on ${capitalize(chain)}. Fee: ${split.feeAmount} ${tokenSymbol} — you'll receive ${split.netAmount} ${tokenSymbol}. Double-check that address carefully — crypto sent to the wrong address can't be recovered. Confirm in the app to enter your PIN and complete it.`,
  };
}
