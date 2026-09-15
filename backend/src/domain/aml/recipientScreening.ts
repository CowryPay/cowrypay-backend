import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { screenIndividual, decideScreening, type ScreeningStatus } from "./dojahScreening.js";

export type RecipientReviewDecision = "cleared" | "blocked";

export interface RecipientScreening {
  id: string;
  fingerprint: string;
  accountName: string;
  accountIdentifier: string;
  fiatCurrency: string;
  provider: string;
  status: ScreeningStatus;
  matchStatus: string | null;
  riskLevel: string | null;
  entityId: string | null;
  response: unknown;
  error: string | null;
  reviewDecision: RecipientReviewDecision | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapScreening(row: any): RecipientScreening {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    accountName: row.account_name,
    accountIdentifier: row.account_identifier,
    fiatCurrency: row.fiat_currency,
    provider: row.provider,
    status: row.status,
    matchStatus: row.match_status,
    riskLevel: row.risk_level,
    entityId: row.entity_id,
    response: row.response,
    error: row.error,
    reviewDecision: row.review_decision,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Identifies a recipient across ANY send/sender that reaches them, not one
// specific Send — deliberately excludes `institution` (a provider-specific
// bank code; Paycrest/Quidax/Centiiv use different code namespaces for the
// same real bank, which would fragment one real-world account into
// multiple fingerprints depending on which provider happened to win the
// rate that time). Includes the normalized name, not just the account
// number, so a name change on the same account — a real fraud signal, not
// noise — triggers a fresh screen instead of silently reusing a stale
// verdict for a different person.
export function computeFingerprint(
  recipient: { accountName: string; accountIdentifier: string },
  fiatCurrency: string,
): string {
  const normalizedName = recipient.accountName.trim().toLowerCase().replace(/\s+/g, " ");
  const key = `${recipient.accountIdentifier.trim()}|${fiatCurrency.trim().toUpperCase()}|${normalizedName}`;
  return createHash("sha256").update(key).digest("hex");
}

async function findByFingerprint(fingerprint: string): Promise<RecipientScreening | null> {
  const { rows } = await pool.query(`select * from recipient_screenings where fingerprint = $1`, [fingerprint]);
  return rows[0] ? mapScreening(rows[0]) : null;
}

async function create(
  input: {
    fingerprint: string;
    accountName: string;
    accountIdentifier: string;
    fiatCurrency: string;
    status: ScreeningStatus;
    matchStatus: string | null;
    riskLevel: string | null;
    entityId: string | null;
    response: unknown;
    error: string | null;
  },
): Promise<RecipientScreening> {
  const { rows } = await pool.query(
    `insert into recipient_screenings
       (fingerprint, account_name, account_identifier, fiat_currency, provider,
        status, match_status, risk_level, entity_id, response, error)
     values ($1, $2, $3, $4, 'dojah', $5, $6, $7, $8, $9, $10)
     on conflict (fingerprint) do nothing
     returning *`,
    [
      input.fingerprint,
      input.accountName,
      input.accountIdentifier,
      input.fiatCurrency,
      input.status,
      input.matchStatus,
      input.riskLevel,
      input.entityId,
      input.response === null ? null : JSON.stringify(input.response),
      input.error,
    ],
  );
  // A concurrent first-screen for the same recipient can race here (two
  // sends to a brand-new recipient at once) — the unique fingerprint index
  // makes the loser's insert a no-op (`on conflict do nothing`, no row
  // returned) rather than an error; re-read whatever the winner stored so
  // both callers see the same, single verdict instead of one throwing.
  if (rows[0]) return mapScreening(rows[0]);
  const existing = await findByFingerprint(input.fingerprint);
  if (!existing) throw new Error(`recipient_screenings insert raced but no row found for fingerprint ${input.fingerprint}`);
  return existing;
}

export interface RecipientScreeningResult {
  status: ScreeningStatus;
}

// The gate: cache-or-screen, called from both initiateSend (the real
// enforcement point) and finalizeRemittanceDraft (earlier, for chat UX) —
// cheap after the first call for a given recipient, since only a brand-new
// fingerprint ever reaches the real (billed) Dojah call below.
export async function screenRecipient(
  recipient: { accountName: string; accountIdentifier: string },
  fiatCurrency: string,
): Promise<RecipientScreeningResult> {
  const fingerprint = computeFingerprint(recipient, fiatCurrency);
  const existing = await findByFingerprint(fingerprint);
  if (existing) return { status: existing.status };

  if (!env.amlRecipientScreeningEnabled) {
    return { status: "clear" };
  }

  try {
    const response = await screenIndividual({ name: recipient.accountName }, `recipient_${randomUUID()}`);
    const decision = decideScreening(response);
    const stored = await create({
      fingerprint,
      accountName: recipient.accountName,
      accountIdentifier: recipient.accountIdentifier,
      fiatCurrency,
      status: decision.status,
      matchStatus: decision.matchStatus,
      riskLevel: decision.riskLevel,
      entityId: decision.entityId,
      response,
      error: null,
    });
    return { status: stored.status };
  } catch (err) {
    // Fails closed, same as runAmlScreening (KYC issue #6) — a Dojah error/
    // timeout/402 lands in "review", never a silent pass.
    const stored = await create({
      fingerprint,
      accountName: recipient.accountName,
      accountIdentifier: recipient.accountIdentifier,
      fiatCurrency,
      status: "review",
      matchStatus: null,
      riskLevel: null,
      entityId: null,
      response: null,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: stored.status };
  }
}

// The admin review queue: held or blocked recipient identities nobody has
// decided on yet, oldest first.
export function listRecipientScreeningsAwaitingReview(): Promise<RecipientScreening[]> {
  return pool
    .query(
      `select * from recipient_screenings
       where status in ('review', 'blocked') and review_decision is null
       order by created_at asc`,
    )
    .then(({ rows }) => rows.map(mapScreening));
}

// An admin's final call on a held or blocked recipient identity — applies
// to every sender who might reach this recipient, not just whoever
// triggered the first screen. No user/send table touched at all: clearing
// or blocking a recipient is purely a cache update, since nothing about
// any specific send was ever debited/created while it was held (see the
// plan doc's own reasoning for why this design avoids needing to "resume"
// anything).
export async function reviewRecipientScreening(
  id: string,
  decision: RecipientReviewDecision,
  note: string,
): Promise<RecipientScreening> {
  const screening = await pool.query(`select * from recipient_screenings where id = $1`, [id]).then(({ rows }) => rows[0]);
  if (!screening) throw new Error("Recipient screening not found");
  if (screening.status === "clear") throw new Error("Recipient screening is clear — nothing to review");
  if (screening.review_decision) throw new Error(`Recipient screening ${id} is already reviewed (${screening.review_decision})`);

  return withTransaction(async (client: PoolClient) => {
    const { rows } = await client.query(
      `update recipient_screenings
       set review_decision = $2, review_note = $3, reviewed_at = now(), updated_at = now()
       where id = $1 and review_decision is null
       returning *`,
      [id, decision, note],
    );
    if (!rows[0]) throw new Error(`Recipient screening ${id} is already reviewed`);
    return mapScreening(rows[0]);
  });
}
