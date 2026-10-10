import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";

// "abandoned" is distinct from "rejected" — the user never finished (no
// verdict was ever reached), vs. the vendor actively reviewed and said
// no. See KycResult.decision in adapter.ts for the full reasoning.
export type KycAttemptStatus = "pending" | "verified" | "rejected" | "abandoned";

export interface KycVerificationAttempt {
  id: string;
  userId: string;
  provider: string;
  providerReference: string | null;
  status: KycAttemptStatus;
  // Which country this attempt was verified against — audit trail for
  // which Dojah workflow it routed to (dojahAdapter.ts's
  // GOVERNMENT_DATA_COUNTRIES split). Null for rows predating this and
  // for providers that don't route by country (mock).
  country: string | null;
  // The widgetId this attempt's session was started with — persisted so a
  // reused/resumed attempt (service.ts's startKyc dedupe) can hand it back
  // without re-deriving Dojah's country routing. Null for rows predating
  // this and for providers without a widget (mock).
  widgetId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapAttempt(row: any): KycVerificationAttempt {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerReference: row.provider_reference,
    status: row.status,
    country: row.country,
    widgetId: row.widget_id,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const kycAttemptsRepo = {
  async create(
    client: PoolClient,
    input: {
      userId: string;
      provider: string;
      providerReference: string | null;
      country?: string | null;
      widgetId?: string | null;
    },
  ): Promise<KycVerificationAttempt> {
    const { rows } = await client.query(
      `insert into kyc_verification_attempts (user_id, provider, provider_reference, country, widget_id)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [input.userId, input.provider, input.providerReference, input.country ?? null, input.widgetId ?? null],
    );
    return mapAttempt(rows[0]);
  },

  async findByProviderReference(providerReference: string): Promise<KycVerificationAttempt | null> {
    const { rows } = await pool.query(
      `select * from kyc_verification_attempts where provider_reference = $1`,
      [providerReference],
    );
    return rows[0] ? mapAttempt(rows[0]) : null;
  },

  // The most recent still-open attempt for this user, if any — used by
  // startKyc to decide whether to reuse/resume it (still fresh) or
  // abandon it (stale) before starting a new one. Ordered/limited rather
  // than assuming uniqueness: historically nothing enforced "at most one
  // pending attempt per user," so this always acts on the newest.
  async findPendingForUser(userId: string): Promise<KycVerificationAttempt | null> {
    const { rows } = await pool.query(
      `select * from kyc_verification_attempts where user_id = $1 and status = 'pending'
       order by created_at desc limit 1`,
      [userId],
    );
    return rows[0] ? mapAttempt(rows[0]) : null;
  },

  // Every attempt still "pending" past the TTL cutoff, across all users —
  // the safety net for a user who closes the app entirely and never hits
  // POST /kyc/cancel. See kycPendingTtlPoller.ts.
  async findStalePending(cutoff: Date): Promise<KycVerificationAttempt[]> {
    const { rows } = await pool.query(
      `select * from kyc_verification_attempts where status = 'pending' and created_at < $1`,
      [cutoff],
    );
    return rows.map(mapAttempt);
  },

  async resolve(
    client: PoolClient,
    id: string,
    status: "verified" | "rejected" | "abandoned",
  ): Promise<KycVerificationAttempt | null> {
    const { rows } = await client.query(
      `update kyc_verification_attempts
       set status = $2, resolved_at = now(), updated_at = now()
       where id = $1 and status = 'pending'
       returning *`,
      [id, status],
    );
    return rows[0] ? mapAttempt(rows[0]) : null;
  },

  async getForUser(userId: string): Promise<KycVerificationAttempt[]> {
    const { rows } = await pool.query(
      `select * from kyc_verification_attempts where user_id = $1 order by created_at desc`,
      [userId],
    );
    return rows.map(mapAttempt);
  },
};
