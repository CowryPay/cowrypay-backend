// Postgres numeric(38,18) columns come back from `pg` as full-precision
// strings (e.g. "1.000000000000000000") — trimmed here via pure string
// manipulation, not a Number() round-trip, so this never risks the kind of
// floating-point error that money elsewhere in this codebase is
// deliberately kept away from (see ledgerRepo.creditAvailable).
export function formatAmount(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}
