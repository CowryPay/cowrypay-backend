import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/env.js", () => ({
  env: { dojahAppId: "app_1", dojahSecretKey: "secret_1", dojahBaseUrl: "https://dojah.test", amlMatchThreshold: 0.85 },
}));

const { decideScreening, screenIndividual } = await import("../../src/domain/aml/dojahScreening.js");

const entity = (overrides: Record<string, unknown>) => ({
  entity: { entity_id: "ent_1", risk_level: "Low", match_status: "No Match", results: [], ...overrides },
});

describe("decideScreening", () => {
  it("clears No Match", () => {
    expect(decideScreening(entity({}))).toEqual({
      status: "clear",
      matchStatus: "No Match",
      riskLevel: "Low",
      entityId: "ent_1",
    });
  });

  it("blocks a Confirmed Match on a sanctions list", () => {
    const res = entity({ match_status: "Confirmed Match", results: [{ source_type: "SANCTION", match: true }] });
    expect(decideScreening(res).status).toBe("blocked");
  });

  it("holds a Confirmed PEP match for review rather than blocking", () => {
    const res = entity({ match_status: "Confirmed Match", risk_level: "Medium", results: [{ source_type: "PEP", match: true }] });
    expect(decideScreening(res).status).toBe("review");
  });

  it.each(["Potential Match", "Partially Matched"])("holds %s for review, even with a sanctions candidate", (match_status) => {
    const res = entity({ match_status, results: [{ source_type: "SANCTION", match: true }] });
    expect(decideScreening(res).status).toBe("review");
  });

  it("holds No Match with High risk for review", () => {
    expect(decideScreening(entity({ risk_level: "High" })).status).toBe("review");
  });

  it("holds an unrecognised response shape for review instead of passing it", () => {
    expect(decideScreening({})).toEqual({ status: "review", matchStatus: null, riskLevel: null, entityId: null });
    expect(decideScreening(null).status).toBe("review");
    expect(decideScreening(entity({ match_status: "Something New" })).status).toBe("review");
  });
});

describe("screenIndividual", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the subject to Dojah's screening endpoint with AppId + secret key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(entity({})), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await screenIndividual({ name: "John Doe", dateOfBirth: "1990-01-01" }, "aml_ref_1");

    expect(result).toEqual(entity({}));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://dojah.test/api/v1/aml/v2/screening");
    expect(init.headers).toMatchObject({ AppId: "app_1", Authorization: "secret_1" });
    expect(JSON.parse(init.body)).toEqual({
      schema: "individual",
      unique_reference: "aml_ref_1",
      properties: { names: "John Doe", date_of_birth: "1990-01-01" },
      screening_options: { pep_check: true, sanction: true, adverse_media_check: true, match_threshold: 0.85 },
    });
  });

  it("throws on a non-2xx response (e.g. 402 out of wallet balance)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("insufficient balance", { status: 402 })));
    await expect(screenIndividual({ name: "John Doe" }, "aml_ref_1")).rejects.toThrow(/402/);
  });
});
