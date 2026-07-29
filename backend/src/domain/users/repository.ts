import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { KycStatus, User } from "../../types.js";

function mapUser(row: any): User {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    kycStatus: row.kyc_status,
    kycReference: row.kyc_reference,
    pinHash: row.pin_hash,
    biometricEnabled: row.biometric_enabled,
    createdAt: row.created_at,
  };
}

export const usersRepo = {
  async findById(id: string): Promise<User | null> {
    const { rows } = await pool.query(`select * from users where id = $1`, [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  },

  async create(
    client: PoolClient,
    input: { id: string; email: string | null; phone: string | null },
  ): Promise<User> {
    const { rows } = await client.query(
      `insert into users (id, email, phone) values ($1, $2, $3) returning *`,
      [input.id, input.email, input.phone],
    );
    return mapUser(rows[0]);
  },

  async updateKycStatus(
    client: PoolClient,
    userId: string,
    kycStatus: KycStatus,
    kycReference: string | null,
  ): Promise<User> {
    const { rows } = await client.query(
      `update users set kyc_status = $2, kyc_reference = $3 where id = $1 returning *`,
      [userId, kycStatus, kycReference],
    );
    return mapUser(rows[0]);
  },

  async setPinHash(client: PoolClient, userId: string, pinHash: string): Promise<User> {
    const { rows } = await client.query(`update users set pin_hash = $2 where id = $1 returning *`, [
      userId,
      pinHash,
    ]);
    return mapUser(rows[0]);
  },

  async setBiometricEnabled(client: PoolClient, userId: string, enabled: boolean): Promise<User> {
    const { rows } = await client.query(
      `update users set biometric_enabled = $2 where id = $1 returning *`,
      [userId, enabled],
    );
    return mapUser(rows[0]);
  },
};
