import { env } from "../../config/env.js";
import { depositsRepo } from "../deposits/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { sendsRepo } from "../offramp/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { ensureStellarWallet, ensureSolanaWallet } from "../users/service.js";
import { classifyIntent, matchDepositChainRequest, DEPOSIT_CHAINS } from "../../ai-agent/chat/intent.js";
import {
  buildAddressMessage,
  buildBalanceMessage,
  buildChainsMessage,
  buildHelpMessage,
  buildSolanaAddressMessage,
  buildStellarAddressMessage,
  buildTxHistoryMessage,
  buildWelcomeMessage,
  formatChainList,
} from "../../ai-agent/chat/responses.js";
import { createGroqClient, generateChatReply, parseWithLlm } from "./llm.js";
import { mergeRemittanceDrafts, resolveRemittanceIntent, type RemittanceDraft, type RemittanceIntent } from "./remittanceDraft.js";
import { clearSession, getActiveSession, saveSession, touchSession } from "./sessionRepository.js";

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
      return { reply: buildSolanaAddressMessage(wallet) };
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
    const [sends, deposits] = await Promise.all([
      sendsRepo.getForUser(userId, 5),
      depositsRepo.getForUser(userId, 5),
    ]);
    return { reply: buildTxHistoryMessage(sends, deposits) };
  }

  if (intent === "chains") {
    await touchSession(userId);
    const wallet = await walletsRepo.findByUserIdAndChain(userId, env.defaultChain);
    if (!wallet) throw new Error("No wallet found for user");
    return { reply: buildChainsMessage(wallet) };
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
      const [sends, deposits] = await Promise.all([
        sendsRepo.getForUser(userId, 5),
        depositsRepo.getForUser(userId, 5),
      ]);
      return { reply: buildTxHistoryMessage(sends, deposits) };
    }
    if (parsed.action === "HELP") {
      return { reply: buildHelpMessage() };
    }
    // action === "CHAT" falls through to the conversational reply below.
  }

  // Real bug this closes: before this intent existed, "withdraw to wallet"
  // had nothing better to match than SEND_REMITTANCE (off-ramp), which
  // then failed with a confusing, wrong error (Paycrest's own small-amount
  // rejection) for a request that was never an off-ramp at all. Sending
  // crypto to an external wallet stays REST-only by design — see
  // routes/cryptoWithdrawals.ts's own comment on why an LLM should never
  // extract a destination address from free text — so this only ever
  // recognizes the request and points the user at the real flow.
  if (parsed?.kind === "cryptoWithdrawal") {
    return {
      reply:
        "Withdrawing crypto to an external wallet isn't available here in chat — head to the Withdraw screen in the app to send USDC to a wallet address directly.",
    };
  }

  // Genuinely unmatched (or parser unavailable/errored) — free-form reply.
  // No account-data access at all, so even a manipulated reply here can't
  // leak a real balance or address; those only ever come from the
  // deterministic branches above. Degrades to a static fallback internally
  // if neither Groq nor Claude is configured.
  return { reply: await generateChatReply(message) };
}
