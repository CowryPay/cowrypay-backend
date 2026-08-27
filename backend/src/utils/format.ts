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
// incident this closes: a cross-chain send's bridge.initiate() call
// failed with a raw NUL in its error message (seen from a malformed
// on-chain revert-reason decode), and interpolating that straight into a
// state-transition `trigger` string crashed the write meant to RECORD
// the original failure — for crossChainSend/service.ts specifically, that
// write was the catch block's own safety-net refund transaction, so the
// crash rolled the refund back too, leaving the row stuck at PENDING
// forever (debited, never refunded, invisible to every poller — none of
// them look at PENDING rows).
//
// Applied at both layers, deliberately redundant: call sites that
// construct a trigger string from an arbitrary error message sanitize it
// there (offramp/service.ts, cryptoWithdrawals/service.ts,
// crossChainSend/service.ts), AND every *Repo.logTransition sanitizes
// `trigger` again right before the INSERT — the real backstop, since none
// of those services control what a third-party API (Paycrest, Centiiv,
// Quidax, CCTP/LI.FI bridges) puts in an error string, and a future
// call site is easy to add without remembering the call-site-level
// sanitize.
export function sanitizeForDb(value: string): string {
  return value.replace(/\x00/g, "");
}
