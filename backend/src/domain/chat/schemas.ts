import { z } from "zod";

// Scoped to what CowryPay actually does — off-ramp send via Paycrest,
// same-chain crypto withdrawal, cross-chain send, plus read-only account
// info. No @username transfers or on-chain approvals — those belonged to
// the old on-chain P2P product this backend replaced. Cross-chain
// bridging, unlike that old product's version, is a deliberate feature
// here (domain/crossChainSend/), not something excluded.
export const parsedIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("remittance"),
    action: z.literal("SEND_REMITTANCE"),
    // Exactly one of amount/fiatAmount is ever meaningful for a given
    // message — amount when the user names a crypto-ish figure ("$50",
    // "20 USDC"), fiatAmount when they name a local-currency figure they
    // want the RECIPIENT to end up with ("₦50,000", "50000 naira"). See
    // remittanceDraft.ts's resolveFiatAmountToCrypto for how fiatAmount
    // gets converted — needs a resolved fiatCurrency (from countryHint or
    // a saved recipient) before it can, so it's held as-is until then,
    // same as every other field here.
    amount: z.number().optional(),
    fiatAmount: z.number().optional(),
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
  // Read-only rate lookup — no draft, no session, nothing to confirm.
  // See domain/chat/rateQuery.ts.
  z.object({
    kind: z.literal("rate"),
    action: z.literal("CHECK_RATE"),
    fiatCurrency: z.string().optional(),
    tokenHint: z.string().optional(),
    chainHint: z.string().optional(),
    // An amount to quote at, if named ("rate for 50 USDC to NGN") — a
    // provider's per-unit rate can shift slightly with size (fee floors,
    // liquidity), so quoting at the user's own real amount beats always
    // showing a fixed benchmark figure when they gave one.
    amount: z.number().optional(),
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
  // Same §9 boundary as cryptoWithdrawal above — a parsed toAddress here
  // is only ever a draft the user must see and explicitly confirm before
  // the real, PIN-gated POST /cross-chain-sends endpoint is called; chat
  // never calls it directly. See domain/chat/crossChainSendDraft.ts.
  // Distinct from cryptoWithdrawal specifically because the destination
  // is a DIFFERENT chain than the source (a same-chain "withdraw to
  // wallet" is cryptoWithdrawal; two distinct chains named is this).
  z.object({
    kind: z.literal("crossChainSend"),
    action: z.literal("SEND_CROSS_CHAIN"),
    amount: z.number().optional(),
    toAddress: z.string().optional(),
    // Which chain the user's funds currently sit on.
    sourceChainHint: z.string().optional(),
    // Which chain the funds should end up on — the whole point of this
    // intent kind versus cryptoWithdrawal is that this differs from
    // sourceChainHint.
    destinationChainHint: z.string().optional(),
    tokenHint: z.string().optional(),
  }),
  // CowryPay-to-CowryPay transfer, identified by the recipient's memo, not
  // an address — see domain/internalTransfers/service.ts's own comment for
  // the real incident this exists to prevent. Same §9 boundary as every
  // other fund-moving intent above: chat only ever builds a draft
  // (domain/chat/internalTransferDraft.ts), the real transfer goes through
  // the PIN-gated POST /internal-transfers/stellar endpoint. Stellar-only
  // for now — every other chain already gives each user their own real
  // address, so a normal cryptoWithdrawal already works correctly for
  // "send to another CowryPay user" there.
  z.object({
    kind: z.literal("internalTransfer"),
    action: z.literal("SEND_TO_COWRYPAY_USER"),
    amount: z.number().optional(),
    recipientMemoId: z.string().optional(),
    tokenHint: z.string().optional(),
  }),
  z.object({
    kind: z.literal("unknown"),
    rawSummary: z.string(),
  }),
]);

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;
