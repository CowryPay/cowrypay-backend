/**
 * Transaction coordinator for the WhatsApp webhook flow.
 *
 * Converts a ResolvedPayment (addresses + amounts) into a single
 * on-chain TxPayload that can be signed by the user's Privy wallet.
 *
 * Single recipient  → CowryPay.pay(to, amount)
 * Multi-recipient   → Not supported in a single tx without a batch contract.
 *                     The user receives a clear error message so they can
 *                     split the payment or use on-chain group functionality.
 */
import type { ResolvedPayment, TxPayload } from "../types.js";
import { encodePay, encodePayGroupEqual } from "../chain/encodeCowryPay.js";
import { usdcBaseUnitsFromHuman } from "../chain/usdcAmount.js";

export function buildTxPayload(
  resolved: ResolvedPayment,
  token: `0x${string}`,
): TxPayload {
  if (!resolved.recipients.length) {
    throw new Error("No recipients in the resolved payment.");
  }

  if (resolved.recipients.length === 1) {
    const r = resolved.recipients[0]!;
    const call = encodePay(
      token,
      r.address as `0x${string}`,
      usdcBaseUnitsFromHuman(r.amount),
    );
    return { to: call.to, data: call.data, value: call.value };
  }

  // On-chain group payment → single payGroupEqual tx
  if (resolved.groupId !== undefined) {
    const perMember = usdcBaseUnitsFromHuman(resolved.recipients[0]!.amount);
    const call = encodePayGroupEqual(token, resolved.groupId, perMember);
    return { to: call.to, data: call.data, value: call.value };
  }

  // Named split (no on-chain group) — not supported as a single tx
  throw new Error(
    `Splitting among ${resolved.recipients.length} people requires an on-chain group. ` +
      `Create one first: "Create group <name> with @user1 @user2", ` +
      `then: "Send $X to <name> group".`,
  );
}
