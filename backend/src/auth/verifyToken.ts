import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../config/env.js";

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

// Supabase signs Auth tokens asymmetrically (ES256) and publishes the public
// keys at this well-known JWKS endpoint — `jose` fetches and caches them, so
// no key material has to live in our env at all, and key rotation is
// transparent. The client obtains the token by completing email-OTP
// verification directly against Supabase Auth; this backend never sends or
// checks OTP codes itself.
const jwks = createRemoteJWKSet(new URL(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`));

export async function verifySupabaseToken(token: string): Promise<AuthenticatedUser> {
  const { payload } = await jwtVerify(token, jwks);
  if (typeof payload.sub !== "string") {
    throw new Error("Token missing sub claim");
  }
  return {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
  };
}
