import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { env } from "../../config/env.js";

// Helius's "Enhanced" webhooks (the leading vendor candidate — see the
// Solana integration plan) authenticate with a static shared secret sent
// back verbatim as the Authorization header on every POST, set once at
// webhook-creation time via the `authHeader` field — not an HMAC-over-body
// scheme like Blockradar/Paycrest use. Isolated in its own function so
// swapping providers later only touches this one place.
//
// Constant-time comparison — every other webhook verifier in this codebase
// (Blockradar, Paycrest) already avoids a plain === here; this one didn't,
// leaking timing information per matching byte of the shared secret.
export function verifySolanaWebhookAuth(req: Request): boolean {
  if (!env.solanaWebhookSecret) return false;
  const provided = req.header("authorization");
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(env.solanaWebhookSecret);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export interface NormalizedSolanaTransfer {
  signature: string;
  ownerAddress: string;
  ataAddress: string;
  mint: string;
  amount: string;
}

// Thin, provider-agnostic normalization layer — the route handler only
// depends on this shape, not on Helius's exact JSON. Field names here
// (tokenTransfers[].{toUserAccount,toTokenAccount,mint,tokenAmount}) are
// Helius's real documented Enhanced-transaction shape, cross-checked
// against multiple current doc pages this session — but the exact
// human-readable-vs-raw-base-units shape of `tokenAmount` on the *webhook*
// payload specifically (as opposed to their separate Enhanced Transactions
// history API) was not fully confirmable without a live account. Treated
// here as already human-readable (matching every other chain's ingestDeposit
// amount format) — MUST be verified against one real captured webhook
// delivery before this goes live, same discipline the Paycrest webhook
// secret situation already established: don't trust docs blindly forever,
// confirm against real data.
export function normalizeHeliusPayload(body: unknown): NormalizedSolanaTransfer[] {
  if (!Array.isArray(body)) return [];
  const out: NormalizedSolanaTransfer[] = [];
  for (const tx of body) {
    const signature = tx?.signature;
    const transfers = tx?.tokenTransfers;
    if (typeof signature !== "string" || !Array.isArray(transfers)) continue;
    for (const t of transfers) {
      if (
        typeof t?.toUserAccount === "string" &&
        typeof t?.toTokenAccount === "string" &&
        typeof t?.mint === "string" &&
        t?.tokenAmount != null
      ) {
        out.push({
          signature,
          ownerAddress: t.toUserAccount,
          ataAddress: t.toTokenAccount,
          mint: t.mint,
          amount: String(t.tokenAmount),
        });
      }
    }
  }
  return out;
}
