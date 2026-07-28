import { z } from "zod";

export const paymentActionSchema = z.enum([
  "SEND_SINGLE",
  "SPLIT_EQUAL",
  "SEND_TO_GROUP",
  /** Total USDC split across group members via CowryPay.payGroupSplit */
  "GROUP_SPLIT_TOTAL",
]);

export type PaymentAction = z.infer<typeof paymentActionSchema>;

export const adminActionSchema = z.enum([
  "REGISTER_USERNAME",
  "APPROVE_USDC",
  "CREATE_GROUP",
  "ADD_MEMBERS",
  "REMOVE_MEMBERS",
  "CANCEL_GROUP",
  "LIST_GROUPS",
  "HELP",
  "BALANCE",
  "CHAT",
]);

export type AdminAction = z.infer<typeof adminActionSchema>;

export const earnActionSchema = z.enum([
  "LIST_OPPORTUNITIES", // "show me yield vaults" / "earn yield on my USDC"
  "DEPOSIT_YIELD",      // "deposit 0.1 USDC into vault 1" / "put $50 into Morpho"
  "VIEW_POSITIONS",     // "show my yield positions" / "what am I earning"
]);

export type EarnAction = z.infer<typeof earnActionSchema>;

export const parsedIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("payment"),
    action: paymentActionSchema,
    amount: z.number().positive().optional(),
    perRecipientAmount: z.number().positive().optional(),
    recipient: z.string().optional(),
    splitCount: z.number().int().positive().optional(),
    members: z.array(z.string()).optional(),
    groupName: z.string().optional(),
    note: z.string().optional(),
    /** Token symbol the user specified ("USDm" or "USDC"). Defaults to USDC if omitted. */
    token: z.string().optional(),
  }),
  z.object({
    kind: z.literal("admin"),
    action: adminActionSchema,
    /** REGISTER_USERNAME: on-chain name (a–z, 0–9, 3–32), no @ */
    username: z.string().optional(),
    /** APPROVE_USDC: human amount to approve for CowryPay */
    amount: z.number().positive().optional(),
    /** APPROVE_USDC: token symbol — "USDm" or "USDC". Defaults to USDC if omitted. */
    token: z.string().optional(),
    groupName: z.string().optional(),
    /** ADD_MEMBERS / REMOVE_MEMBERS / CANCEL_GROUP */
    groupId: z.union([z.string(), z.number()]).optional(),
    members: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("earn"),
    action: earnActionSchema,
    /** DEPOSIT_YIELD: human USDC amount to deposit (e.g. 0.1) */
    amount: z.number().positive().optional(),
    /** DEPOSIT_YIELD: 1-based index from the displayed vault list */
    vaultIndex: z.number().int().positive().optional(),
    /** LIST_OPPORTUNITIES: minimum APY filter (e.g. 3 = ≥ 3%) */
    minApy: z.number().optional(),
    /** LIST_OPPORTUNITIES: chain name filter (e.g. "Base") */
    chainName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("unknown"),
    rawSummary: z.string(),
  }),
]);

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;

export const draftTxPlanSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("pay"),
    token: z.string(),          // ERC-20 address on Celo
    to: z.string(),
    amountHuman: z.number(),
    amountBaseUnits: z.string(),
  }),
  z.object({
    mode: z.literal("payGroupEqual"),
    token: z.string(),
    groupId: z.string(),
    amountPerMemberHuman: z.number(),
    amountPerMemberBaseUnits: z.string(),
    memberCount: z.number(),
  }),
  z.object({
    mode: z.literal("payMany"),
    token: z.string(),
    items: z.array(
      z.object({
        to: z.string(),
        amountHuman: z.number(),
        amountBaseUnits: z.string(),
      }),
    ),
  }),
  z.object({
    mode: z.literal("payGroupSplit"),
    token: z.string(),
    groupId: z.string(),
    totalHuman: z.number(),
    totalBaseUnits: z.string(),
    memberCount: z.number(),
  }),
]);

export type DraftTxPlan = z.infer<typeof draftTxPlanSchema>;

export const draftRecordSchema = z.object({
  draftId: z.string(),
  sessionId: z.string(),
  createdAt: z.number(),
  action: paymentActionSchema,
  recipients: z.array(
    z.object({
      username: z.string(),
      address: z.string(),
      amount: z.number(),
    }),
  ),
  totalAmount: z.number(),
  preview: z.string(),
  txPlan: draftTxPlanSchema,
});

export type DraftRecord = z.infer<typeof draftRecordSchema>;
