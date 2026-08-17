import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { getInstitutions, verifyRecipientAccount } from "../domain/offramp/paycrestAdapter.js";
import { getInstitutions as getQuidaxInstitutions } from "../domain/offramp/quidaxAdapter.js";
import { getInstitutions as getCentiivInstitutions } from "../domain/offramp/centiivAdapter.js";
import { selectOfframpProvider } from "../domain/offramp/providerSelection.js";
import { initiateSend } from "../domain/offramp/service.js";
import { sendsRepo } from "../domain/offramp/repository.js";
import { formatAmount } from "../utils/format.js";
import { buildSendCompletedMessage } from "../ai-agent/chat/responses.js";

export const offrampRouter = Router();

const RateQuerySchema = z.object({
  network: z.string().min(1),
  token: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
  fiatCurrency: z.string().min(1),
});

// Public — auto-shops between every eligible off-ramp provider (Quidax only
// eligible on Base/Solana for USDC — see providerSelection.ts) and returns
// whichever gives the user more fiat, plus which provider won so the
// caller knows which institution list (below) and `provider` value to use
// for the rest of this flow — recipient.institution is a provider-specific
// bank code, so everything downstream must stay pinned to this same
// provider (see service.ts's InitiateSendInput.provider comment).
offrampRouter.get("/offramp/rate", async (req: Request, res: Response) => {
  const parsed = RateQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const selection = await selectOfframpProvider({
      chain: parsed.data.network,
      token: parsed.data.token,
      amount: parsed.data.amount,
      fiatCurrency: parsed.data.fiatCurrency,
    });
    const rate = (Number(selection.toAmount) / Number(parsed.data.amount)).toString();
    res.json({ rate, provider: selection.provider, toAmount: selection.toAmount });
  } catch {
    // Neither provider has a live preview for this network/amount combo —
    // not a blocker, the real rate gets locked when a send is actually
    // initiated. 200, not an error, so callers don't treat a missing
    // preview as fatal.
    res.json({
      rate: null,
      note: "A live preview isn't available for this network — you'll see the real rate when you start the send.",
    });
  }
});

// Public — no account/API key required to list institutions. `?provider=`
// picks which provider's bank-code namespace to return (default paycrest,
// unchanged from before Quidax existed) — pass whichever provider
// GET /offramp/rate selected (or, for Centiiv, whichever the caller
// explicitly chose — it's never auto-selected, see providerSelection.ts),
// since the code the user picks here must match the provider the send
// actually uses.
offrampRouter.get("/offramp/institutions/:currencyCode", async (req: Request, res: Response) => {
  const provider =
    req.query.provider === "quidax" ? "quidax" : req.query.provider === "centiiv" ? "centiiv" : "paycrest";
  try {
    const institutions =
      provider === "quidax"
        ? await getQuidaxInstitutions(req.params.currencyCode)
        : provider === "centiiv"
          ? await getCentiivInstitutions() // no currency param — Centiiv's bank list is NGN-only today, see centiivAdapter.ts
          : await getInstitutions(req.params.currencyCode);
    res.json({ institutions, provider });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const VerifyRecipientSchema = z.object({
  institution: z.string().min(1),
  accountIdentifier: z.string().min(1),
  provider: z.enum(["paycrest", "quidax", "centiiv"]).optional(),
});

offrampRouter.post("/offramp/verify-recipient", requireAuth, async (req: Request, res: Response) => {
  const parsed = VerifyRecipientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  // Quidax has no name-lookup API at all. Centiiv actually DOES verify the
  // account name live — but only as part of full order creation (POST
  // /requests), not as a standalone pre-check endpoint (searched, found
  // none). Same practical gap for both: no way to preview the name before
  // committing to a send.
  if (parsed.data.provider === "quidax" || parsed.data.provider === "centiiv") {
    res.status(400).json({
      error: `${parsed.data.provider === "quidax" ? "Quidax" : "Centiiv"} doesn't support looking up an account name before sending — collect the recipient's name directly, it'll be verified when the send is confirmed.`,
    });
    return;
  }
  try {
    const account = await verifyRecipientAccount(parsed.data);
    res.json(account);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const RecipientSchema = z.object({
  institution: z.string().min(1),
  institutionName: z.string().optional(),
  accountIdentifier: z.string().min(1),
  accountName: z.string().min(1),
  memo: z.string().optional(),
});

// Carried over verbatim from a chat draft's pendingSend — reuses the rate
// and receive address it already locked instead of creating a second order.
const ExistingOrderSchema = z.object({
  orderId: z.string().min(1),
  receiveAddress: z.string().min(1),
  validUntil: z.string().min(1),
  rate: z.string().min(1),
  reference: z.string().min(1),
  feeAmount: z.string().min(1),
  treasuryAddress: z.string().min(1),
  // Which provider this chat-locked order was actually created with —
  // required now that remittanceDraft.ts can lock either provider, not
  // just Paycrest (see service.ts's LockedOrder for why this matters).
  provider: z.enum(["paycrest", "quidax", "centiiv"]),
  // Which token this order was actually quoted/created for — omitted means
  // USDC (see service.ts's LockedOrder.tokenSymbol comment).
  tokenSymbol: z.string().min(1).optional(),
});

const CreateSendSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
  fiatCurrency: z.string().min(1),
  recipient: RecipientSchema,
  pin: z.string().regex(/^\d{4,6}$/, "pin must be 4-6 digits"),
  rate: z.string().optional(),
  existingOrder: ExistingOrderSchema.optional(),
  // Which chain to send from — optional, defaults to the wallet's chain
  // (see domain/offramp/service.ts). Only meaningful once a wallet can
  // hold balance on more than one chain (Phase 7 migration plan).
  chain: z.string().optional(),
  // Which off-ramp provider to use — must match whichever provider's
  // institution list `recipient.institution` was picked from (see
  // GET /offramp/rate and GET /offramp/institutions?provider=). Omitted
  // means Paycrest, unchanged from before Quidax existed.
  provider: z.enum(["paycrest", "quidax", "centiiv"]).optional(),
  // Which token to send — omitted means USDC, unchanged from before USDT
  // support existed.
  tokenSymbol: z.string().min(1).optional(),
});

offrampRouter.post("/offramp/sends", requireAuth, async (req: Request, res: Response) => {
  const parsed = CreateSendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const result = await initiateSend(req.authUser!.id, parsed.data);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

offrampRouter.get("/offramp/sends/:id", requireAuth, async (req: Request, res: Response) => {
  const send = await sendsRepo.findById(req.params.id);
  if (!send || send.userId !== req.authUser!.id) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const transitions = await sendsRepo.getTransitions(send.id);
  // Only present once the send has actually settled — same "don't claim
  // done before it's done" stance as initiateSend's own "processing"
  // message (see domain/offramp/service.ts's InitiatedSend doc comment).
  const message = send.state === "COMPLETE" ? buildSendCompletedMessage(send) : undefined;
  res.json({ send, transitions, message });
});

offrampRouter.get("/offramp/sends", requireAuth, async (req: Request, res: Response) => {
  const sends = await sendsRepo.getForUser(req.authUser!.id);
  res.json({ sends });
});

// Data only, not a rendered file (Option B — see the send-a-receipt
// discussion) — the frontend shapes this into whatever it actually needs
// (in-app view, share text, a client-side PDF), instead of the backend
// taking on PDF rendering as a concern of its own. Scoped to COMPLETE sends
// only — a receipt for money that hasn't actually moved yet isn't a receipt.
offrampRouter.get("/offramp/sends/:id/receipt", requireAuth, async (req: Request, res: Response) => {
  const send = await sendsRepo.findById(req.params.id);
  if (!send || send.userId !== req.authUser!.id) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (send.state !== "COMPLETE") {
    res.status(400).json({ error: "receipt is only available once a send has completed" });
    return;
  }

  const transitions = await sendsRepo.getTransitions(send.id);
  const completedAt = transitions.find((t) => t.toState === "COMPLETE")?.createdAt ?? send.updatedAt;

  // Net amount (after platform fee) is only used internally here to compute
  // what the recipient actually received.
  const netAmount = Number(send.amountHuman) - Number(send.feeAmount ?? "0");
  const fiatAmountReceived =
    send.rate != null && Number.isFinite(Number(send.rate)) ? netAmount * Number(send.rate) : null;

  const last4 = send.recipient.accountIdentifier.slice(-4);

  res.json({
    receipt: {
      reference: send.reference,
      amountSent: formatAmount(send.amountHuman),
      feeAmount: formatAmount(send.feeAmount ?? "0"),
      tokenSymbol: send.tokenSymbol,
      chain: send.chain,
      fiatCurrency: send.fiatCurrency,
      fiatAmountReceived: fiatAmountReceived != null ? fiatAmountReceived.toFixed(2) : null,
      recipient: {
        accountName: send.recipient.accountName,
        accountIdentifierMasked: `••••${last4}`,
        institutionName: send.recipient.institutionName ?? send.recipient.institution,
      },
      status: send.state,
      createdAt: send.createdAt,
      completedAt,
      withdrawTxHash: send.withdrawTxHash,
    },
  });
});
