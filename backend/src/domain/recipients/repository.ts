import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import { decryptAccountIdentifier, encryptAccountIdentifier } from "./encryption.js";

export interface SavedRecipient {
  id: string;
  userId: string;
  nickname: string;
  institution: string;
  institutionName: string;
  accountIdentifier: string; // decrypted — internal use only, never returned raw over the API
  accountName: string;
  fiatCurrency: string;
  createdAt: string;
}

function normalizeAccountIdentifier(accountIdentifier: string): string {
  return accountIdentifier.replace(/\s+/g, "").toUpperCase();
}

function mapRow(row: any): SavedRecipient {
  return {
    id: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    institution: row.institution,
    institutionName: row.institution_name,
    accountIdentifier: decryptAccountIdentifier(row.account_identifier_encrypted),
    accountName: row.account_name,
    fiatCurrency: row.fiat_currency,
    createdAt: row.created_at,
  };
}

export const recipientsRepo = {
  async findByNickname(userId: string, nickname: string): Promise<SavedRecipient | null> {
    const { rows } = await pool.query(
      `select * from recipients where user_id = $1 and nickname = $2`,
      [userId, nickname.trim().toLowerCase()],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async getForUser(userId: string): Promise<SavedRecipient[]> {
    const { rows } = await pool.query(`select * from recipients where user_id = $1 order by created_at desc`, [
      userId,
    ]);
    return rows.map(mapRow);
  },

  // account_identifier_encrypted can't be searched by SQL equality — AES-GCM
  // uses a random IV per encryption, so the same plaintext never produces
  // the same ciphertext twice. Decrypts and compares in memory instead;
  // fine at this scale (a handful of saved recipients per user at most).
  // Used to recognize "this exact account is already saved" even when the
  // user re-enters it fresh instead of referencing it by nickname — without
  // this, the caller has no way to tell the frontend not to prompt to save
  // an already-saved recipient again.
  //
  // Compared normalized (trim + strip whitespace + case-fold), not raw —
  // account_identifier here comes from free-text LLM extraction each time
  // (schemas.ts's bare z.string()), so "0123456789" entered a second time
  // with a stray space or different case would otherwise silently miss and
  // re-prompt the user to save a recipient they already saved.
  async findByAccountIdentifier(
    userId: string,
    institution: string,
    accountIdentifier: string,
  ): Promise<SavedRecipient | null> {
    const all = await recipientsRepo.getForUser(userId);
    const target = normalizeAccountIdentifier(accountIdentifier);
    return (
      all.find(
        (r) => r.institution === institution && normalizeAccountIdentifier(r.accountIdentifier) === target,
      ) ?? null
    );
  },

  // Upsert on (user_id, nickname) — re-saving "mom" with new details just
  // updates the existing record rather than erroring or duplicating.
  async save(
    client: PoolClient,
    input: {
      userId: string;
      nickname: string;
      institution: string;
      institutionName: string;
      accountIdentifier: string;
      accountName: string;
      fiatCurrency: string;
    },
  ): Promise<SavedRecipient> {
    const encrypted = encryptAccountIdentifier(input.accountIdentifier);
    const { rows } = await client.query(
      `insert into recipients (user_id, nickname, institution, institution_name, account_identifier_encrypted, account_name, fiat_currency)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id, nickname) do update set
         institution = excluded.institution,
         institution_name = excluded.institution_name,
         account_identifier_encrypted = excluded.account_identifier_encrypted,
         account_name = excluded.account_name,
         fiat_currency = excluded.fiat_currency
       returning *`,
      [
        input.userId,
        input.nickname.trim().toLowerCase(),
        input.institution,
        input.institutionName,
        encrypted,
        input.accountName,
        input.fiatCurrency,
      ],
    );
    return mapRow(rows[0]);
  },

  async delete(userId: string, nickname: string): Promise<void> {
    await pool.query(`delete from recipients where user_id = $1 and nickname = $2`, [
      userId,
      nickname.trim().toLowerCase(),
    ]);
  },
};
