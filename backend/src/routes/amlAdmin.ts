import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAdminKey } from "../middleware/requireAdminKey.js";
import { listScreeningsAwaitingReview, reviewScreening } from "../domain/aml/service.js";
import { listRecipientScreeningsAwaitingReview, reviewRecipientScreening } from "../domain/aml/recipientScreening.js";

export const amlAdminRouter = Router();

// The AML review queue (KYC issue #6): screens held for review or blocked
// on a sanctions match that no admin has decided on yet, oldest first.
// Full admin key, not the metrics key — includes verified names, dates of
// birth and the raw watchlist hits.
amlAdminRouter.get("/admin/aml/reviews", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const screenings = await listScreeningsAwaitingReview();
  res.json({ screenings });
});

const ReviewSchema = z.object({
  decision: z.enum(["cleared", "blocked"]),
  // Required and non-trivial: the reason for the decision is the audit
  // record a regulator asks for, not an optional comment.
  note: z.string().trim().min(10),
});

amlAdminRouter.post("/admin/aml/reviews/:id", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = ReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "decision must be 'cleared' or 'blocked', with a note of at least 10 characters" });
    return;
  }
  try {
    const screening = await reviewScreening(req.params.id, parsed.data.decision, parsed.data.note);
    res.json({ screening });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// The RECIPIENT AML review queue (KYC issue #6 follow-up) — a held/blocked
// recipient IDENTITY, not a specific send or user (see recipientScreening.ts's
// own comment): clearing or blocking here applies to every sender who might
// reach this recipient, not just whoever's send triggered the first screen.
amlAdminRouter.get("/admin/aml/recipient-reviews", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const screenings = await listRecipientScreeningsAwaitingReview();
  res.json({ screenings });
});

amlAdminRouter.post("/admin/aml/recipient-reviews/:id", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const parsed = ReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "decision must be 'cleared' or 'blocked', with a note of at least 10 characters" });
    return;
  }
  try {
    const screening = await reviewRecipientScreening(req.params.id, parsed.data.decision, parsed.data.note);
    res.json({ screening });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
