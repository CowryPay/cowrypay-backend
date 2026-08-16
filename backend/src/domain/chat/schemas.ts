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
  }),
  z.object({
    kind: z.literal("admin"),
    action: z.enum(["BALANCE", "TX_HISTORY", "HELP", "CHAT"]),
  }),
  // Deliberately recognized-but-not-fulfilled in chat — see
  // routes/cryptoWithdrawals.ts's own comment on why sending crypto to an
  // external wallet stays REST-only: a wrong destination address here is
  // unrecoverable money loss, unlike a wrong bank detail on a remittance
  // send, and an LLM extracting an address from free text is exactly the
  // wrong place to introduce that risk. This intent exists only so chat
  // can tell such a request apart from a remittance/off-ramp send and
  // reply correctly, instead of misreading "withdraw to wallet" as
  // SEND_REMITTANCE and producing a nonsensical off-ramp error.
  z.object({
    kind: z.literal("cryptoWithdrawal"),
    action: z.literal("WITHDRAW_TO_WALLET"),
  }),
  z.object({
    kind: z.literal("unknown"),
    rawSummary: z.string(),
  }),
]);

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;
