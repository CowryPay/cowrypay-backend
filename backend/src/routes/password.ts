import { Router, type Request, type Response } from "express";
import { withTransaction } from "../db/pool.js";
import { usersRepo } from "../domain/users/repository.js";
import { toPublicUser } from "../domain/users/publicUser.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const passwordRouter = Router();

// The password itself is never sent here or stored by us — the frontend
// sets it directly against Supabase Auth (PUT /auth/v1/user with the
// user's own access token). This just records that the mandatory
// post-signup "set a password" step is done, so the frontend knows not to
// show that screen again.
passwordRouter.post("/auth/password/confirm", requireAuth, async (req: Request, res: Response) => {
  const userId = req.authUser!.id;
  const user = await withTransaction((client) => usersRepo.setPasswordSet(client, userId));
  res.json({ user: toPublicUser(user) });
});
