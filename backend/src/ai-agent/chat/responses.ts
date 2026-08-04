import type { Deposit, DepositState, LedgerBalance, Send, SendState, Wallet } from "../../types.js";
import { formatAmount } from "../../utils/format.js";

export function buildWelcomeMessage(wallet: Wallet): string {
  return [
    "Welcome to CowryPay! 👋",
    "",
    "Your deposit address is:",
    `${wallet.address} (${wallet.chain})`,
    "",
    "Send USDC here anytime — I'll let you know the moment it lands, and you can check your balance whenever you like.",
    "",
    `Ask me things like "what's my balance" or say "help" to see what I can do.`,
  ].join("\n");
}

export function buildAddressMessage(wallet: Wallet): string {
  return [
    "Your CowryPay deposit address:",
    `${wallet.address} (${wallet.chain})`,
    "",
    "Send USDC here — deposits are usually credited within moments of confirming on-chain.",
  ].join("\n");
}

export function buildChainsMessage(wallet: Wallet): string {
  const chainName = wallet.chain.charAt(0).toUpperCase() + wallet.chain.slice(1);
  return `Your deposit address runs on ${chainName} — send USDC there and it'll be picked up automatically. That's the only network supported right now.`;
}

export function buildBalanceMessage(balances: LedgerBalance[]): string {
  const balanceLines = balances.length
    ? balances.map((b) => `• ${formatAmount(b.availableBalance)} ${b.tokenSymbol}`).join("\n")
    : "No balance yet — send USDC to your deposit address to get started.";

  return `💰 Balance:\n${balanceLines}`;
}

export function buildHelpMessage(): string {
  return [
    "Here's what I can help with right now:",
    `• "What's my balance?" — check your available balance`,
    `• "What's my deposit address?" — get your wallet address again`,
    `• "Which chains are supported?" — see what network your deposit address runs on`,
    `• "Send $50 to a bank account in Nigeria" — send money abroad; tell me the amount, provider, and account`,
    `• "My transactions" — see your recent activity`,
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
