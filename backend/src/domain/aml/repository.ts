import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { ScreeningStatus } from "./dojahScreening.js";

export type AmlReviewDecision = "cleared" | "blocked";

export interface AmlScreening {
  id: string;
  userId: string;
  provider: string;
  trigger: string;
  status: ScreeningStatus;
  matchStatus: string | null;
  riskLevel: string | null;
  screenedName: string | null;
  screenedDateOfBirth: string | null;
  entityId: string | null;
  response: unknown;
  error: string | null;
  reviewDecision: AmlReviewDecision | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapScreening(row: any): AmlScreening {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    trigger: row.trigger,
    status: row.status,
    matchStatus: row.match_status,
    riskLevel: row.risk_level,
    screenedName: row.screened_name,
    screenedDateOfBirth: row.screened_date_of_birth,
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

export const amlScreeningsRepo = {
  async create(
    client: PoolClient,
    input: {
      userId: string;
      provider: string;
      status: ScreeningStatus;
      matchStatus: string | null;
      riskLevel: string | null;
      screenedName: string | null;
      screenedDateOfBirth: string | null;
      entityId: string | null;
      response: unknown;
      error: string | null;
    },
  ): Promise<AmlScreening> {
    const { rows } = await client.query(
      `insert into aml_screenings
         (user_id, provider, status, match_status, risk_level, screened_name,
          screened_date_of_birth, entity_id, response, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        input.userId,
        input.provider,
        input.status,
        input.matchStatus,
        input.riskLevel,
        input.screenedName,
        input.screenedDateOfBirth,
        input.entityId,
        input.response === null ? null : JSON.stringify(input.response),
        input.error,
      ],
    );
    return mapScreening(rows[0]);
  },

  async findById(id: string): Promise<AmlScreening | null> {
    const { rows } = await pool.query(`select * from aml_screenings where id = $1`, [id]);
    return rows[0] ? mapScreening(rows[0]) : null;
  },

  // The admin review queue: held or blocked screens nobody has decided on
  // yet, oldest first — each one is a user's send waiting on a human.
  async listAwaitingReview(): Promise<AmlScreening[]> {
    const { rows } = await pool.query(
      `select * from aml_screenings
       where status in ('review', 'blocked') and review_decision is null
       order by created_at asc`,
    );
    return rows.map(mapScreening);
  },

  // Guarded on review_decision is null so two admins deciding the same
  // screen at once can't both win — the second gets null back.
  async recordReview(
    client: PoolClient,
    id: string,
    decision: AmlReviewDecision,
    note: string,
  ): Promise<AmlScreening | null> {
    const { rows } = await client.query(
      `update aml_screenings
       set review_decision = $2, review_note = $3, reviewed_at = now(), updated_at = now()
       where id = $1 and review_decision is null
       returning *`,
      [id, decision, note],
    );
    return rows[0] ? mapScreening(rows[0]) : null;
  },
};
