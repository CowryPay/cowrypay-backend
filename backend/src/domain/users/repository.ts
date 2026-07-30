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
    pinFailedAttempts: row.pin_failed_attempts,
    pinLockedUntil: row.pin_locked_until,
    biometricEnabled: row.biometric_enabled,
    passwordSet: row.password_set,
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

  // 5 consecutive failures locks PIN verification out for 15 minutes — see
  // domain/pin/service.ts. A success resets the counter and any lockout.
  async recordPinAttempt(client: PoolClient, userId: string, success: boolean): Promise<User> {
    const { rows } = success
      ? await client.query(
          `update users set pin_failed_attempts = 0, pin_locked_until = null where id = $1 returning *`,
          [userId],
        )
      : await client.query(
          `update users set
             pin_failed_attempts = pin_failed_attempts + 1,
             pin_locked_until = case
               when pin_failed_attempts + 1 >= 5 then now() + interval '15 minutes'
               else pin_locked_until
             end
           where id = $1 returning *`,
          [userId],
        );
    return mapUser(rows[0]);
  },

  async setBiometricEnabled(client: PoolClient, userId: string, enabled: boolean): Promise<User> {
    const { rows } = await client.query(
      `update users set biometric_enabled = $2 where id = $1 returning *`,
      [userId, enabled],
    );
    return mapUser(rows[0]);
  },

  async setPasswordSet(client: PoolClient, userId: string): Promise<User> {
    const { rows } = await client.query(`update users set password_set = true where id = $1 returning *`, [
      userId,
    ]);
    return mapUser(rows[0]);
  },
};
