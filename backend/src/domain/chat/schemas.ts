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
  }),
  z.object({
    kind: z.literal("admin"),
    action: z.enum(["BALANCE", "TX_HISTORY", "HELP", "CHAT"]),
  }),
  z.object({
    kind: z.literal("unknown"),
    rawSummary: z.string(),
  }),
]);

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;
