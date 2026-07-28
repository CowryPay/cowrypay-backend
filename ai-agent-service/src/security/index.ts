import { db } from "../db/index.js";
import type { ResolvedPayment, SecurityResult, User } from "../types.js";

const MAX_TX_USDC     = parseInt(process.env.MAX_TX_USDC ?? "10000"); // $10,000 USDC
const WARN_THRESHOLD  = 500;  // $500 USDC — trigger extra warning
const MAX_RECIPIENTS  = 20;
const MAX_TXS_PER_MIN = 5;

interface SecurityInput {
  resolved: ResolvedPayment;
  user: User;
}

export async function securityCheck({ resolved, user }: SecurityInput): Promise<SecurityResult> {
  const { totalAmount, recipients } = resolved;

  // 1. Hard block: exceeds absolute limit
  if (totalAmount > MAX_TX_USDC) {
    return {
      blocked: true,
      reason: `Transfer of $${totalAmount.toLocaleString()} USDC exceeds the maximum of $${MAX_TX_USDC.toLocaleString()} USDC.`,
    };
  }

  // 2. Hard block: too many recipients
  if (recipients.length > MAX_RECIPIENTS) {
    return {
      blocked: true,
      reason: `Max ${MAX_RECIPIENTS} recipients per transaction.`,
    };
  }

  // 3. Hard block: zero address in recipient list
  const zeroAddr = "0x0000000000000000000000000000000000000000";
  if (recipients.some(r => r.address === zeroAddr)) {
    return { blocked: true, reason: "One or more recipient addresses are invalid." };
  }

  // 4. Hard block: velocity — too many txs in last 60 seconds
  const recentCount = await db.getTxCountLastMinute(user.phone);
  if (recentCount >= MAX_TXS_PER_MIN) {
    return {
      blocked: true,
      reason: `Slow down! You've sent ${recentCount} transactions in the last minute. Please wait a moment.`,
    };
  }

  // 5. Soft warning: large amount (still allowed but flagged in confirm message)
  if (totalAmount >= WARN_THRESHOLD) {
    return {
      blocked: false,
      warning: `⚠️ Large transfer: $${totalAmount.toLocaleString()} USDC. Please double-check before confirming.`,
    };
  }

  return { blocked: false, warning: null };
}
