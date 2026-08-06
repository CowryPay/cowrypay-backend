import type { Deposit, DepositState, LedgerBalance, Send, SendState, Wallet } from "../../types.js";
import { formatAmount } from "../../utils/format.js";

// Deliberately no address here — a user now holds a genuinely different
// deposit flow per chain (one shared EVM address vs. a shared Stellar
// address + a memo unique to them), so showing just one by default would
// either be incomplete or misleading. Ask instead: "I want to deposit" (or
// naming a chain directly) triggers matchDepositChainRequest in
// chat/service.ts, which asks which chain if unspecified.
export function buildWelcomeMessage(): string {
  return [
    "Welcome to CowryPay! 👋",
    "",
    `Say "I want to deposit" whenever you're ready to fund your account — I'll ask which chain and get you the right address.`,
    "",
    `Ask me things like "what's my balance" or say "help" to see what I can do.`,
  ].join("\n");
}

// `chain` is the specific chain the user asked about — distinct from
// wallet.chain, which for an aws-kms wallet is always env.defaultChain
// (e.g. "celo") even though the same address is valid on Base/Optimism too
// (see chains.ts). Showing the asked-about chain here, not the row's stored
// one, is what makes a "give me my Base address" reply actually say Base.
export function buildAddressMessage(wallet: Wallet, chain?: string): string {
  return [
    "Your CowryPay deposit address:",
    `${wallet.address} (${capitalize(chain ?? wallet.chain)})`,
    "",
    "Send USDC here — deposits are usually credited within moments of confirming on-chain.",
  ].join("\n");
}

// Stellar's shared omnibus address means the memo is not optional trivia —
// a deposit that lands without it (or with a memo that doesn't match this
// user's) cannot be credited automatically and falls to manual review (see
// stellarDepositScanner.ts / unmatched_stellar_deposits). Called out with a
// warning emoji deliberately, not just folded into the same copy as
// buildAddressMessage, given a real live test already showed how easy it
// is to send the right number in the wrong memo field.
export function buildStellarAddressMessage(wallet: Wallet): string {
  return [
    "Your CowryPay Stellar deposit address:",
    wallet.address,
    "",
    `⚠️ You MUST include this memo with your deposit, or it can't be credited automatically: ${wallet.externalWalletId}`,
    "",
    "Send USDC on the Stellar network to that address with that memo — deposits are usually credited within moments of confirming on-chain.",
  ].join("\n");
}

// No memo needed here, unlike Stellar — every Solana deposit address is
// already unique per user (see solanaAdapter.ts), matching Solana's own
// exchange-integration convention.
export function buildSolanaAddressMessage(wallet: Wallet): string {
  return [
    "Your CowryPay Solana deposit address:",
    wallet.address,
    "",
    "Send USDC on the Solana network to that address — deposits are usually credited within moments of confirming on-chain.",
  ].join("\n");
}

// Self-custody (aws-kms) addresses are valid on every chain in the
// self-custody registry (one KMS key, same address everywhere) — Blockradar
// wallets stay single-chain, so this only changes what self-custody users
// see. Previously said "that's the only network supported right now"
// unconditionally, which went stale (and actively wrong) the moment
// multi-chain self-custody shipped.
// Previously said "your deposit address works the same way on every
// supported network" — true for the EVM chains sharing one aws-kms
// address, but flatly wrong for Stellar/Solana, which each need their own
// separate address (and every user gets a Stellar wallet automatically,
// Solana in the background, regardless of which EVM provider they're on —
// see ensureAccount in users/service.ts). Rewritten to describe the real
// shape instead of just appending more names to the old "one address"
// framing.
export function buildChainsMessage(wallet: Wallet): string {
  const evmPart =
    wallet.provider === "aws-kms"
      ? "Celo, Base, and Optimism all share the same deposit address"
      : `${capitalize(wallet.chain)} (your only EVM network right now)`;
  return `You can deposit USDC on several networks: ${evmPart}. Stellar and Solana each need their own separate address — just say "I want to deposit via Stellar" or "...via Solana" to get it.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Balance is tracked per (token, chain) — grouped back down to one line per
// token here, same as before per-chain balances existed, unless a token
// actually has funds on more than one chain (breaks out per-chain only
// then, since USDC on one chain isn't spendable on another).
export function buildBalanceMessage(balances: LedgerBalance[]): string {
  if (balances.length === 0) {
    return `💰 Balance:\nNo balance yet — send USDC to your deposit address to get started.`;
  }

  const byToken = new Map<string, LedgerBalance[]>();
  for (const b of balances) {
    const rows = byToken.get(b.tokenSymbol) ?? [];
    rows.push(b);
    byToken.set(b.tokenSymbol, rows);
  }

  const balanceLines = [...byToken.entries()]
    .flatMap(([token, rows]) =>
      rows.length === 1
        ? [`• ${formatAmount(rows[0]!.availableBalance)} ${token}`]
        : [`• ${token}:`, ...rows.map((r) => `   - ${formatAmount(r.availableBalance)} on ${capitalize(r.chain)}`)],
    )
    .join("\n");

  return `💰 Balance:\n${balanceLines}`;
}

export function buildHelpMessage(): string {
  return [
    "Here's what I can help with right now:",
    `• "What's my balance?" — check your available balance`,
    `• "I want to deposit" — get your deposit address for a specific chain (Celo, Base, Optimism, Stellar, or Solana)`,
    `• "Which chains are supported?" — see what network your deposit address runs on`,
    `• "Send $50 to a bank account in Nigeria" — send money abroad; tell me the amount, provider, and account`,
    `• "My transactions" — see your recent activity`,
    "",
    `Need a real person? Reach us on Telegram: https://t.me/+OV3fAjsqmrtlZmY8`,
  ].join("\n");
}

export function buildTxHistoryMessage(sends: Send[], deposits: Deposit[]): string {
  if (sends.length === 0 && deposits.length === 0) {
    return `No activity yet — send USDC to your deposit address, or try "send $50 to a bank account in Nigeria".`;
  }

  const sendLines = sends.map((s) => ({
    createdAt: s.createdAt,
    text: `• Sent ${formatAmount(s.amountHuman)} ${s.tokenSymbol} → ${s.recipient.accountName} (${s.fiatCurrency}) — ${describeSendState(s.state)}`,
  }));
  const depositLines = deposits.map((d) => ({
    createdAt: d.createdAt,
    text: `• Received ${formatAmount(d.amount)} ${d.tokenSymbol} — ${describeDepositState(d.state)}`,
  }));

  const lines = [...sendLines, ...depositLines]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((l) => l.text);

  return `📜 Recent activity:\n${lines.join("\n")}`;
}

function describeSendState(state: SendState): string {
  switch (state) {
    case "COMPLETE":
      return "delivered ✅";
    case "MANUAL_REVIEW":
      return "under review";
    case "SEND_REJECTED":
    case "FAILED":
      return "failed";
    case "REFUNDED":
      return "refunded";
    default:
      return "processing";
  }
}

function describeDepositState(state: DepositState): string {
  switch (state) {
    case "BALANCE_CREDITED":
      return "credited ✅";
    case "MANUAL_REVIEW":
      return "under review";
    case "DEPOSIT_HELD":
      return "held";
    case "RETURN_TO_SENDER":
      return "returned";
    default:
      return "processing";
  }
}
