import type { Deposit, DepositState, LedgerBalance, Send, SendState, Wallet } from "../../types.js";

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

export function buildBalanceMessage(balances: LedgerBalance[], recentDeposits: Deposit[]): string {
  const balanceLines = balances.length
    ? balances.map((b) => `• ${b.availableBalance} ${b.tokenSymbol}`).join("\n")
    : "No balance yet — send USDC to your deposit address to get started.";

  const depositLines = recentDeposits.length
    ? recentDeposits.map((d) => `• ${d.amount} ${d.tokenSymbol} — ${describeDepositState(d.state)}`).join("\n")
    : "No deposits yet.";

  return `💰 Balance:\n${balanceLines}\n\nRecent deposits:\n${depositLines}`;
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

export function buildHelpMessage(): string {
  return [
    "Here's what I can help with right now:",
    `• "What's my balance?" — check your available balance and recent deposits`,
    `• "What's my deposit address?" — get your wallet address again`,
    `• "Send $50 to a bank account in Nigeria" — send money abroad; tell me the amount, provider, and account`,
    `• "My transactions" — see your recent sends`,
  ].join("\n");
}

export function buildTxHistoryMessage(sends: Send[]): string {
  if (sends.length === 0) {
    return `No sends yet — try "send $50 to a bank account in Nigeria" to make your first one.`;
  }
  const lines = sends.map(
    (s) =>
      `• ${s.amountHuman} ${s.tokenSymbol} → ${s.recipient.accountName} (${s.fiatCurrency}) — ${describeSendState(s.state)}`,
  );
  return `📜 Recent sends:\n${lines.join("\n")}`;
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
