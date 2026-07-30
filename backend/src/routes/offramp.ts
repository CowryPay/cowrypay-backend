import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { getInstitutions, getOfframpRate, verifyRecipientAccount } from "../domain/offramp/paycrestAdapter.js";
import { initiateSend } from "../domain/offramp/service.js";
import { sendsRepo } from "../domain/offramp/repository.js";

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
