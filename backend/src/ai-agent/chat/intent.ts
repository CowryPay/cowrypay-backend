export type ChatIntent = "address" | "balance" | "help" | "unknown";

const ADDRESS_RE = /\b(deposit address|wallet address|my address|my wallet)\b/i;
const BALANCE_RE = /\b(balance|deposit status|my deposits?|how much (do i have|is in my (account|wallet)))\b/i;
const HELP_RE = /\b(help|what can you do|commands|menu|options)\b/i;

// Deliberately simple keyword matching, not an LLM call — anything that
// reads real account data (balance, address) must stay on a deterministic
// path so it can never be steered by a cleverly-phrased message (§9's
// prompt-injection concern). Only genuinely unmatched input reaches the LLM,
// which has no access to account data at all.
export function classifyIntent(message: string): ChatIntent {
  const t = message.trim();
  if (ADDRESS_RE.test(t)) return "address";
  if (BALANCE_RE.test(t)) return "balance";
  if (HELP_RE.test(t)) return "help";
  return "unknown";
}
