import { z } from "zod";

// Scoped to what CowryPay actually does — off-ramp send via Paycrest plus
// read-only account info. No @username transfers, on-chain approvals, or
// cross-chain bridging — those belonged to the old on-chain P2P product
// this backend replaced.
export const parsedIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("remittance"),
    action: z.literal("SEND_REMITTANCE"),
    amount: z.number().optional(),
    recipientNickname: z.string().optional(),
    countryHint: z.string().optional(),
    institutionHint: z.string().optional(),
    accountIdentifier: z.string().optional(),
    // Which chain to send from, if the user named one (e.g. "via Base") —
    // only meaningful once a wallet can hold balance on more than one
    // chain; see remittanceDraft.ts's resolution logic.
    chainHint: z.string().optional(),
    // Which token to send, if the user named one (e.g. "send 20 USDT") —
    // omitted means USDC, the only token that existed before USDT support.
    tokenHint: z.string().optional(),
  }),
  z.object({
    kind: z.literal("admin"),
    action: z.enum(["BALANCE", "TX_HISTORY", "HELP", "CHAT"]),
  }),
  // Revisited from an earlier, stricter design (recognized-but-not-
  // fulfilled) once the real safety property was identified: the risk
  // isn't the LLM extracting an address from free text, it's ACTING on
  // that extraction without a human verifying it first. This intent's
  // parsed toAddress is only ever used to build a draft the user must
  // see echoed back in full and explicitly confirm — the actual transfer
  // still goes through the unchanged, PIN-gated REST endpoint
  // (routes/cryptoWithdrawals.ts), never triggered from chat directly.
  // See domain/chat/cryptoWithdrawalDraft.ts for the full flow.
  z.object({
    kind: z.literal("cryptoWithdrawal"),
    action: z.literal("WITHDRAW_TO_WALLET"),
    amount: z.number().optional(),
    toAddress: z.string().optional(),
    chainHint: z.string().optional(),
    // Which token to withdraw, if the user named one (e.g. "withdraw 20
    // USDT") — omitted means USDC, same as remittance's tokenHint.
    tokenHint: z.string().optional(),
  }),
  z.object({
    kind: z.literal("unknown"),
    rawSummary: z.string(),
  }),
]);

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;
