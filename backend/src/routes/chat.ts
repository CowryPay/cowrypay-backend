import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getWelcomeReply, handleChatMessage } from "../domain/chat/service.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const chatRouter = Router();

// Deterministic, always the same shape for a given wallet — the frontend
// calls this once right after signup completes to show the first message.
chatRouter.get("/chat/welcome", requireAuth, async (req: Request, res: Response) => {
  try {
    const reply = await getWelcomeReply(req.authUser!.id);
    res.json({ reply });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const ChatSchema = z.object({ message: z.string().min(1) });

chatRouter.post("/chat", requireAuth, async (req: Request, res: Response) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return;
  }
  try {
    const result = await handleChatMessage(req.authUser!.id, parsed.data.message);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
