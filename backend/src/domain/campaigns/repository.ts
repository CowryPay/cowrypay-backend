import { pool } from "../../db/pool.js";

export const campaignsRepo = {
  async isUnsubscribed(email: string): Promise<boolean> {
    const { rows } = await pool.query(`select 1 from campaign_unsubscribes where email = $1`, [
      email.toLowerCase(),
    ]);
    return rows.length > 0;
  },

  async unsubscribe(email: string): Promise<void> {
    await pool.query(`insert into campaign_unsubscribes (email) values ($1) on conflict (email) do nothing`, [
      email.toLowerCase(),
    ]);
  },

  async wasSent(campaignKey: string, email: string): Promise<boolean> {
    const { rows } = await pool.query(
      `select 1 from campaign_sends where campaign_key = $1 and email = $2 and status = 'sent'`,
      [campaignKey, email.toLowerCase()],
    );
    return rows.length > 0;
  },

  async logSend(
    campaignKey: string,
    email: string,
    status: "sent" | "failed" | "skipped_unsubscribed",
    resendId?: string,
    error?: string,
  ): Promise<void> {
    await pool.query(
      `insert into campaign_sends (campaign_key, email, status, resend_id, error, sent_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (campaign_key, email)
       do update set status = excluded.status, resend_id = excluded.resend_id, error = excluded.error, sent_at = now()`,
      [campaignKey, email.toLowerCase(), status, resendId ?? null, error ?? null],
    );
  },
};
