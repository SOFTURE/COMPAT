import { describe, expect, it } from "vitest";
import type { LayerResult } from "../../src/model/finding.js";
import { evaluateGate } from "../../src/model/gate.js";
import { renderJson } from "../../src/report/json.js";
import { escapeMarkdown, renderMarkdown } from "../../src/report/markdown.js";
import type { Report } from "../../src/report/report.js";
import { createFinding } from "../helpers/stub-layer.js";

function buildReport(layers: LayerResult[]): Report {
  const options = { failOn: "breaking" as const, allowIncomplete: false };
  return {
    base: { ref: "2.2.4", commit: "a".repeat(40) },
    revision: { ref: "2.3.4", commit: "b".repeat(40) },
    ...options,
    gate: evaluateGate(layers, options),
    layers,
  };
}

const mixed: LayerResult[] = [
  {
    layer: "openapi",
    status: "ran",
    findings: [
      createFinding("safe", { layer: "openapi", id: "endpoint-added", subject: "GET /api/shop" }),
      createFinding("breaking", {
        layer: "openapi",
        id: "request-property-became-not-nullable",
        message: "a | b `c`",
      }),
      createFinding("breaking", {
        layer: "openapi",
        id: "api-path-removed",
        accepted: { reason: "unused since 2.0" },
      }),
    ],
    notes: ["oasdiff version main"],
  },
  { layer: "seed", status: "skipped", reason: "no seed files" },
  {
    layer: "config",
    status: "failed",
    error: "cannot read compose.yaml",
    findings: [createFinding("needs-action", { layer: "config", id: "key-added", subject: "Shop__ApiKey" })],
    notes: ["read 2 of 3 sources"],
  },
];

describe("renderMarkdown", () => {
  it("renders an empty report as a passing gate", () => {
    const markdown = renderMarkdown(
      buildReport([{ layer: "openapi", status: "ran", findings: [], notes: [] }]),
    );
    expect(markdown).toBe(
      [
        "# Backward compatibility: 2.2.4 → 2.3.4",
        "",
        "Base `aaaaaaaaaaaa`, revision `bbbbbbbbbbbb`, fail on `breaking`.",
        "",
        "**Gate: PASS**",
        "",
        "| Layer | Verdict | breaking | rollback-risk | needs-action | safe |",
        "| --- | --- | --- | --- | --- | --- |",
        "| openapi | no-findings | 0 | 0 | 0 | 0 |",
        "",
      ].join("\n"),
    );
  });

  it("groups findings by class, lists accepted ones, incomplete layers and notes", () => {
    const markdown = renderMarkdown(buildReport(mixed));
    expect(markdown).toContain(
      "**Gate: FAIL**\n- openapi: 1 finding(s) at or above breaking\n- seed: layer skipped",
    );
    expect(markdown).toContain("| openapi | breaking | 1 | 0 | 0 | 1 |");
    expect(markdown).toContain("| seed | skipped | - | - | - | - |");
    expect(markdown.indexOf("## breaking (1)")).toBeLessThan(markdown.indexOf("## safe (1)"));
    expect(markdown).toContain(
      "- **openapi / api** `request-property-became-not-nullable` GET /things: a \\| b \\`c\\` (`openapi.yaml:3` @ v2)",
    );
    expect(markdown).toContain("## Accepted (1)");
    expect(markdown).toContain("  - accepted: unused since 2.0");
    expect(markdown).toContain(
      "## Not checked\n\n- **seed** skipped: no seed files\n- **config** failed: cannot read compose.yaml",
    );
    expect(markdown).toContain(
      "## Notes\n\n- **openapi**: oasdiff version main\n- **config**: read 2 of 3 sources",
    );
    expect(markdown).toContain("| config | failed | 0 | 0 | 1 | 0 |");
    expect(markdown).toContain("## needs-action (1)\n\n- **config / api** `key-added` Shop__ApiKey");
  });

  it("names the resolver and what it resolved to in the header", () => {
    const report = buildReport([]);
    report.base = { ref: "2.2.4", commit: "a".repeat(40), resolver: "github-deployment:prod" };
    expect(renderMarkdown(report).split("\n")[2]).toBe(
      "Base github-deployment:prod → 2.2.4 `aaaaaaaaaaaa`, revision `bbbbbbbbbbbb`, fail on `breaking`.",
    );
  });

  it("escapes table and code characters", () => {
    expect(escapeMarkdown("a|b`c\\d\ne")).toBe("a\\|b\\`c\\\\d e");
    expect(escapeMarkdown("<!-- @team/owners -->")).toBe("&lt;!-- @\u200bteam/owners --&gt;");
  });
});

describe("renderJson", () => {
  it("renders a versioned document with layer verdicts", () => {
    const document = JSON.parse(renderJson(buildReport(mixed)));
    expect(document.schemaVersion).toBe(1);
    expect(document.gate.exitCode).toBe(1);
    expect(document.base).toEqual({ ref: "2.2.4", commit: "a".repeat(40) });
    expect(
      document.layers.map((layer: { layer: string; verdict: string }) => [layer.layer, layer.verdict]),
    ).toEqual([
      ["openapi", "breaking"],
      ["seed", "skipped"],
      ["config", "failed"],
    ]);
    expect(document.layers[0].findings[2].accepted).toEqual({ reason: "unused since 2.0" });
  });

  it("includes the resolver of a resolved ref", () => {
    const report = buildReport([]);
    report.base = { ref: "2.2.4", commit: "a".repeat(40), resolver: "github-deployment:prod" };
    const document = JSON.parse(renderJson(report));
    expect(document.base).toEqual({
      ref: "2.2.4",
      commit: "a".repeat(40),
      resolver: "github-deployment:prod",
    });
    expect(document.revision).toEqual({ ref: "2.3.4", commit: "b".repeat(40) });
  });

  it("renders an empty report", () => {
    const document = JSON.parse(renderJson(buildReport([])));
    expect(document.layers).toEqual([]);
    expect(document.gate).toEqual({ passed: true, exitCode: 0, reasons: [] });
  });
});
