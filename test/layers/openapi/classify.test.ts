import { describe, expect, it } from "vitest";
import type { RefTree } from "../../../src/git/ref-tree.js";
import { applyAccept, type ClassifiedChange, classifyChanges } from "../../../src/layers/openapi/classify.js";
import type { OasdiffChange } from "../../../src/layers/openapi/oasdiff.js";
import type { ResolvedSpec } from "../../../src/layers/openapi/spec-source.js";

type FoundSpec = Extract<ResolvedSpec, { status: "found" }>;

const tree = (side: "base" | "revision", ref: string): RefTree =>
  ({ side, ref, commit: side === "base" ? "a".repeat(40) : "b".repeat(40) }) as RefTree;
const base = tree("base", "2.2.4");
const revision = tree("revision", "2.3.4");
const baseSpec: FoundSpec = {
  status: "found" as const,
  file: "/tmp/x/base-1/tree/api/b2c.yaml",
  root: "/tmp/x/base-1/tree",
  displayPath: "api/b2c.yaml",
};
const revisionSpec: FoundSpec = {
  ...baseSpec,
  file: "/tmp/x/revision-1/tree/api/b2c.yaml",
  root: "/tmp/x/revision-1/tree",
};

function classify(changes: OasdiffChange[], specs = { baseSpec, revisionSpec }): ClassifiedChange[] {
  return classifyChanges({ apiName: "b2c", changes, base, revision, ...specs });
}

describe("classifyChanges", () => {
  it("maps ERR, WARN and INFO to breaking, needs-action and safe", () => {
    const changes = [3, 2, 1].map((level) => ({
      id: `c${level}`,
      text: "t",
      level,
      operation: "GET",
      path: "/a",
    }));
    expect(classify(changes).map(({ finding }) => finding.class)).toEqual([
      "breaking",
      "needs-action",
      "safe",
    ]);
  });

  it("builds evidence from base and revision sources relative to each tree", () => {
    const [classified] = classify([
      {
        id: "request-property-became-not-nullable",
        text: "the request property `daysOfWeek` became not nullable",
        level: 3,
        operation: "POST",
        path: "/api/pets/{petId}/medications",
        baseSource: { file: "/tmp/x/base-1/tree/api/b2c.yaml", line: 32 },
        revisionSource: { file: "/tmp/x/revision-1/tree/api/b2c.yaml", line: 30 },
      },
    ]);
    expect(classified).toEqual({
      operation: "POST /api/pets/{petId}/medications",
      finding: {
        layer: "openapi",
        scope: "b2c",
        id: "request-property-became-not-nullable",
        subject: "POST /api/pets/{petId}/medications",
        class: "breaking",
        message: "the request property `daysOfWeek` became not nullable",
        evidence: [
          { side: "base", ref: "2.2.4", commit: "a".repeat(40), path: "api/b2c.yaml", line: 32 },
          { side: "revision", ref: "2.3.4", commit: "b".repeat(40), path: "api/b2c.yaml", line: 30 },
        ],
      },
    });
  });

  it("reports a change inside a $ref-ed file with that file's repository path", () => {
    const [classified] = classify([
      {
        id: "x",
        text: "t",
        level: 3,
        baseSource: { file: "/tmp/x/base-1/tree/api/schemas/pet.yaml", line: 4 },
      },
    ]);
    expect(classified?.finding.evidence[0]?.path).toBe("api/schemas/pet.yaml");
  });

  it("uses the display path for URL specs and falls back to the revision spec without sources", () => {
    const urlSpec: FoundSpec = {
      status: "found" as const,
      file: "/tmp/spec",
      root: null,
      displayPath: "https://dev.test/s.json",
    };
    const [withSource] = classify(
      [{ id: "x", text: "t", level: 1, revisionSource: { file: "/tmp/spec", line: 2 } }],
      {
        baseSpec: urlSpec,
        revisionSpec: urlSpec,
      },
    );
    expect(withSource?.finding.evidence[0]?.path).toBe("https://dev.test/s.json");
    const [noSource] = classify([
      { id: "api-major-version-not-bumped", text: "t", level: 1, section: "info" },
    ]);
    expect(noSource?.finding.subject).toBe("info");
    expect(noSource?.operation).toBeUndefined();
    expect(noSource?.finding.evidence).toEqual([
      { side: "revision", ref: "2.3.4", commit: "b".repeat(40), path: "api/b2c.yaml" },
    ]);
  });
});

describe("applyAccept", () => {
  const changes = classify([
    {
      id: "request-property-became-not-nullable",
      text: "t",
      level: 3,
      operation: "POST",
      path: "/api/pets/{petId}/medications",
    },
    {
      id: "request-property-became-not-nullable",
      text: "t",
      level: 3,
      operation: "PUT",
      path: "/api/owners/{id}",
    },
    { id: "api-major-version-not-bumped", text: "t", level: 1, section: "info" },
  ]);

  it("accepts only the named operation and counts usage", () => {
    const { findings, usage } = applyAccept(changes, [
      {
        id: "request-property-became-not-nullable",
        operation: "POST /api/pets/{petId}/medications",
        reason: "F2",
      },
    ]);
    expect(findings.map((finding) => finding.accepted)).toEqual([{ reason: "F2" }, undefined, undefined]);
    expect(usage.map(({ count }) => count)).toEqual([1]);
  });

  it("does not let an id-only entry hide the check on operations", () => {
    const { findings, usage } = applyAccept(changes, [
      { id: "request-property-became-not-nullable", reason: "too broad" },
      { id: "api-major-version-not-bumped", reason: "versioned by tag" },
    ]);
    expect(findings.map((finding) => finding.accepted?.reason)).toEqual([
      undefined,
      undefined,
      "versioned by tag",
    ]);
    expect(usage.map(({ count }) => count)).toEqual([0, 1]);
  });

  it("keeps a finding whose operation differs and reports the entry as unused", () => {
    const { findings, usage } = applyAccept(changes, [
      { id: "request-property-became-not-nullable", operation: "POST /api/other", reason: "r" },
    ]);
    expect(findings.every((finding) => finding.accepted === undefined)).toBe(true);
    expect(usage).toEqual([{ entry: expect.objectContaining({ operation: "POST /api/other" }), count: 0 }]);
  });
});
