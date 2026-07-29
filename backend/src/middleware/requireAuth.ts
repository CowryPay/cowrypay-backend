import type { NextFunction, Request, Response } from "express";
import { verifySupabaseToken, type AuthenticatedUser } from "../auth/verifyToken.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  try {
    req.authUser = await verifySupabaseToken(token);
    next();
  } catch {
    res.status(401).json({ error: "invalid or expired token" });
  }
}
