import { depositsRepo } from "../deposits/repository.js";
import { ledgerRepo } from "../ledger/repository.js";
import { walletsRepo } from "../wallets/repository.js";
import { classifyIntent } from "./intent.js";
import { buildAddressMessage, buildBalanceMessage, buildHelpMessage, buildWelcomeMessage } from "./responses.js";
import { createGroqClient, generateChatReply } from "./llm.js";

export async function getWelcomeReply(userId: string): Promise<string> {
  const wallet = await walletsRepo.findByUserId(userId);
  if (!wallet) throw new Error("No wallet found for user");
  return buildWelcomeMessage(wallet);
}

export async function handleChatMessage(userId: string, message: string): Promise<string> {
  const intent = classifyIntent(message);

  if (intent === "address") {
    const wallet = await walletsRepo.findByUserId(userId);
    if (!wallet) throw new Error("No wallet found for user");
    return buildAddressMessage(wallet);
  }

  if (intent === "balance") {
    const [balances, deposits] = await Promise.all([
      ledgerRepo.getBalancesForUser(userId),
      depositsRepo.getForUser(userId, 5),
    ]);
    return buildBalanceMessage(balances, deposits);
  }

  if (intent === "help") {
    return buildHelpMessage();
  }

  // Unmatched — falls to the LLM if configured. It has no account-data
  // access at all, so even a manipulated reply here can't leak a real
  // balance or address; those only ever come from the deterministic
  // branches above.
  const llm = createGroqClient();
  if (llm) {
    try {
      return await generateChatReply(llm, message);
    } catch {
      // fall through to the static reply below
    }
  }
  return `I didn't quite catch that — try asking "what's my balance", "what's my deposit address", or say "help" to see what I can do.`;
}
