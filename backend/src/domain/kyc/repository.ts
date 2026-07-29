import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";

export type KycAttemptStatus = "pending" | "verified" | "rejected";

export interface KycVerificationAttempt {
  id: string;
  userId: string;
  provider: string;
  providerReference: string | null;
  status: KycAttemptStatus;
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
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const kycAttemptsRepo = {
  async create(
    client: PoolClient,
    input: { userId: string; provider: string; providerReference: string | null },
  ): Promise<KycVerificationAttempt> {
    const { rows } = await client.query(
      `insert into kyc_verification_attempts (user_id, provider, provider_reference)
       values ($1, $2, $3)
       returning *`,
      [input.userId, input.provider, input.providerReference],
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

  async resolve(
    client: PoolClient,
    id: string,
    status: "verified" | "rejected",
  ): Promise<KycVerificationAttempt> {
    const { rows } = await client.query(
      `update kyc_verification_attempts
       set status = $2, resolved_at = now(), updated_at = now()
       where id = $1
       returning *`,
      [id, status],
    );
    return mapAttempt(rows[0]);
  },

  async getForUser(userId: string): Promise<KycVerificationAttempt[]> {
    const { rows } = await pool.query(
      `select * from kyc_verification_attempts where user_id = $1 order by created_at desc`,
      [userId],
    );
    return rows.map(mapAttempt);
  },
};
