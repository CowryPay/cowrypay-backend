import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { setBiometricEnabled, setTransactionPin, verifyTransactionPin } from "../domain/pin/service.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRecentAuth } from "../middleware/requireRecentAuth.js";

export const pinRouter = Router();

const PinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, "pin must be 4-6 digits"),
});

// Setting (or resetting) the PIN requires a fresh login, not just a live
// session — see requireRecentAuth. This is the entire "forgot PIN" flow:
// re-verify email OTP, then call this with the new PIN.
pinRouter.post("/auth/pin", requireAuth, requireRecentAuth, async (req: Request, res: Response) => {
  const parsed = PinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    await setTransactionPin(req.authUser!.id, parsed.data.pin);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Used by the frontend's auto-lock/unlock screen — re-proving presence on
// an already-authenticated session, not authorizing a send.
pinRouter.post("/auth/pin/verify", requireAuth, async (req: Request, res: Response) => {
  const parsed = PinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  const valid = await verifyTransactionPin(req.authUser!.id, parsed.data.pin);
  res.json({ valid });
});

const BiometricSchema = z.object({
  enabled: z.boolean(),
});

pinRouter.post("/auth/biometric", requireAuth, requireRecentAuth, async (req: Request, res: Response) => {
  const parsed = BiometricSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    await setBiometricEnabled(req.authUser!.id, parsed.data.enabled);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
