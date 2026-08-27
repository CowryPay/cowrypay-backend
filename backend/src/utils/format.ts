// Postgres numeric(38,18) columns come back from `pg` as full-precision
// strings (e.g. "1.000000000000000000") — trimmed here via pure string
// manipulation, not a Number() round-trip, so this never risks the kind of
// floating-point error that money elsewhere in this codebase is
// deliberately kept away from (see ledgerRepo.creditAvailable).
export function formatAmount(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

// Postgres text columns reject a literal NUL byte (character code 0)
// outright — "invalid byte sequence for encoding UTF8: 0x00". Real
// incident this closes: a viem/RPC error's message can carry a raw NUL
// (seen from a malformed on-chain revert-reason decode), and
// interpolating that straight into a state-transition `trigger` string
// crashed the write meant to RECORD the original failure, replacing a
// useful error with a confusing, unrelated database one. Applied
// specifically where an arbitrary error message is about to be
// persisted, not at every error site — a message only ever shown in an
// HTTP JSON response doesn't need this (JSON.stringify escapes a NUL
// byte safely on its own).
export function sanitizeForDb(value: string): string {
  return value.replace(/\x00/g, "");
}
