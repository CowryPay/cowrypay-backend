import { depositsRepo } from "../deposits/repository.js";
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
import { resolveRemittanceIntent, type RemittanceDraft } from "./remittanceDraft.js";

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

export async function handleChatMessage(userId: string, message: string): Promise<ChatResult> {
  const intent = classifyIntent(message);

  if (intent === "address") {
    const wallet = await walletsRepo.findByUserId(userId);
    if (!wallet) throw new Error("No wallet found for user");
    return { reply: buildAddressMessage(wallet) };
  }

  if (intent === "balance") {
    const [balances, deposits] = await Promise.all([
      ledgerRepo.getBalancesForUser(userId),
      depositsRepo.getForUser(userId, 5),
    ]);
    return { reply: buildBalanceMessage(balances, deposits) };
  }

  if (intent === "help") {
    return { reply: buildHelpMessage() };
  }

  // Not matched by the fast deterministic patterns above — try the LLM
  // intent parser next so natural-language send requests ("send $50 to a
  // bank account in Nigeria") get understood, not just free-form replies.
  const groq = createGroqClient();
  const parsed = groq ? await parseWithLlm(groq, message).catch(() => null) : null;

  if (parsed?.kind === "remittance") {
    const resolution = await resolveRemittanceIntent(userId, parsed);
    return resolution.ok
      ? { reply: resolution.summary, pendingSend: resolution.draft }
      : { reply: resolution.message };
  }

  if (parsed?.kind === "admin") {
    if (parsed.action === "BALANCE") {
      const [balances, deposits] = await Promise.all([
        ledgerRepo.getBalancesForUser(userId),
        depositsRepo.getForUser(userId, 5),
      ]);
      return { reply: buildBalanceMessage(balances, deposits) };
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
