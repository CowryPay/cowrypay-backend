import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { getInstitutions, getOfframpRate, verifyRecipientAccount } from "../domain/offramp/paycrestAdapter.js";
import { initiateSend } from "../domain/offramp/service.js";
import { sendsRepo } from "../domain/offramp/repository.js";
import { formatAmount } from "../utils/format.js";

export const offrampRouter = Router();

const RateQuerySchema = z.object({
  network: z.string().min(1),
  token: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
  fiatCurrency: z.string().min(1),
});

// Public — Paycrest's own rate lookup needs no API key either.
offrampRouter.get("/offramp/rate", async (req: Request, res: Response) => {
  const parsed = RateQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const quote = await getOfframpRate(parsed.data);
    res.json(quote);
  } catch {
    // Paycrest's rate-preview endpoint doesn't cover every network (Celo
    // included) even when real payout liquidity exists there — not a
    // blocker, the real rate gets locked when a send is actually initiated.
    // 200, not an error, so callers don't treat a missing preview as fatal.
    res.json({
      rate: null,
      note: "A live preview isn't available for this network — you'll see the real rate when you start the send.",
    });
  }
});

// Public — same as above, no account/API key required to list institutions.
offrampRouter.get("/offramp/institutions/:currencyCode", async (req: Request, res: Response) => {
  try {
    const institutions = await getInstitutions(req.params.currencyCode);
    res.json({ institutions });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const VerifyRecipientSchema = z.object({
  institution: z.string().min(1),
  accountIdentifier: z.string().min(1),
});

offrampRouter.post("/offramp/verify-recipient", requireAuth, async (req: Request, res: Response) => {
  const parsed = VerifyRecipientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
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
});

const CreateSendSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d+)?$/, "amount must be a decimal string"),
  fiatCurrency: z.string().min(1),
  recipient: RecipientSchema,
  pin: z.string().regex(/^\d{4,6}$/, "pin must be 4-6 digits"),
  rate: z.string().optional(),
  existingOrder: ExistingOrderSchema.optional(),
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
  res.json({ send, transitions });
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

  const feeAmount = send.feeAmount ?? "0";
  const netAmount = String(Number(send.amountHuman) - Number(feeAmount));
  const fiatAmountReceived =
    send.rate != null && Number.isFinite(Number(send.rate)) ? Number(netAmount) * Number(send.rate) : null;

  const last4 = send.recipient.accountIdentifier.slice(-4);

  res.json({
    receipt: {
      reference: send.reference,
      amountSent: formatAmount(send.amountHuman),
      tokenSymbol: send.tokenSymbol,
      feeAmount: formatAmount(feeAmount),
      netAmount: formatAmount(netAmount),
      rate: send.rate,
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
