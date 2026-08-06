export type ChatIntent = "address" | "balance" | "txHistory" | "chains" | "help" | "unknown";

const ADDRESS_RE = /\b(deposit address|wallet address|my address|my wallet)\b/i;
const BALANCE_RE = /\b(balance|deposit status|my deposits?|how much (do i have|is in my (account|wallet)))\b/i;
const TX_HISTORY_RE = /\b(transaction history|my transactions|recent (sends|transactions|payments)|send history|my sends)\b/i;
// Asked about literally, not hypothetically — this used to fall through to
// the free-form LLM path, which had no real data to answer with and gave a
// circular non-answer ("you can ask me what chains are supported" in
// response to being asked exactly that). Chain support is a fact about the
// user's own wallet, not something to leave to the LLM to guess at.
const CHAINS_RE =
  /\b(which|what) (chain|network|blockchain)s?\b|\b(chain|network|blockchain)s? (supported|do you support)\b|\bsupported (chain|network|blockchain)s?\b/i;
const HELP_RE = /\b(help|what can you do|commands|menu|options)\b/i;

// Deliberately simple keyword matching, not an LLM call — anything that
// reads real account data (balance, address, sends) must stay on a
// deterministic path so it can never be steered by a cleverly-phrased
// message (§9's prompt-injection concern). Only genuinely unmatched input
// reaches the LLM, which has no access to account data at all.
export function classifyIntent(message: string): ChatIntent {
  const t = message.trim();
  if (ADDRESS_RE.test(t)) return "address";
  if (BALANCE_RE.test(t)) return "balance";
  if (TX_HISTORY_RE.test(t)) return "txHistory";
  if (CHAINS_RE.test(t)) return "chains";
  if (HELP_RE.test(t)) return "help";
  return "unknown";
}

const DEPOSIT_INTENT_RE = /\b(deposit|top ?up|fund my (wallet|account)|add (money|funds|usdc))\b/i;
const CHAIN_NAME_RE = /\b(celo|base|optimism|stellar|solana)\b/i;
// A bare reply consisting of just a chain name — the natural follow-up once
// the bot has asked "which chain?". Anchored to the whole message (not
// \b-bounded like CHAIN_NAME_RE above) so an unrelated sentence that happens
// to contain one of these words ("that's a stellar idea") never triggers
// this, only a direct one-word-ish answer does.
const BARE_CHAIN_RE = /^(celo|base|optimism|stellar|solana)[.!]?$/i;

// Same deterministic-only reasoning as classifyIntent — this resolves (and
// for Stellar, lazily allocates) real wallet data, so it can't be an LLM
// call either. Separate from classifyIntent because it carries a parameter
// (which chain) that the plain string-enum ChatIntent has no room for, and
// because it also needs to fire on a bare chain-name reply mid-conversation,
// which doesn't fit classifyIntent's single-message, no-context contract.
//
// `allowBareChainName` must be false whenever a remittance draft is pending
// — resolveRemittanceIntent (remittanceDraft.ts) has its own "which chain
// would you like to send from?" question expecting the exact same kind of
// bare reply ("celo"), and that means something entirely different (send
// FROM, not deposit TO). Explicit deposit language ("I want to deposit via
// Stellar") is unambiguous either way and still matches regardless.
export function matchDepositChainRequest(
  message: string,
  options?: { allowBareChainName?: boolean },
): { chain: string | null } | null {
  const t = message.trim();
  const allowBare = options?.allowBareChainName ?? true;

  if (allowBare) {
    const bare = t.match(BARE_CHAIN_RE);
    if (bare) return { chain: bare[1].toLowerCase() };
  }

  if (DEPOSIT_INTENT_RE.test(t)) {
    const chainMatch = t.match(CHAIN_NAME_RE);
    return { chain: chainMatch ? chainMatch[1].toLowerCase() : null };
  }

  return null;
}
