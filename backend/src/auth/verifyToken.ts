import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../config/env.js";

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  // Unix seconds the user's most recently completed login method (Supabase's
  // `amr` claim) actually happened — distinct from the token's own `iat`,
  // which gets bumped on every silent background refresh. null if the token
  // has no amr entries at all. Used to gate sensitive actions (PIN reset) on
  // a genuinely fresh login rather than just a live session.
  authTime: number | null;
}

// Supabase signs Auth tokens asymmetrically (ES256) and publishes the public
// keys at this well-known JWKS endpoint — `jose` fetches and caches them, so
// no key material has to live in our env at all, and key rotation is
// transparent. The client obtains the token by completing email-OTP
// verification directly against Supabase Auth; this backend never sends or
// checks OTP codes itself.
const jwks = createRemoteJWKSet(new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`));

interface AmrEntry {
  method: string;
  timestamp: number;
}

function latestAuthTime(amr: unknown): number | null {
  if (!Array.isArray(amr) || amr.length === 0) return null;
  // Supabase orders amr most-recent-method-first.
  const entry = amr[0] as Partial<AmrEntry> | undefined;
  return typeof entry?.timestamp === "number" ? entry.timestamp : null;
}

export async function verifySupabaseToken(token: string): Promise<AuthenticatedUser> {
  const { payload } = await jwtVerify(token, jwks);
  if (typeof payload.sub !== "string") {
    throw new Error("Token missing sub claim");
  }
  return {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    authTime: latestAuthTime(payload.amr),
  };
}
