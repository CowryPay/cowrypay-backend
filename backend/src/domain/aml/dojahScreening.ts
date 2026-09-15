import { env } from "../../config/env.js";

export interface ScreeningSubject {
  name: string;
  dateOfBirth?: string;
  nationality?: string;
}

export type ScreeningStatus = "clear" | "review" | "blocked";

export interface ScreeningDecision {
  status: ScreeningStatus;
  matchStatus: string | null;
  riskLevel: string | null;
  entityId: string | null;
}

const TIMEOUT_MS = 15_000;

function requireDojahConfig(): { appId: string; secretKey: string } {
  if (!env.dojahAppId || !env.dojahSecretKey) {
    throw new Error("DOJAH_APP_ID and DOJAH_SECRET_KEY must be set when AML_SCREENING_ENABLED=true");
  }
  return { appId: env.dojahAppId, secretKey: env.dojahSecretKey };
}

// docs.dojah.io/api-reference/aml-background/aml-screening — POST
// /api/v1/aml/v2/screening, secret key in Authorization with no "Bearer"
// prefix. Returns the raw JSON so the caller can store it verbatim for
// audit; decideScreening() derives the status from it separately.
// Throws on a non-2xx (402 = Dojah wallet out of balance) or timeout — the
// caller treats that as "couldn't screen", never as a pass.
export async function screenIndividual(subject: ScreeningSubject, uniqueReference: string): Promise<unknown> {
  const { appId, secretKey } = requireDojahConfig();

  const res = await fetch(`${env.dojahBaseUrl}/api/v1/aml/v2/screening`, {
    method: "POST",
    headers: { "content-type": "application/json", AppId: appId, Authorization: secretKey },
    body: JSON.stringify({
      schema: "individual",
      unique_reference: uniqueReference,
      properties: {
        names: subject.name,
        ...(subject.dateOfBirth ? { date_of_birth: subject.dateOfBirth } : {}),
        ...(subject.nationality ? { nationality: subject.nationality } : {}),
      },
      screening_options: {
        pep_check: true,
        sanction: true,
        adverse_media_check: true,
        match_threshold: env.amlMatchThreshold,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dojah AML screening failed (${res.status}): ${body.slice(0, 500)}`);
  }
  return res.json();
}

function isSanctionsResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const { source_type, match } = result as { source_type?: unknown; match?: unknown };
  return match !== false && typeof source_type === "string" && source_type.toLowerCase().includes("sanction");
}

// The match policy (KYC issue #6, agreed defaults):
// - Confirmed Match on a sanctions list → blocked (a legal obligation, not
//   a judgment call — an admin still records the final decision).
// - Any other Confirmed / Potential / Partial match (PEP, adverse media,
//   fuzzy name hits) → review. Never auto-blocked: common names produce
//   constant false positives, and a PEP is allowed to be a customer.
// - High risk_level with no named match → review too, rather than trust
//   the match_status alone.
// - No Match → clear.
//
// Deliberately defensive about the response shape — Dojah's own docs pages
// disagree on some field names, so anything unrecognised lands in review
// instead of silently passing.
export function decideScreening(response: unknown): ScreeningDecision {
  const entity =
    typeof response === "object" && response !== null && "entity" in response
      ? ((response as { entity: unknown }).entity as Record<string, unknown> | null)
      : null;

  const matchStatus = typeof entity?.match_status === "string" ? entity.match_status : null;
  const riskLevel = typeof entity?.risk_level === "string" ? entity.risk_level : null;
  const entityId = typeof entity?.entity_id === "string" ? entity.entity_id : null;
  const results = Array.isArray(entity?.results) ? entity.results : [];

  let status: ScreeningStatus = "review";
  if (matchStatus === "Confirmed Match" && results.some(isSanctionsResult)) {
    status = "blocked";
  } else if (matchStatus === "No Match" && riskLevel?.toLowerCase() !== "high") {
    status = "clear";
  }

  return { status, matchStatus, riskLevel, entityId };
}
