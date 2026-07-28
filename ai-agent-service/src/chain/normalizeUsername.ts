/** Match UsernameRegistry rules: 3–32 chars, a–z and 0–9 only; no @ on-chain. */
export function normalizeUsernameForRegistry(
  raw: string,
):
  | { ok: true; name: string }
  | { ok: false; reason: string } {
  const s = raw.replace(/^@/, "").trim().toLowerCase();
  if (!/^[a-z0-9]{3,32}$/.test(s)) {
    return {
      ok: false,
      reason:
        "Usernames must be 3–32 characters: lowercase letters and numbers only. Strip @ before resolving.",
    };
  }
  return { ok: true, name: s };
}
