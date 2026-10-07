import { describe, expect, it } from "vitest";
import type { Finding, LayerResult } from "../../src/model/finding.js";
import { evaluateGate, getLayerVerdict, type InactiveLayer } from "../../src/model/gate.js";
import { createFinding } from "../helpers/stub-layer.js";

const ran = (findings: Finding[]): LayerResult => ({
  layer: "stub",
  status: "ran",
  findings,
  notes: [],
});
const strict = { failOn: "breaking" as const, allowIncomplete: false };

describe("evaluateGate", () => {
  it("passes when there are no findings", () => {
    expect(evaluateGate([ran([])], strict)).toEqual({ passed: true, exitCode: 0, reasons: [] });
  });

  it("fails on a breaking finding at fail-on breaking", () => {
    const gate = evaluateGate([ran([createFinding("breaking")])], strict);
    expect(gate).toEqual({
      passed: false,
      exitCode: 1,
      reasons: ["stub: 1 finding(s) at or above breaking"],
    });
  });

  it("passes on needs-action at fail-on breaking and fails at fail-on needs-action", () => {
    const results = [ran([createFinding("needs-action")])];
    expect(evaluateGate(results, strict).passed).toBe(true);
    expect(evaluateGate(results, { ...strict, failOn: "needs-action" }).passed).toBe(false);
  });

  it("ignores accepted findings", () => {
    const results = [ran([createFinding("breaking", { accepted: { reason: "reviewed" } })])];
    expect(evaluateGate(results, strict).passed).toBe(true);
  });

  it("ignores findings with fail-on never", () => {
    expect(evaluateGate([ran([createFinding("breaking")])], { ...strict, failOn: "never" }).passed).toBe(
      true,
    );
  });

  it("fails on a skipped or failed layer unless incomplete checks are allowed", () => {
    const skipped: LayerResult = { layer: "openapi", status: "skipped", reason: "no oasdiff" };
    const failed: LayerResult = { layer: "seed", status: "failed", error: "boom", findings: [], notes: [] };
    expect(evaluateGate([skipped], { ...strict, failOn: "never" })).toEqual({
      passed: false,
      exitCode: 1,
      reasons: ["openapi: layer skipped, so the check is incomplete"],
    });
    expect(evaluateGate([failed], strict).reasons).toEqual([
      "seed: layer failed, so the check is incomplete",
    ]);
    expect(evaluateGate([skipped, failed], { ...strict, allowIncomplete: true }).passed).toBe(true);
  });

  it("counts findings of a failed layer even when incomplete checks are allowed", () => {
    const partial: LayerResult = {
      layer: "openapi",
      status: "failed",
      error: 'API "other": spec missing',
      findings: [createFinding("breaking")],
      notes: [],
    };
    expect(evaluateGate([partial], { ...strict, allowIncomplete: true })).toEqual({
      passed: false,
      exitCode: 1,
      reasons: ["openapi: 1 finding(s) at or above breaking"],
    });
  });
});

describe("evaluateGate with layers that did not run", () => {
  const inactive: InactiveLayer[] = [
    { layer: "openapi", status: "disabled" },
    { layer: "behaviour", status: "not-configured" },
  ];

  it("passes when layers are disabled or not configured and none is required", () => {
    expect(evaluateGate([ran([])], strict, inactive)).toEqual({ passed: true, exitCode: 0, reasons: [] });
  });

  it("fails on a required layer that is disabled or not configured", () => {
    const gate = evaluateGate([ran([])], { ...strict, required: ["openapi", "behaviour"] }, inactive);
    expect(gate).toEqual({
      passed: false,
      exitCode: 1,
      reasons: [
        "openapi: layer disabled, but --require names it",
        "behaviour: layer not configured, but --require names it",
      ],
    });
  });

  it("fails on a required layer that was skipped or failed even when incomplete checks are allowed", () => {
    const results: LayerResult[] = [
      { layer: "stub", status: "skipped", reason: "no spec" },
      { layer: "other", status: "failed", error: "boom", findings: [], notes: [] },
      { layer: "free", status: "skipped", reason: "nothing to read" },
    ];
    const gate = evaluateGate(results, { ...strict, allowIncomplete: true, required: ["stub", "other"] });
    expect(gate.reasons).toEqual([
      "stub: layer skipped, but --require names it",
      "other: layer failed, but --require names it",
    ]);
  });

  it("passes when a required layer ran", () => {
    expect(evaluateGate([ran([])], { ...strict, required: ["stub"] }, inactive).passed).toBe(true);
  });
});

describe("getLayerVerdict", () => {
  it("returns the highest non-accepted class", () => {
    const result = ran([
      createFinding("safe"),
      createFinding("rollback-risk"),
      createFinding("breaking", { accepted: { reason: "ok" } }),
    ]);
    expect(getLayerVerdict(result)).toBe("rollback-risk");
  });

  it("returns no-findings, skipped or failed", () => {
    expect(getLayerVerdict(ran([]))).toBe("no-findings");
    expect(getLayerVerdict({ layer: "x", status: "skipped", reason: "r" })).toBe("skipped");
    expect(getLayerVerdict({ layer: "x", status: "failed", error: "e", findings: [], notes: [] })).toBe(
      "failed",
    );
  });
});
