import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth.js";
import { withTransaction } from "../db/pool.js";
import { recipientsRepo, type SavedRecipient } from "../domain/recipients/repository.js";

export const recipientsRouter = Router();

// Last 4 digits only — a saved recipient list is a repeated-exposure
// surface for account numbers in a way a one-off send draft isn't.
function toPublicRecipient(r: SavedRecipient) {
  const last4 = r.accountIdentifier.slice(-4);
  return {
    id: r.id,
    nickname: r.nickname,
    institutionName: r.institutionName,
    accountName: r.accountName,
    accountIdentifierMasked: `••••${last4}`,
    fiatCurrency: r.fiatCurrency,
    createdAt: r.createdAt,
  };
}

const SaveRecipientSchema = z.object({
  nickname: z.string().min(1).max(50),
  institution: z.string().min(1),
  institutionName: z.string().min(1),
  accountIdentifier: z.string().min(1),
  accountName: z.string().min(1),
  fiatCurrency: z.string().min(1),
});

recipientsRouter.post("/recipients", requireAuth, async (req: Request, res: Response) => {
  const parsed = SaveRecipientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const saved = await withTransaction((client) =>
      recipientsRepo.save(client, { userId: req.authUser!.id, ...parsed.data }),
    );
    res.json({ recipient: toPublicRecipient(saved) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

recipientsRouter.get("/recipients", requireAuth, async (req: Request, res: Response) => {
  const recipients = await recipientsRepo.getForUser(req.authUser!.id);
  res.json({ recipients: recipients.map(toPublicRecipient) });
});

recipientsRouter.delete("/recipients/:nickname", requireAuth, async (req: Request, res: Response) => {
  await recipientsRepo.delete(req.authUser!.id, req.params.nickname);
  res.json({ ok: true });
});
