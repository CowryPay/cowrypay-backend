import { walletsRepo } from "../wallets/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { isValidAddressForChain } from "../cryptoWithdrawals/addressValidation.js";
import { walletChainKeyFor } from "../cryptoWithdrawals/service.js";
import { computeCrossChainSendFeeSplit } from "../offramp/fee.js";
import { getTokenConfig } from "../wallets/chains.js";
import { getBridgeAdapter } from "../crossChainSend/bridge/index.js";
import { env } from "../../config/env.js";
import { formatAmount } from "../../utils/format.js";
import type { ParsedIntent } from "./schemas.js";

// The chains that currently participate in a working cross-chain-send
// pair (see crossChainSend/bridge/cctpAdapter.ts and liFiAdapter.ts's own
// SUPPORTED_CHAINS sets — this list must stay in sync with those, since
// this is what gates the chat flow before either adapter is even
// consulted). Optimism isn't included, even though its CCTP/LI.FI signing
// paths both exist — deposits on Optimism are on hold (DEPOSIT_CHAINS in
// ai-agent/chat/intent.ts), so no user can actually hold an Optimism
// balance to send from yet. Re-add once Optimism deposits ship.
//
// Stellar was added 2026-09-01 (hand-built Soroban CCTP integration, see
// crossChainSend/bridge/stellarCctpAdapter.ts) — this list gates broadly
// (which chains exist at all in this feature), NOT precisely which pair
// directions work; stellarCctpAdapter's own supports() is the exact
// authority there. As of 2026-08-31, Stellar works as a destination
// (Base/Optimism/Solana -> Stellar) AND as a source, but only to Base or
// Solana (Stellar -> Base/Solana; Stellar -> Celo cleanly fails, since
// Celo routes through liFiAdapter regardless, which has no Stellar
// support). See explainUnsupportedBridgePairMessage below for the exact
// per-pair messaging.
export const ALL_CROSS_CHAIN_SEND_CHAINS = ["celo", "base", "solana", "stellar"];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Stellar's real coverage right now: stellarCctpAdapter's own
// NON_STELLAR_SOURCE_CHAINS/STELLAR_SOURCE_DESTINATION_CHAINS also list
// "optimism", but DEPOSIT_CHAINS (see ai-agent/chat/intent.ts) excludes
// Optimism entirely — deposits there are on hold, so no user can ever
// actually hold an Optimism balance to send from or land funds meant to be
// spent from. Dropped here for that reason, not because the adapter itself
// rejects it.
const STELLAR_DESTINATION_SOURCE_CHAINS = ["base", "solana"]; // chains that can send TO Stellar
const STELLAR_SOURCE_DESTINATION_CHAINS = ["base", "solana"]; // chains Stellar can send TO

// bridge.supports() returning false covers a few structurally different
// cases that a flat "isn't supported yet" doesn't distinguish — same
// vague-error problem providerSelection.ts's explainNoProviderMessage
// already fixed for offramp. Stellar is the one asymmetric-coverage chain
// right now (both directions work, but each only for two of the four
// chains a user can actually hold a balance on), so a Celo<->Stellar
// attempt deserves a real explanation, not a dead end.
function explainUnsupportedBridgePairMessage(sourceChain: string, destinationChain: string): string {
  if (destinationChain === "stellar") {
    return `Sending from ${capitalize(sourceChain)} to Stellar isn't supported yet. Stellar can currently be reached from: ${STELLAR_DESTINATION_SOURCE_CHAINS.map(capitalize).join(", ")}.`;
  }
  if (sourceChain === "stellar") {
    return `Sending from Stellar to ${capitalize(destinationChain)} isn't supported yet. From Stellar, you can currently send to: ${STELLAR_SOURCE_DESTINATION_CHAINS.map(capitalize).join(", ")}.`;
  }
  return `Sending from ${capitalize(sourceChain)} to ${capitalize(destinationChain)} isn't supported yet.`;
}

export interface CrossChainSendDraft {
  amount: string;
  toAddress: string;
  sourceChain: string;
  destinationChain: string;
  tokenSymbol: string;
}

export type CrossChainSendIntent = Extract<ParsedIntent, { kind: "crossChainSend" }>;

export type CrossChainSendResolution =
  | { ok: true; draft: CrossChainSendDraft; summary: string }
  | { ok: false; message: string };

// Mirrors cryptoWithdrawalDraft.ts's mergeCryptoWithdrawalDrafts — new
// non-empty values win, missing ones fall back to what's already known
// from an earlier message in the same multi-turn exchange.
//
// toAddress is the one field NOT carried forward unconditionally — real
// incident this closes: a draft that never resolves (e.g. stuck retrying
// a quote failure) can sit alive for days, since touchSession refreshes
// the idle timer on ANY later message without clearing it. If a later,
// unrelated request then names a genuinely different destinationChain
// without repeating the address, blindly reusing the OLD address (meant
// for a different chain) risks exactly the §9 "wrong destination is
// unrecoverable" failure this whole flow exists to prevent — an EVM-to-
// EVM chain change wouldn't even be caught by a format mismatch the way
// this specific Solana case happened to be. Dropped (not carried over)
// whenever destinationChainHint is both present and actually different
// from what the stale draft had; a genuinely continuing conversation
// (same chain, still filling in the address) is unaffected.
export function mergeCrossChainSendDrafts(
  existing: CrossChainSendIntent,
  incoming: CrossChainSendIntent,
): CrossChainSendIntent {
  const destinationChanged =
    incoming.destinationChainHint != null &&
    existing.destinationChainHint != null &&
    incoming.destinationChainHint.toLowerCase() !== existing.destinationChainHint.toLowerCase();
  return {
    kind: "crossChainSend",
    action: "SEND_CROSS_CHAIN",
    amount: incoming.amount ?? existing.amount,
    toAddress: incoming.toAddress ?? (destinationChanged ? undefined : existing.toAddress),
    sourceChainHint: incoming.sourceChainHint ?? existing.sourceChainHint,
    destinationChainHint: incoming.destinationChainHint ?? existing.destinationChainHint,
    tokenHint: incoming.tokenHint ?? existing.tokenHint,
  };
}

// The one thing this must never do is trust a parsed address as final —
// same §9 boundary as cryptoWithdrawalDraft.ts (see its own comment on
// why). This only ever produces a DRAFT: the frontend shows it back to
// the user in full (both chains, the exact address, the fee, the
// estimate) for explicit review before they enter their PIN and the app
// calls the real, unchanged POST /cross-chain-sends endpoint directly —
// chat never calls it.
export async function resolveCrossChainSendIntent(
  userId: string,
  intent: CrossChainSendIntent,
): Promise<CrossChainSendResolution> {
  if (intent.amount == null || intent.amount <= 0) {
    return { ok: false, message: "How much USDC would you like to send?" };
  }
  // Same floor the real POST /cross-chain-sends endpoint enforces (see
  // env.ts's own comment) — checked here too so a too-small amount gets
  // caught on the first message of a multi-turn draft, not after the user
  // has already answered every other question.
  if (intent.amount < Number(env.crossChainSendMinAmountUsd)) {
    return {
      ok: false,
      message: `${intent.amount} is below the ${env.crossChainSendMinAmountUsd} ${env.defaultTokenSymbol} minimum for a cross-chain send — try a larger amount.`,
    };
  }
  if (!intent.toAddress) {
    return { ok: false, message: "What's the destination wallet address?" };
  }

  const sourceChain = intent.sourceChainHint?.toLowerCase();
  const destinationChain = intent.destinationChainHint?.toLowerCase();

  if (sourceChain && !ALL_CROSS_CHAIN_SEND_CHAINS.includes(sourceChain)) {
    return {
      ok: false,
      message: `"${intent.sourceChainHint}" isn't a chain cross-chain send supports yet. Which one: ${ALL_CROSS_CHAIN_SEND_CHAINS.map(capitalize).join(", ")}?`,
    };
  }
  if (destinationChain && !ALL_CROSS_CHAIN_SEND_CHAINS.includes(destinationChain)) {
    return {
      ok: false,
      message: `"${intent.destinationChainHint}" isn't a chain cross-chain send supports yet. Which one: ${ALL_CROSS_CHAIN_SEND_CHAINS.map(capitalize).join(", ")}?`,
    };
  }
  if (!sourceChain) {
    return { ok: false, message: "Which chain do you currently have the funds on?" };
  }
  if (!destinationChain) {
    return { ok: false, message: "Which chain would you like it sent to?" };
  }
  if (sourceChain === destinationChain) {
    return {
      ok: false,
      message: `Those are the same chain — for a regular withdrawal that stays on ${capitalize(sourceChain)}, just say "withdraw" instead of "send cross-chain".`,
    };
  }

  // Checked before anything else chain-specific — a pair the bridge layer
  // doesn't support yet should fail clean here, not partway through
  // balance/fee checks. See crossChainSend/bridge/index.ts's own
  // dispatch — Celo routes through liFiAdapter.ts, everything else
  // through cctpAdapter.ts.
  const bridge = getBridgeAdapter(sourceChain, destinationChain);
  if (!bridge.supports(sourceChain, destinationChain)) {
    return {
      ok: false,
      message: explainUnsupportedBridgePairMessage(sourceChain, destinationChain),
    };
  }

  if (!isValidAddressForChain(destinationChain, intent.toAddress)) {
    return {
      ok: false,
      message: `"${intent.toAddress}" doesn't look like a valid ${capitalize(destinationChain)} address — double-check it and send it again.`,
    };
  }

  // Omitted means USDC, the only token that existed before USDT support.
  const tokenSymbol = intent.tokenHint?.toUpperCase() ?? env.defaultTokenSymbol;
  if (["celo", "base"].includes(sourceChain)) {
    try {
      getTokenConfig(sourceChain, tokenSymbol);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  const wallet = await walletsRepo.findByUserIdAndChain(userId, walletChainKeyFor(sourceChain));
  if (!wallet) {
    return { ok: false, message: `You don't have a wallet on ${capitalize(sourceChain)} yet.` };
  }

  const amountStr = intent.amount.toString();
  const balances = await ledgerRepo.getBalancesForUser(userId);
  const balance = balances.find((b) => b.chain === sourceChain && b.tokenSymbol === tokenSymbol);
  if (!balance || Number(balance.availableBalance) < intent.amount) {
    // Postgres numeric columns come back full-precision — trimmed for a
    // user-facing message the same way every other balance display in
    // this codebase already does (see formatAmount's own comment).
    const available = formatAmount(balance?.availableBalance ?? "0");
    return {
      ok: false,
      message: `You only have ${available} ${tokenSymbol} available on ${capitalize(sourceChain)} — that's less than the ${amountStr} you asked to send.`,
    };
  }

  // Same split the real POST /cross-chain-sends endpoint computes — see
  // offramp/fee.ts's own comment on why this is a smaller, dedicated
  // floor rather than reusing computeCryptoWithdrawalFeeSplit. Shown here
  // up front so it's not a surprise at PIN-entry time. A null split means
  // the amount can't even cover the minimum fee.
  const split = computeCrossChainSendFeeSplit(amountStr);
  if (!split) {
    return {
      ok: false,
      message: `${amountStr} ${tokenSymbol} is too small to send cross-chain — it wouldn't cover the minimum ${env.crossChainSendMinFeeUsd} ${tokenSymbol} fee. Try a larger amount.`,
    };
  }

  // A quote failure here (RPC hiccup, route temporarily unavailable) is
  // shown as a retryable message, not a hard error — nothing's been
  // touched yet (no debit, no draft saved as final).
  let quote;
  try {
    quote = await bridge.quote({ sourceChain, destinationChain, tokenSymbol, amount: split.netAmount });
  } catch (err) {
    return {
      ok: false,
      message: `Couldn't get a quote for that route right now (${err instanceof Error ? err.message : String(err)}) — try again in a moment.`,
    };
  }

  const draft: CrossChainSendDraft = { amount: amountStr, toAddress: intent.toAddress, sourceChain, destinationChain, tokenSymbol };
  const etaMinutes = Math.max(1, Math.round(quote.estimatedSeconds / 60));

  // Stellar-specific caveat: the mint lands via a Soroban contract call
  // (mint_and_forward), not a classic `payment` operation. Any Stellar
  // service that credits deposits by scanning for `payment` ops keyed to
  // a memo — including this platform's own stellarDepositScanner.ts —
  // will never see it, memo or no memo. That makes a shared/omnibus
  // Stellar address (e.g. an exchange deposit address requiring a memo)
  // unsafe as a destination even though its G... address looks like any
  // other valid one; only a genuine individually-owned account is safe.
  // This can't be detected from the address format alone, so it's a
  // warning, not a hard block.
  const stellarMemoWarning =
    destinationChain === "stellar"
      ? " Note: this only works for a genuine personal Stellar wallet address. Do NOT send to an exchange or platform deposit address that requires a memo — funds sent that way will not be credited."
      : "";

  return {
    ok: true,
    draft,
    summary: `Ready to send ${amountStr} ${tokenSymbol} from ${capitalize(sourceChain)} to ${intent.toAddress} on ${capitalize(destinationChain)}. Fee: ${split.feeAmount} ${tokenSymbol} — you'll receive approximately ${quote.destinationAmount} ${tokenSymbol} (the exact amount can vary slightly on this route). Estimated time: ~${etaMinutes} minute${etaMinutes === 1 ? "" : "s"}. Double-check that address and chain carefully — crypto sent cross-chain to the wrong address can't be recovered.${stellarMemoWarning} Confirm in the app to enter your PIN and complete it.`,
  };
}
