import { env } from "../../config/env.js";
import { depositsRepo } from "../deposits/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { sendsRepo } from "../offramp/repository.js";
import { crossChainSendsRepo } from "../crossChainSend/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { ensureStellarWallet, ensureSolanaWallet } from "../users/service.js";
import { ensureSolanaUsdtAta } from "../wallets/solanaAdapter.js";
import { classifyIntent, matchDepositChainRequest, DEPOSIT_CHAINS } from "../../ai-agent/chat/intent.js";
import {
  buildAddressMessage,
  buildBalanceMessage,
  buildChainsMessage,
  buildCrossChainSendChainsMessage,
  buildHelpMessage,
  buildSolanaAddressMessage,
  buildStellarAddressMessage,
  buildTxHistoryMessage,
  buildWelcomeMessage,
  formatChainList,
} from "../../ai-agent/chat/responses.js";
import { createGroqClient, generateChatReply, parseWithLlm } from "./llm.js";
import { mergeRemittanceDrafts, resolveRemittanceIntent, type RemittanceDraft, type RemittanceIntent } from "./remittanceDraft.js";
import {
  mergeCryptoWithdrawalDrafts,
  resolveCryptoWithdrawalIntent,
  type CryptoWithdrawalDraft,
  type CryptoWithdrawalIntent,
} from "./cryptoWithdrawalDraft.js";
import {
  mergeCrossChainSendDrafts,
  resolveCrossChainSendIntent,
  type CrossChainSendDraft,
  type CrossChainSendIntent,
} from "./crossChainSendDraft.js";
import {
  mergeInternalTransferDrafts,
  resolveInternalTransferIntent,
  type InternalTransferDraft,
  type InternalTransferIntent,
} from "./internalTransferDraft.js";
import { clearSession, getActiveSession, saveSession, touchSession, type ChatDraftIntent } from "./sessionRepository.js";
import { resolveRateQuery, resolveAllRatesQuery } from "./rateQuery.js";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function getWelcomeReply(userId: string): Promise<string> {
  const wallet = await walletsRepo.findByUserIdAndChain(userId, env.defaultChain);
  if (!wallet) throw new Error("No wallet found for user");
  return buildWelcomeMessage();
}

export interface ChatResult {
  reply: string;
  // Present only when a remittance request fully resolved — the frontend
  // shows this as a confirmation card, collects the PIN through its own
  // dedicated flow, and submits it to POST /offramp/sends. Chat never calls
  // that itself: a message alone must never be sufficient to move money (§9).
  pendingSend?: RemittanceDraft;
  // Same §9 boundary, second money-moving flow — the frontend must show
  // the full destination address back to the user for explicit review
  // (see cryptoWithdrawalDraft.ts's own comment on why) before collecting
  // the PIN and submitting to POST /crypto-withdrawals itself.
  pendingCryptoWithdrawal?: CryptoWithdrawalDraft;
  // Same §9 boundary, third money-moving flow (API-only so far — see
  // crossChainSendDraft.ts's own comment) — the frontend must show both
  // chains and the exact address back to the user before collecting the
  // PIN and submitting to POST /cross-chain-sends itself.
  pendingCrossChainSend?: CrossChainSendDraft;
  // Same §9 boundary, fourth money-moving flow — CowryPay-to-CowryPay on
  // Stellar, identified by memo rather than an address (see
  // internalTransferDraft.ts's own comment). The frontend must show the
  // recipient memo back to the user before collecting the PIN and
  // submitting to POST /internal-transfers/stellar itself.
  pendingInternalTransfer?: InternalTransferDraft;
}

// Real incident (2026-09-08): "what's the rate" asked while a Nigeria
// remittance draft was pending inherited "country: Nigeria" from the
// "already known" context below and got classified as a rate check
// SCOPED to NGN specifically (fiatCurrency: "NGN") — reasonable-looking,
// but it meant the new all-currencies table (rateQuery.ts's
// resolveAllRatesQuery, which only fires when the parsed intent names NO
// specific currency) never fired; the user got one currency instead of
// the table they actually asked for. A rate check is never a
// continuation of anything — appended to every follow-up prompt below so
// the LLM stops trying to fold pending-draft context into it.
const RATE_CHECK_CARVE_OUT =
  ` If this new message is a standalone rate check (e.g. "what's the rate", "rate?"), classify it as kind "rate" using ONLY fields the user explicitly names in THIS message — never inherit country/currency/chain/token from the pending request above for a rate check.`;

// Gives the LLM the fields already captured from earlier messages, so a bare
// follow-up reply like "GTBank" gets recognized as continuing the pending
// send rather than misread as an unrelated one-off message.
//
// Real incident (2026-09-08): "Send 1$ to Carlos" -> asked which chain ->
// user replied "Stellar" -> misclassified as a brand-new crossChainSend
// intent (source chain, no amount context) instead of continuing the
// remittance, surfacing crossChainSendDraft.ts's own $2 minimum error for
// what should have been a plain $1 remittance. Root cause: this function
// never included recipientNickname (or chainHint/tokenHint) in the "known"
// context it hands the LLM, so a bare reply like "Stellar" — genuinely
// ambiguous on its own between "picking a chain for my pending send" and
// "starting a cross-chain send" — lost the one piece of context
// (recipientNickname: "Carlos") that would have anchored it as a
// remittance. Every field of RemittanceIntent is included now, not just
// four of the seven.
function buildFollowUpPrompt(draft: RemittanceIntent, message: string): string {
  const known: string[] = [];
  if (draft.amount != null) known.push(`amount: $${draft.amount}`);
  if (draft.fiatAmount != null) known.push(`amount: ${draft.fiatAmount} (local currency)`);
  if (draft.recipientNickname) known.push(`recipient: ${draft.recipientNickname}`);
  if (draft.countryHint) known.push(`country: ${draft.countryHint}`);
  if (draft.institutionHint) known.push(`provider: ${draft.institutionHint}`);
  if (draft.accountIdentifier) known.push(`account: ${draft.accountIdentifier}`);
  if (draft.chainHint) known.push(`chain: ${draft.chainHint}`);
  if (draft.tokenHint) known.push(`token: ${draft.tokenHint}`);
  const knownStr = known.length ? `Already known about this pending send: ${known.join(", ")}. ` : "";
  return `${knownStr}${RATE_CHECK_CARVE_OUT}The user's new message, possibly continuing this send request: "${message}"`;
}

// Same real incident class as buildFollowUpPrompt above (tokenHint was
// missing here too) — every field of CryptoWithdrawalIntent included now.
function buildCryptoWithdrawalFollowUpPrompt(draft: CryptoWithdrawalIntent, message: string): string {
  const known: string[] = [];
  if (draft.amount != null) known.push(`amount: ${draft.amount} ${draft.tokenHint ?? "USDC"}`);
  if (draft.toAddress) known.push(`destination address: ${draft.toAddress}`);
  if (draft.chainHint) known.push(`chain: ${draft.chainHint}`);
  const knownStr = known.length ? `Already known about this pending wallet withdrawal: ${known.join(", ")}. ` : "";
  return `${knownStr}${RATE_CHECK_CARVE_OUT}The user's new message, possibly continuing this withdrawal request: "${message}"`;
}

// Same real incident class (tokenHint was missing here too) — every field
// of InternalTransferIntent included now.
function buildInternalTransferFollowUpPrompt(draft: InternalTransferIntent, message: string): string {
  const known: string[] = [];
  if (draft.amount != null) known.push(`amount: ${draft.amount} ${draft.tokenHint ?? "USDC"}`);
  if (draft.recipientMemoId) known.push(`recipient memo: ${draft.recipientMemoId}`);
  const knownStr = known.length ? `Already known about this pending CowryPay-to-CowryPay transfer: ${known.join(", ")}. ` : "";
  return `${knownStr}${RATE_CHECK_CARVE_OUT}The user's new message, possibly continuing this transfer request: "${message}"`;
}

// Same real incident class (tokenHint was missing here too) — every field
// of CrossChainSendIntent included now.
function buildCrossChainSendFollowUpPrompt(draft: CrossChainSendIntent, message: string): string {
  const known: string[] = [];
  if (draft.amount != null) known.push(`amount: ${draft.amount} ${draft.tokenHint ?? "USDC"}`);
  if (draft.toAddress) known.push(`destination address: ${draft.toAddress}`);
  if (draft.sourceChainHint) known.push(`source chain: ${draft.sourceChainHint}`);
  if (draft.destinationChainHint) known.push(`destination chain: ${draft.destinationChainHint}`);
  const knownStr = known.length ? `Already known about this pending cross-chain send: ${known.join(", ")}. ` : "";
  return `${knownStr}${RATE_CHECK_CARVE_OUT}The user's new message, possibly continuing this cross-chain send request: "${message}"`;
}

export async function handleChatMessage(userId: string, message: string): Promise<ChatResult> {
  const intent = classifyIntent(message);
  // Fetched up front (not just where the LLM path used to fetch it) so the
  // deposit-chain check below can tell a bare "celo" reply apart from a
  // remittance draft's own "which chain to send from?" follow-up — see
  // matchDepositChainRequest's allowBareChainName doc comment.
  const activeDraft = await getActiveSession(userId);

  // Deterministic intents never touch a pending draft's content — they just
  // count as activity, so a quick "what's my balance?" mid-flow doesn't
  // cost the user their progress on an idle timer they didn't trigger.
  // Checked independent of `intent` — matchDepositChainRequest also fires on
  // a bare chain-name reply ("Stellar") mid-conversation, which
  // classifyIntent's single-message, no-context contract can't express.
  //
  // matchDepositChainRequest is tried FIRST, not intent === "address" —
  // found live that a message like "what's my deposit address on stellar"
  // matches classifyIntent's old ADDRESS_RE (via "deposit address") just as
  // much as it matches DEPOSIT_INTENT_RE, but the old code short-circuited
  // straight to { chain: null } the moment intent === "address" fired,
  // never even checking whether the same message also named a chain. Since
  // "stellar" was right there in the sentence, the bot re-asked a question
  // the user had already answered. matchDepositChainRequest itself already
  // returns { chain: null } (still a truthy object) for deposit-flavored
  // messages naming no chain, so falling back to intent === "address" only
  // matters for phrasing that trips the old regex but neither "deposit"
  // language nor a bare chain name (e.g. "what's my wallet address").
  const depositChainRequest =
    matchDepositChainRequest(message, { allowBareChainName: !activeDraft }) ??
    (intent === "address" ? { chain: null } : null);
  if (depositChainRequest) {
    await touchSession(userId);
    const chain = depositChainRequest.chain;

    if (!chain) {
      return { reply: `Which chain would you like to deposit to? ${formatChainList(DEPOSIT_CHAINS, "or")}.` };
    }

    if (chain === "stellar") {
      const wallet = await ensureStellarWallet(userId);
      return { reply: buildStellarAddressMessage(wallet) };
    }

    if (chain === "solana") {
      const wallet = await ensureSolanaWallet(userId);
      // USDT's ATA isn't created eagerly anymore (solanaAdapter.ts) — only
      // pay for it, and only tell the user their address accepts USDT, once
      // they've actually asked about USDT specifically.
      const wantsUsdt = /\busdt\b/i.test(message);
      if (wantsUsdt) await ensureSolanaUsdtAta(wallet.address);
      return { reply: buildSolanaAddressMessage(wallet, wantsUsdt) };
    }

    const wallet = await walletsRepo.findByUserIdAndChain(userId, env.defaultChain);
    if (!wallet) throw new Error("No wallet found for user");
    // A Blockradar wallet is genuinely single-chain (unlike aws-kms, where
    // one address is valid across Celo/Base/Optimism) — asking for a
    // different chain than the one it's actually registered on would hand
    // back an address that just wouldn't work for that chain.
    if (wallet.provider !== "aws-kms" && chain !== wallet.chain) {
      return {
        reply: `Your deposit address only supports ${capitalize(wallet.chain)} right now — ${capitalize(chain)} isn't available yet.`,
      };
    }
    return { reply: buildAddressMessage(wallet, chain) };
  }

  if (intent === "balance") {
    await touchSession(userId);
    const balances = await ledgerRepo.getBalancesForUser(userId);
    return { reply: buildBalanceMessage(balances) };
  }

  if (intent === "txHistory") {
    await touchSession(userId);
    const [sends, deposits, crossChainSends] = await Promise.all([
      sendsRepo.getForUser(userId, 5),
      depositsRepo.getForUser(userId, 5),
      crossChainSendsRepo.getForUser(userId, 5),
    ]);
    return { reply: buildTxHistoryMessage(sends, deposits, crossChainSends) };
  }

  if (intent === "chains") {
    await touchSession(userId);
    const wallet = await walletsRepo.findByUserIdAndChain(userId, env.defaultChain);
    if (!wallet) throw new Error("No wallet found for user");
    return { reply: buildChainsMessage(wallet) };
  }

  if (intent === "crossChainChains") {
    await touchSession(userId);
    return { reply: buildCrossChainSendChainsMessage() };
  }

  if (intent === "help") {
    await touchSession(userId);
    return { reply: buildHelpMessage() };
  }

  const groq = createGroqClient();
  if (!groq) {
    return { reply: await generateChatReply(message) };
  }

  // activeDraft was already fetched up front — only expired-or-absent
  // sessions come back null (see sessionRepository.ts's idle-timeout check).
  // Which follow-up prompt applies depends on which KIND of draft is
  // active — a bare "20 USDC" means something different mid-remittance
  // (an amount to send) vs. mid-withdrawal (an amount to withdraw) vs.
  // mid-cross-chain-send, so the wrong builder would misdirect the LLM.
  const llmInput = !activeDraft
    ? message
    : activeDraft.kind === "remittance"
      ? buildFollowUpPrompt(activeDraft, message)
      : activeDraft.kind === "cryptoWithdrawal"
        ? buildCryptoWithdrawalFollowUpPrompt(activeDraft, message)
        : activeDraft.kind === "internalTransfer"
          ? buildInternalTransferFollowUpPrompt(activeDraft, message)
          : buildCrossChainSendFollowUpPrompt(activeDraft, message);
  // Real incident this closes: GROQ_MODEL pointed at a model Groq had
  // fully decommissioned, and this catch swallowed every resulting
  // failure silently — chat kept working (degrading to the free-form
  // fallback below), so nothing looked broken until someone tested intent
  // parsing directly. Logged now so this shows up immediately instead of
  // silently degrading for an unknown span of time.
  const parsed = await parseWithLlm(groq, llmInput).catch((err) => {
    console.error("[chat] intent parsing failed:", err);
    return null;
  });

  if (parsed?.kind === "remittance") {
    const merged = activeDraft?.kind === "remittance" ? mergeRemittanceDrafts(activeDraft, parsed) : parsed;
    const resolution = await resolveRemittanceIntent(userId, merged);
    if (resolution.ok) {
      await clearSession(userId);
      return { reply: resolution.summary, pendingSend: resolution.draft };
    }
    await saveSession(userId, merged);
    return { reply: resolution.message };
  }

  if (parsed?.kind === "cryptoWithdrawal") {
    const merged = activeDraft?.kind === "cryptoWithdrawal" ? mergeCryptoWithdrawalDrafts(activeDraft, parsed) : parsed;
    const resolution = await resolveCryptoWithdrawalIntent(userId, merged);
    if (resolution.ok) {
      await clearSession(userId);
      return { reply: resolution.summary, pendingCryptoWithdrawal: resolution.draft };
    }
    await saveSession(userId, merged);
    return { reply: resolution.message };
  }

  if (parsed?.kind === "internalTransfer") {
    const merged = activeDraft?.kind === "internalTransfer" ? mergeInternalTransferDrafts(activeDraft, parsed) : parsed;
    const resolution = await resolveInternalTransferIntent(userId, merged);
    if (resolution.ok) {
      await clearSession(userId);
      return { reply: resolution.summary, pendingInternalTransfer: resolution.draft };
    }
    await saveSession(userId, merged);
    return { reply: resolution.message };
  }

  if (parsed?.kind === "crossChainSend") {
    const merged = activeDraft?.kind === "crossChainSend" ? mergeCrossChainSendDrafts(activeDraft, parsed) : parsed;
    const resolution = await resolveCrossChainSendIntent(userId, merged);
    if (resolution.ok) {
      await clearSession(userId);
      return { reply: resolution.summary, pendingCrossChainSend: resolution.draft };
    }
    await saveSession(userId, merged);
    return { reply: resolution.message };
  }

  // Message wasn't a continuation of the pending draft — leave it as-is
  // (still subject to the idle timeout) and handle this message on its own.
  if (activeDraft) await touchSession(userId);

  if (parsed?.kind === "admin") {
    if (parsed.action === "BALANCE") {
      const balances = await ledgerRepo.getBalancesForUser(userId);
      return { reply: buildBalanceMessage(balances) };
    }
    if (parsed.action === "TX_HISTORY") {
      const [sends, deposits, crossChainSends] = await Promise.all([
        sendsRepo.getForUser(userId, 5),
        depositsRepo.getForUser(userId, 5),
        crossChainSendsRepo.getForUser(userId, 5),
      ]);
      return { reply: buildTxHistoryMessage(sends, deposits, crossChainSends) };
    }
    if (parsed.action === "HELP") {
      return { reply: buildHelpMessage() };
    }
    // action === "CHAT" falls through to the conversational reply below.
  }

  // Read-only, like the admin actions above — no draft, no PIN, nothing
  // to confirm. A bare "what's the rate" (no specific currency or amount
  // named) shows every currency we off-ramp to at once — real feature
  // request (2026-09-08); naming a currency or amount keeps the single,
  // targeted lookup instead, since a whole table isn't what "how much is
  // 50 USDC in naira" is actually asking.
  if (parsed?.kind === "rate") {
    if (parsed.fiatCurrency == null && parsed.amount == null) {
      return { reply: await resolveAllRatesQuery(userId, parsed.tokenHint, parsed.chainHint) };
    }
    return { reply: await resolveRateQuery(userId, parsed) };
  }

  // Genuinely unmatched (or parser unavailable/errored) — free-form reply.
  // No account-data access at all, so even a manipulated reply here can't
  // leak a real balance or address; those only ever come from the
  // deterministic branches above. Degrades to a static fallback internally
  // if neither Groq nor Claude is configured.
  return { reply: await generateChatReply(message) };
}
