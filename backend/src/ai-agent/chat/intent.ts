export type ChatIntent = "address" | "balance" | "txHistory" | "chains" | "crossChainChains" | "help" | "unknown";

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
// Distinguishes "which chains can I deposit to" from "which chains does
// cross-chain send support" — same CHAINS_RE trigger word, genuinely
// different answer (deposit chains vs ALL_CROSS_CHAIN_SEND_CHAINS). Without
// this split, a cross-chain-send question always got buildChainsMessage's
// deposit-only answer, which never even mentions cross-chain send exists.
const CROSS_CHAIN_RE = /\bcross[- ]?chain\b|\bbridg(e|ing)\b/i;
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
  if (CHAINS_RE.test(t)) return CROSS_CHAIN_RE.test(t) ? "crossChainChains" : "chains";
  if (HELP_RE.test(t)) return "help";
  return "unknown";
}

// Single source of truth for every chain a user can deposit to. Both the
// regexes below AND buildChainsMessage (responses.ts) derive from this —
// specifically so adding a new chain means updating this one list, not
// hunting through every place a chain name happens to be hardcoded. Found
// live, twice in one session, what happens without it: buildChainsMessage
// went stale (still only listing the three EVM chains) the moment
// Stellar/Solana shipped, and this file's own regexes almost suffered the
// same fate — nothing forced either to stay in sync with the other.
// Optimism dropped (2026-08) — no off-ramp provider actually supports it
// (Quidax never did; Paycrest sends on it never settled in practice
// either, confirmed via /admin/metrics showing zero completed sends on it
// despite real deposits landing there). Deliberately NOT removed from
// wallets/chains.ts's SUPPORTED_CHAINS — that list still drives deposit
// scanning/sweeping/gas monitoring, which must keep watching it: the
// address is the same one shared across every EVM chain (one KMS key), so
// someone could still send USDC there by accident even though we no
// longer offer it as a deposit option, and an existing balance there (if
// any) must stay off-rampable via the dynamic fundedChains check in
// remittanceDraft.ts, which never depended on this list to begin with.
export const DEPOSIT_CHAINS = ["celo", "base", "stellar", "solana", "ethereum"] as const;

// "address" is included as its own trigger, not just "deposit"/"top up"/
// etc — found live that "what's my solana address" has no "deposit" in it
// at all, and the chain name sitting between "my" and "address" also broke
// classifyIntent's separate, fixed-phrase "my address" match. "address" on
// its own is a safe, unambiguous signal in this app's vocabulary — nothing
// else in chat talks about "your address" (remittance flow asks for
// account/bank/provider, never "address").
const DEPOSIT_INTENT_RE = /\b(deposit|top ?up|fund my (wallet|account)|add (money|funds|usdc)|address)\b/i;
const CHAIN_NAME_RE = new RegExp(`\\b(${DEPOSIT_CHAINS.join("|")})\\b`, "i");
// A bare reply consisting of just a chain name — the natural follow-up once
// the bot has asked "which chain?". Anchored to the whole message (not
// \b-bounded like CHAIN_NAME_RE above) so an unrelated sentence that happens
// to contain one of these words ("that's a stellar idea") never triggers
// this, only a direct one-word-ish answer does.
const BARE_CHAIN_RE = new RegExp(`^(${DEPOSIT_CHAINS.join("|")})[.!]?$`, "i");

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
