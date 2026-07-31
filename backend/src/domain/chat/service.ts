import { ledgerRepo } from "../ledger/repository.js";
import { sendsRepo } from "../offramp/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { classifyIntent } from "../../ai-agent/chat/intent.js";
import {
  buildAddressMessage,
  buildBalanceMessage,
  buildHelpMessage,
  buildTxHistoryMessage,
  buildWelcomeMessage,
} from "../../ai-agent/chat/responses.js";
import { createGroqClient, generateChatReply, parseWithLlm } from "./llm.js";
import { mergeRemittanceDrafts, resolveRemittanceIntent, type RemittanceDraft, type RemittanceIntent } from "./remittanceDraft.js";
import { clearSession, getActiveSession, saveSession, touchSession } from "./sessionRepository.js";

export async function getWelcomeReply(userId: string): Promise<string> {
  const wallet = await walletsRepo.findByUserId(userId);
  if (!wallet) throw new Error("No wallet found for user");
  return buildWelcomeMessage(wallet);
}

export interface ChatResult {
  reply: string;
  // Present only when a remittance request fully resolved — the frontend
  // shows this as a confirmation card, collects the PIN through its own
  // dedicated flow, and submits it to POST /offramp/sends. Chat never calls
  // that itself: a message alone must never be sufficient to move money (§9).
  pendingSend?: RemittanceDraft;
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

export async function handleChatMessage(userId: string, message: string): Promise<ChatResult> {
  const intent = classifyIntent(message);

  // Deterministic intents never touch a pending draft's content — they just
  // count as activity, so a quick "what's my balance?" mid-flow doesn't
  // cost the user their progress on an idle timer they didn't trigger.
  if (intent === "address") {
    await touchSession(userId);
    const wallet = await walletsRepo.findByUserId(userId);
    if (!wallet) throw new Error("No wallet found for user");
    return { reply: buildAddressMessage(wallet) };
  }

  if (intent === "balance") {
    await touchSession(userId);
    const balances = await ledgerRepo.getBalancesForUser(userId);
    return { reply: buildBalanceMessage(balances) };
  }

  if (intent === "txHistory") {
    await touchSession(userId);
    const sends = await sendsRepo.getForUser(userId, 5);
    return { reply: buildTxHistoryMessage(sends) };
  }

  if (intent === "help") {
    await touchSession(userId);
    return { reply: buildHelpMessage() };
  }

  const groq = createGroqClient();
  if (!groq) {
    return { reply: await generateChatReply(message) };
  }

  // Only expired-or-absent sessions come back null here — see
  // sessionRepository.ts for the idle-timeout check itself.
  const activeDraft = await getActiveSession(userId);
  const llmInput = activeDraft ? buildFollowUpPrompt(activeDraft, message) : message;
  const parsed = await parseWithLlm(groq, llmInput).catch(() => null);

  if (parsed?.kind === "remittance") {
    const merged = activeDraft ? mergeRemittanceDrafts(activeDraft, parsed) : parsed;
    const resolution = await resolveRemittanceIntent(userId, merged);
    if (resolution.ok) {
      await clearSession(userId);
      return { reply: resolution.summary, pendingSend: resolution.draft };
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
      const sends = await sendsRepo.getForUser(userId, 5);
      return { reply: buildTxHistoryMessage(sends) };
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
