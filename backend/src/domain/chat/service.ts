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
import { clearSession, getActiveSession, saveSession, touchSession, type ChatDraftIntent } from "./sessionRepository.js";

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
}

// Gives the LLM the fields already captured from earlier messages, so a bare
// follow-up reply like "GTBank" gets recognized as continuing the pending
// send rather than misread as an unrelated one-off message.
function buildFollowUpPrompt(draft: RemittanceIntent, message: string): string {
  const known: string[] = [];
  if (draft.amount != null) known.push(`amount: $${draft.amount}`);
  if (draft.countryHint) known.push(`country: ${draft.countryHint}`);
  if (draft.institutionHint) known.push(`provider: ${draft.institutionHint}`);
  if (draft.accountIdentifier) known.push(`account: ${draft.accountIdentifier}`);
  const knownStr = known.length ? `Already known about this pending send: ${known.join(", ")}. ` : "";
  return `${knownStr}The user's new message, possibly continuing this send request: "${message}"`;
}

function buildCryptoWithdrawalFollowUpPrompt(draft: CryptoWithdrawalIntent, message: string): string {
  const known: string[] = [];
  if (draft.amount != null) known.push(`amount: ${draft.amount} USDC`);
  if (draft.toAddress) known.push(`destination address: ${draft.toAddress}`);
  if (draft.chainHint) known.push(`chain: ${draft.chainHint}`);
  const knownStr = known.length ? `Already known about this pending wallet withdrawal: ${known.join(", ")}. ` : "";
  return `${knownStr}The user's new message, possibly continuing this withdrawal request: "${message}"`;
}

function buildCrossChainSendFollowUpPrompt(draft: CrossChainSendIntent, message: string): string {
  const known: string[] = [];
  if (draft.amount != null) known.push(`amount: ${draft.amount} USDC`);
  if (draft.toAddress) known.push(`destination address: ${draft.toAddress}`);
  if (draft.sourceChainHint) known.push(`source chain: ${draft.sourceChainHint}`);
  if (draft.destinationChainHint) known.push(`destination chain: ${draft.destinationChainHint}`);
  const knownStr = known.length ? `Already known about this pending cross-chain send: ${known.join(", ")}. ` : "";
  return `${knownStr}The user's new message, possibly continuing this cross-chain send request: "${message}"`;
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

  // Genuinely unmatched (or parser unavailable/errored) — free-form reply.
  // No account-data access at all, so even a manipulated reply here can't
  // leak a real balance or address; those only ever come from the
  // deterministic branches above. Degrades to a static fallback internally
  // if neither Groq nor Claude is configured.
  return { reply: await generateChatReply(message) };
}
