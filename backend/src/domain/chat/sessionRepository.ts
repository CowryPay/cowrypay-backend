import { pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import type { RemittanceIntent } from "./remittanceDraft.js";
import type { CryptoWithdrawalIntent } from "./cryptoWithdrawalDraft.js";
import type { CrossChainSendIntent } from "./crossChainSendDraft.js";

// A session holds whichever multi-turn draft is in progress — a
// remittance send, a same-chain crypto withdrawal, or a cross-chain send
// — never more than one at once. The JSON column itself needed no
// migration to support this; only the TS type widened.
export type ChatDraftIntent = RemittanceIntent | CryptoWithdrawalIntent | CrossChainSendIntent;

// Expiry is enforced here, lazily, at read time — not by a cleanup job. An
// idle draft older than CHAT_SESSION_IDLE_MINUTES is simply treated as gone;
// it gets overwritten (or left alone) on whatever happens next, no deletion
// required for correctness.
export async function getActiveSession(userId: string): Promise<ChatDraftIntent | null> {
  const { rows } = await pool.query<{ draft: ChatDraftIntent; last_message_at: string }>(
    `select draft, last_message_at from chat_sessions where user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;

  const ageMinutes = (Date.now() - new Date(row.last_message_at).getTime()) / 60_000;
  if (ageMinutes > env.chatSessionIdleMinutes) return null;

  return row.draft;
}

export async function saveSession(userId: string, draft: ChatDraftIntent): Promise<void> {
  await pool.query(
    `insert into chat_sessions (user_id, draft, last_message_at)
     values ($1, $2, now())
     on conflict (user_id) do update set draft = excluded.draft, last_message_at = now()`,
    [userId, JSON.stringify(draft)],
  );
}

// Marks activity without changing the draft — used when the user sends an
// unrelated message (e.g. "what's my balance") while a draft is pending, so
// it doesn't expire just because they asked something else in between.
export async function touchSession(userId: string): Promise<void> {
  await pool.query(`update chat_sessions set last_message_at = now() where user_id = $1`, [userId]);
}

export async function clearSession(userId: string): Promise<void> {
  await pool.query(`delete from chat_sessions where user_id = $1`, [userId]);
}
