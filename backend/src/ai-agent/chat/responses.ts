import type { CrossChainSend, CrossChainSendState, Deposit, DepositState, LedgerBalance, Send, SendState, Wallet } from "../../types.js";
import { formatAmount } from "../../utils/format.js";
import { DEPOSIT_CHAINS } from "./intent.js";
import { ALL_CROSS_CHAIN_SEND_CHAINS } from "../../domain/chat/crossChainSendDraft.js";

// The non-EVM chains, each needing their own separate deposit address —
// everything else in DEPOSIT_CHAINS shares one EVM address. Kept as an
// explicit exclusion list (not e.g. a "chainKind" field) since there are
// only ever a couple of these and a wrong guess here is easy to catch by
// eye, unlike silently stale prose.
const NON_EVM_CHAINS = new Set(["stellar", "solana"]);
const EVM_DEPOSIT_CHAINS = DEPOSIT_CHAINS.filter((c) => !NON_EVM_CHAINS.has(c));

// "Celo, Base, and Optimism" / "Celo or Base" / "Celo" — grammatically
// correct regardless of how many chains are in the list, so removing (or
// adding) one is just an edit to DEPOSIT_CHAINS, never prose anywhere
// else. conjunction is "and" for "these all share X" framing (buildChainsMessage)
// vs "or" for "pick one of these" framing (buildHelpMessage) — same list,
// different grammar depending on which claim is being made about it.
export function formatChainList(chains: readonly string[], conjunction: "and" | "or" = "and"): string {
  const names = chains.map(capitalize);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1]}`;
}

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
//
// `usdtReady` must only be true once ensureSolanaUsdtAta has actually run
// for this address (see chat/service.ts's solana branch) — USDT's ATA
// isn't created eagerly at signup anymore (solanaAdapter.ts), so telling a
// user to send USDT before that call has completed could land a deposit
// with nowhere to go.
export function buildSolanaAddressMessage(wallet: Wallet, usdtReady = false): string {
  return [
    "Your CowryPay Solana deposit address:",
    wallet.address,
    "",
    usdtReady
      ? "Send USDC or USDT on the Solana network to that address — deposits are usually credited within moments of confirming on-chain."
      : "Send USDC on the Solana network to that address — deposits are usually credited within moments of confirming on-chain.",
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
      ? `${formatChainList(EVM_DEPOSIT_CHAINS)} all share the same deposit address`
      : `${capitalize(wallet.chain)} (your only EVM network right now)`;
  return `You can deposit USDC on several networks: ${evmPart}. Stellar and Solana each need their own separate address — just say "I want to deposit via Stellar" or "...via Solana" to get it.`;
}

// Answers "which chains does cross-chain send support" — deliberately
// separate from buildChainsMessage (that one describes DEPOSIT chains, a
// different question that happens to use the same trigger word "chains";
// see intent.ts's CROSS_CHAIN_RE split). ALL_CROSS_CHAIN_SEND_CHAINS is
// crossChainSendDraft.ts's own single source of truth — same chains it
// asks about mid-flow, so this list can't drift from what actually works.
export function buildCrossChainSendChainsMessage(): string {
  return `Cross-chain send currently works between these chains: ${formatChainList(ALL_CROSS_CHAIN_SEND_CHAINS)} — move USDC from any one of them to any other. Just say something like "send 10 USDC from Celo to Base" (or to someone else's address) and I'll take it from there.`;
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

  // Always shows the chain, even when a token only has balance on one —
  // pure transparency, not a disambiguation need (the send flow already
  // auto-resolves or asks with real options when a chain choice is
  // actually ambiguous). Helps build the right mental model of where funds
  // actually sit now that deposits/sends span multiple chains by default.
  const balanceLines = balances
    .map((b) => `${formatAmount(b.availableBalance)} ${b.tokenSymbol} on ${capitalize(b.chain)}`)
    .join("\n");

  return `💰 Balance:\n${balanceLines}`;
}

// Shown once a send actually reaches COMPLETE (Paycrest's payment_order.settled
// webhook, not the "processing" message initiateSend returns at submission
// time) — layout matches the user's AZZA-style reference receipt, but with
// "Sent"/"for" instead of the reference's "Buy"/"with": this is an off-ramp
// (user sends/sells crypto, receives fiat), not an on-ramp purchase, and
// "Sent" also matches the wording initiateSend's own "processing" message
// already uses for the same transaction.
export function buildSendCompletedMessage(send: Send): string {
  const netAmount = Number(send.amountHuman) - Number(send.feeAmount ?? "0");
  const fiatAmount =
    send.rate != null && Number.isFinite(Number(send.rate)) ? netAmount * Number(send.rate) : null;
  const fiatLine =
    fiatAmount != null ? `${send.fiatCurrency} ${fiatAmount.toFixed(2)}` : send.fiatCurrency;
  const { accountName, accountIdentifier, institutionName, institution } = send.recipient;
  // Last-4 masking, matching the existing convention in the receipt route
  // (routes/offramp.ts's accountIdentifierMasked) — this is the user's own
  // recipient, shown to confirm it's the right one, not a full account
  // number dump.
  const maskedAccount = `••••${accountIdentifier.slice(-4)}`;

  return [
    `✅ Your transaction with the following details has been completed:`,
    ``,
    `💲Sent ${formatAmount(send.amountHuman)} ${send.tokenSymbol} on ${send.chain.toUpperCase()} for ${fiatLine}`,
    ``,
    `To: ${accountName} — ${institutionName ?? institution} ${maskedAccount}`,
    ``,
    `Expect your funds within 1 - 5 minutes`,
  ].join("\n");
}

export function buildHelpMessage(): string {
  return [
    "Here's what I can help with right now:",
    `• "What's my balance?" — check your available balance`,
    `• "I want to deposit" — get your deposit address for a specific chain (${formatChainList(DEPOSIT_CHAINS, "or")})`,
    `• "Which chains are supported?" — see what network your deposit address runs on`,
    `• "Send $50 to a bank account in Nigeria" — send money abroad; tell me the amount, provider, and account`,
    `• "Withdraw 20 USDC to 0x... on Base" — send crypto to an external wallet address`,
    `• "I have 10 USDC on Celo but need it on Base" — move funds from one chain to a different one`,
    `• "My transactions" — see your recent activity`,
    "",
    `Need a real person? Reach us on Telegram: https://t.me/+OV3fAjsqmrtlZmY8`,
  ].join("\n");
}

export function buildTxHistoryMessage(sends: Send[], deposits: Deposit[], crossChainSends: CrossChainSend[] = []): string {
  if (sends.length === 0 && deposits.length === 0 && crossChainSends.length === 0) {
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
  const crossChainSendLines = crossChainSends.map((c) => ({
    createdAt: c.createdAt,
    text: `• Moved ${formatAmount(c.amountHuman)} ${c.tokenSymbol} ${capitalize(c.sourceChain)} → ${capitalize(c.destinationChain)} — ${describeCrossChainSendState(c.state)}`,
  }));

  const lines = [...sendLines, ...depositLines, ...crossChainSendLines]
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

function describeCrossChainSendState(state: CrossChainSendState): string {
  switch (state) {
    case "COMPLETE":
      return "delivered ✅";
    case "FAILED":
      return "failed";
    case "STUCK":
      return "needs a manual check";
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
