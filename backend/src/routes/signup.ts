import { Router, type Request, type Response } from "express";
import { ensureAccount } from "../domain/users/service.js";
import { toPublicUser } from "../domain/users/publicUser.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const signupRouter = Router();

// Client completes email-OTP verification against Supabase Auth directly,
// then calls this with the resulting access token — no email/phone in the
// body, identity comes entirely from the verified token.
signupRouter.post("/signup", requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await ensureAccount(req.authUser!);
    res.status(result.created ? 201 : 200).json({ ...result, user: toPublicUser(result.user) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
