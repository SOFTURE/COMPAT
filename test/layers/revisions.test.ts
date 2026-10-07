import { describe, expect, it } from "vitest";
import { applyRevisions, splitOutput } from "../../src/layers/revisions.js";
import type { LayerResult } from "../../src/model/finding.js";
import { createFinding } from "../helpers/stub-layer.js";

const finding = createFinding("breaking", { layer: "openapi" });
const results: LayerResult[] = [
  {
    layer: "openapi",
    status: "ran",
    findings: [finding, createFinding("needs-action", { layer: "openapi" })],
    notes: [],
  },
  { layer: "seed", status: "skipped", reason: "no seeds" },
];

describe("applyRevisions", () => {
  it("replaces the revised finding and leaves the input untouched", () => {
    const revised = applyRevisions(results, [
      { layer: "openapi", index: 0, finding: { ...finding, class: "safe" } },
    ]);
    expect(
      revised.ok && revised.value[0]?.status === "ran" && revised.value[0].findings.map((item) => item.class),
    ).toEqual(["safe", "needs-action"]);
    expect(results[0]?.status === "ran" && results[0].findings[0]?.class).toBe("breaking");
  });

  it.each([
    [
      { layer: "missing", index: 0, finding },
      "revision of missing finding #0: no earlier layer with findings has that name",
    ],
    [
      { layer: "seed", index: 0, finding },
      "revision of seed finding #0: no earlier layer with findings has that name",
    ],
    [{ layer: "openapi", index: 5, finding }, "revision of openapi finding #5: no such finding"],
    [
      { layer: "openapi", index: 0, finding: { ...finding, subject: "GET /other" } },
      "revision of openapi finding #0 changes subject",
    ],
    [
      { layer: "openapi", index: 0, finding: { ...finding, scope: "other" } },
      "revision of openapi finding #0 changes scope",
    ],
    [
      { layer: "openapi", index: 0, finding: { ...finding, accepted: { reason: "hidden" } } },
      "revision of openapi finding #0 changes accepted",
    ],
  ])("rejects %j", (revision, error) => {
    expect(applyRevisions(results, [revision])).toEqual({ ok: false, error });
  });

  it("rejects revising one finding twice", () => {
    const revision = {
      layer: "openapi",
      index: 1,
      finding: results[0]?.status === "ran" ? (results[0].findings[1] as typeof finding) : finding,
    };
    expect(applyRevisions(results, [revision, revision])).toEqual({
      ok: false,
      error: "revision of openapi finding #1: revised twice",
    });
  });
});

describe("splitOutput", () => {
  it("separates revisions from the layer result", () => {
    const revision = { layer: "openapi", index: 0, finding };
    expect(
      splitOutput({ layer: "x", status: "ran", findings: [], notes: [], revisions: [revision] }),
    ).toEqual({
      result: { layer: "x", status: "ran", findings: [], notes: [] },
      revisions: [revision],
    });
    expect(splitOutput({ layer: "x", status: "skipped", reason: "r" })).toEqual({
      result: { layer: "x", status: "skipped", reason: "r" },
      revisions: [],
    });
  });
});
