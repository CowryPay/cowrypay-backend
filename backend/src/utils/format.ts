// Postgres numeric(38,18) columns come back from `pg` as full-precision
// strings (e.g. "1.000000000000000000") — trimmed here via pure string
// manipulation, not a Number() round-trip, so this never risks the kind of
// floating-point error that money elsewhere in this codebase is
// deliberately kept away from (see ledgerRepo.creditAvailable).
export function formatAmount(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

// Postgres text columns reject a raw NUL byte outright
// ("invalid byte sequence for encoding UTF8: 0x00") — real incident this
// closes: a cross-chain send's bridge.initiate() call failed, and the
// catch block's own safety-net refund transaction tried to log that raw
// error message as a state-transition trigger. The underlying bridge
// error happened to contain a NUL byte, so the INSERT itself threw,
// which crashed the whole refund transaction (a single withTransaction)
// and rolled it back — the row was left permanently stuck at PENDING,
// debited but never refunded, invisible to every poller (none of them
// look at PENDING rows). Every *Repo.logTransition across this codebase
// interpolates raw `err.message`/`String(err)` from third-party APIs
// (Paycrest, Centiiv, Quidax, CCTP/LI.FI bridges) into `trigger` the same
// way — none of them control what an external API puts in an error
// string, so this is applied at the one shared choke-point each of those
// four logTransition implementations calls through, not case-by-case at
// every call site (easy to forget one).
export function sanitizeForPgText(value: string): string {
  return value.replace(/\u0000/g, "");
}
