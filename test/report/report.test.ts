import { describe, expect, it } from "vitest";
import type { LayerResult } from "../../src/model/finding.js";
import { evaluateGate, type InactiveLayer } from "../../src/model/gate.js";
import { renderJson } from "../../src/report/json.js";
import { escapeMarkdown, renderMarkdown } from "../../src/report/markdown.js";
import type { Report } from "../../src/report/report.js";
import { createFinding } from "../helpers/stub-layer.js";

function buildReport(layers: LayerResult[], inactive: InactiveLayer[] = [], required: string[] = []): Report {
  const options = { failOn: "breaking" as const, allowIncomplete: false, required };
  return {
    base: { ref: "2.2.4", commit: "a".repeat(40), source: "flag" },
    revision: { ref: "2.3.4", commit: "b".repeat(40), source: "flag" },
    ...options,
    gate: evaluateGate(layers, options, inactive),
    layers,
    inactive,
  };
}

const unchecked: InactiveLayer[] = [
  { layer: "openapi", status: "disabled" },
  { layer: "behaviour", status: "not-configured" },
];

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
        "Base `aaaaaaaaaaaa` (--base), revision `bbbbbbbbbbbb` (--revision), fail on `breaking`.",
        "",
        "**Gate: PASS**",
        "",
        "| Layer | Verdict | breaking | rollback-risk | needs-action | safe | accepted |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| openapi | no-findings | 0 | 0 | 0 | 0 | 0 |",
        "",
      ].join("\n"),
    );
  });

  it("groups findings by class, lists accepted ones, incomplete layers and notes", () => {
    const markdown = renderMarkdown(buildReport(mixed));
    expect(markdown).toContain(
      "**Gate: FAIL**\n- openapi: 1 finding(s) at or above breaking\n- seed: layer skipped",
    );
    expect(markdown).toContain("| openapi | breaking | 1 | 0 | 0 | 1 | 1 |");
    expect(markdown).toContain("| seed | skipped | - | - | - | - | - |");
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
    expect(markdown).toContain("| config | failed | 0 | 0 | 1 | 0 | 0 |");
    expect(markdown).toContain("## needs-action (1)\n\n- **config / api** `key-added` Shop__ApiKey");
  });

  it("counts accepted findings and names a layer that only reclassified others", () => {
    const markdown = renderMarkdown(
      buildReport([
        {
          layer: "openapi",
          status: "ran",
          findings: [
            createFinding("safe", {
              layer: "openapi",
              id: "response-property-removed",
              reclassified: { from: "breaking", by: "client-usage", reason: "no client reads it" },
            }),
            createFinding("safe", {
              layer: "openapi",
              id: "request-property-removed",
              reclassified: { from: "breaking", by: "client-usage", reason: "no client sends it" },
            }),
          ],
          notes: [],
        },
        {
          layer: "dependencies",
          status: "ran",
          findings: [
            createFinding("needs-action", {
              layer: "dependencies",
              id: "dependency-upgraded",
              accepted: { reason: "reviewed the 1.x changelog" },
            }),
            createFinding("safe", {
              layer: "dependencies",
              id: "dependency-upgraded",
              accepted: { reason: "minor upgrade" },
            }),
          ],
          notes: [],
        },
        {
          layer: "client-usage",
          status: "ran",
          findings: [],
          notes: ["reclassified 2 openapi finding(s) to safe"],
        },
      ]),
    );
    expect(markdown).toContain(
      [
        "| openapi | safe | 0 | 0 | 0 | 2 | 0 |",
        "| dependencies | no-findings | 0 | 0 | 0 | 0 | 2 |",
        "| client-usage | reclassified 2 | 0 | 0 | 0 | 0 | 0 |",
      ].join("\n"),
    );
  });

  it("shows the last lines of a failed command as a code block with its newlines kept", () => {
    const markdown = renderMarkdown(
      buildReport([
        {
          layer: "behaviour",
          status: "failed",
          error:
            "baseline: start command at base (2.2.4) exited 1; full output in /logs/baseline-start-base.log",
          findings: [],
          notes: [],
          outputs: [
            {
              command: "baseline: start command at base (2.2.4) exited 1",
              tail: "Container db Started\n```\nAborting on container exit...",
              log: "/logs/baseline-start-base.log",
            },
          ],
        },
      ]),
    );
    expect(markdown).toContain(
      [
        "- **behaviour** failed: baseline: start command at base (2.2.4) exited 1; full output in /logs/baseline-start-base.log",
        "",
        "  Last lines of baseline: start command at base (2.2.4) exited 1 (full output: `/logs/baseline-start-base.log`):",
        "",
        "  ````text",
        "  Container db Started",
        "  ```",
        "  Aborting on container exit...",
        "  ````",
      ].join("\n"),
    );
  });

  it("names the resolver, what it resolved to and where each ref was set in the header", () => {
    const report = buildReport([]);
    report.base = {
      ref: "2.2.4",
      commit: "a".repeat(40),
      resolver: "github-deployment:prod",
      source: "config",
    };
    expect(renderMarkdown(report).split("\n")[2]).toBe(
      "Base github-deployment:prod → 2.2.4 `aaaaaaaaaaaa` (config), revision `bbbbbbbbbbbb` (--revision), fail on `breaking`.",
    );
  });

  it("says a ref came from the command line with the flag that set it", () => {
    expect(renderMarkdown(buildReport([])).split("\n")[2]).toBe(
      "Base `aaaaaaaaaaaa` (--base), revision `bbbbbbbbbbbb` (--revision), fail on `breaking`.",
    );
  });

  it("escapes table and code characters", () => {
    expect(escapeMarkdown("a|b`c\\d\ne")).toBe("a\\|b\\`c\\\\d e");
    expect(escapeMarkdown("<!-- @team/owners -->")).toBe("\\<!-- @\u200bteam/owners -->");
    expect(escapeMarkdown("<script> </b> <?x")).toBe("\\<script> \\</b> \\<?x");
  });

  it("leaves a comparison that cannot open a tag as it is", () => {
    expect(escapeMarkdown("precondition: production max(Id) < 418, a <= b, c > d")).toBe(
      "precondition: production max(Id) < 418, a <= b, c > d",
    );
  });
});

describe("renderMarkdown sections", () => {
  const evidenceAt = (ref: string, line = 187) => ({
    side: "client" as const,
    ref,
    commit: "c".repeat(40),
    path: "app/pet/[id].tsx",
    line,
  });

  it("counts safe findings per layer and rule and folds them into a details block", () => {
    const findings = [
      createFinding("safe", { layer: "error-codes", id: "error-code-added", subject: "PET_1" }),
      createFinding("safe", { layer: "error-codes", id: "error-code-unknown-to-client", subject: "PET_2" }),
      createFinding("safe", { layer: "error-codes", id: "error-code-unknown-to-client", subject: "PET_3" }),
      createFinding("safe", { layer: "openapi", id: "endpoint-added", subject: "GET /api/shop" }),
    ];
    const markdown = renderMarkdown(buildReport([{ layer: "all", status: "ran", findings, notes: [] }]));
    expect(markdown).toContain(
      [
        "## safe (4)",
        "",
        "- error-codes: 2 × `error-code-unknown-to-client`, 1 × `error-code-added`",
        "- openapi: 1 × `endpoint-added`",
        "",
        "<details><summary>All safe findings</summary>",
        "",
        "- **error-codes / api** `error-code-added` PET_1: a safe change (`openapi.yaml:3` @ v2)",
      ].join("\n"),
    );
    expect(markdown).toMatch(/GET \/api\/shop: a safe change \(`openapi.yaml:3` @ v2\)\n\n<\/details>\n$/);
  });

  it("folds accepted findings the same way", () => {
    const findings = [createFinding("breaking", { id: "api-path-removed", accepted: { reason: "unused" } })];
    const markdown = renderMarkdown(buildReport([{ layer: "stub", status: "ran", findings, notes: [] }]));
    expect(markdown).toContain(
      "## Accepted (1)\n\n- stub: 1 × `api-path-removed`\n\n<details><summary>All accepted findings</summary>\n\n- **stub / api**",
    );
    expect(markdown).not.toContain("## breaking");
  });

  it("shows findings of several layers about one topic as one entry with each layer's view", () => {
    const seedRow = createFinding("rollback-risk", {
      layer: "seed",
      scope: "db",
      id: "row-added",
      subject: "seed.sql: NotificationTemplates",
      topic: "NotificationType.TermsChange",
      reclassified: { from: "safe", by: "persisted-enums", reason: "writes a new member" },
    });
    const member = createFinding("rollback-risk", {
      layer: "persisted-enums",
      scope: "NotificationType",
      id: "enum-member-added",
      subject: "NotificationType.TermsChange",
    });
    const other = createFinding("rollback-risk", { layer: "seed", subject: "seed.sql: Banners" });
    const layers: LayerResult[] = [
      { layer: "seed", status: "ran", findings: [seedRow, other], notes: [] },
      { layer: "persisted-enums", status: "ran", findings: [member], notes: [] },
    ];
    expect(renderMarkdown(buildReport(layers))).toContain(
      [
        "## rollback-risk (2)",
        "",
        "- **NotificationType.TermsChange** (seed, persisted-enums)",
        "  - **seed / db** `row-added` seed.sql: NotificationTemplates: a rollback-risk change (`openapi.yaml:3` @ v2)",
        "    - reclassified from safe by persisted-enums: writes a new member",
        "  - **persisted-enums / NotificationType** `enum-member-added` NotificationType.TermsChange: a rollback-risk change (`openapi.yaml:3` @ v2)",
        "- **seed / api** `rule-rollback-risk` seed.sql: Banners: a rollback-risk change (`openapi.yaml:3` @ v2)",
      ].join("\n"),
    );
  });

  it("keeps findings of one layer that share a subject as separate entries", () => {
    const findings = [
      createFinding("breaking", { layer: "openapi", id: "a" }),
      createFinding("breaking", { layer: "openapi", id: "b" }),
    ];
    const markdown = renderMarkdown(buildReport([{ layer: "openapi", status: "ran", findings, notes: [] }]));
    expect(markdown).toContain("## breaking (2)\n\n- **openapi / api** `a`");
  });

  it("lists every ref of a location once in one evidence link", () => {
    const finding = createFinding("breaking", {
      evidence: [evidenceAt("2.0.1"), evidenceAt("2.0.2"), evidenceAt("2.0.1"), evidenceAt("2.1.1", 9)],
    });
    const markdown = renderMarkdown(
      buildReport([{ layer: "stub", status: "ran", findings: [finding], notes: [] }]),
    );
    expect(markdown).toContain("(`app/pet/[id].tsx:187` @ 2.0.1, 2.0.2; `app/pet/[id].tsx:9` @ 2.1.1)");
  });
});

describe("renderMarkdown with layers that did not run", () => {
  const seedRan: LayerResult[] = [{ layer: "seed", status: "ran", findings: [], notes: [] }];

  it("lists disabled and unconfigured layers under a passing gate and in the table", () => {
    const markdown = renderMarkdown(buildReport(seedRan, unchecked));
    expect(markdown).toBe(
      [
        "# Backward compatibility: 2.2.4 → 2.3.4",
        "",
        "Base `aaaaaaaaaaaa` (--base), revision `bbbbbbbbbbbb` (--revision), fail on `breaking`.",
        "",
        "**Gate: PASS**",
        "",
        "Not checked: openapi (disabled), behaviour (not configured)",
        "",
        "| Layer | Verdict | breaking | rollback-risk | needs-action | safe | accepted |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| seed | no-findings | 0 | 0 | 0 | 0 | 0 |",
        "| openapi | disabled | - | - | - | - | - |",
        "| behaviour | not configured | - | - | - | - | - |",
        "",
      ].join("\n"),
    );
  });

  it("names required layers in the header and fails the gate on a disabled one", () => {
    const markdown = renderMarkdown(buildReport(seedRan, unchecked, ["openapi", "seed"]));
    expect(markdown).toContain("fail on `breaking`, required: `openapi`, `seed`.");
    expect(markdown).toContain(
      "**Gate: FAIL**\n- openapi: layer disabled, but --require names it\n\nNot checked: openapi (disabled)",
    );
  });
});

describe("renderJson", () => {
  it("renders a versioned document with layer verdicts", () => {
    const document = JSON.parse(renderJson(buildReport(mixed)));
    expect(document.schemaVersion).toBe(1);
    expect(document.gate.exitCode).toBe(1);
    expect(document.base).toEqual({ ref: "2.2.4", commit: "a".repeat(40), source: "flag" });
    expect(
      document.layers.map((layer: { layer: string; verdict: string }) => [layer.layer, layer.verdict]),
    ).toEqual([
      ["openapi", "breaking"],
      ["seed", "skipped"],
      ["config", "failed"],
    ]);
    expect(document.layers[0].findings[2].accepted).toEqual({ reason: "unused since 2.0" });
    expect(
      document.layers.map((layer: { acceptedCount: number; reclassifiedCount: number }) => [
        layer.acceptedCount,
        layer.reclassifiedCount,
      ]),
    ).toEqual([
      [1, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it("lists layers that did not run with their status and the required layers", () => {
    const document = JSON.parse(renderJson(buildReport([], unchecked, ["openapi"])));
    expect(document.required).toEqual(["openapi"]);
    expect(document.layers).toEqual([
      { layer: "openapi", status: "disabled", verdict: "disabled", findings: [], notes: [] },
      { layer: "behaviour", status: "not-configured", verdict: "not-configured", findings: [], notes: [] },
    ]);
    expect(document.gate.reasons).toEqual(["openapi: layer disabled, but --require names it"]);
  });

  it("includes the resolver and the source of each ref", () => {
    const report = buildReport([]);
    report.base = {
      ref: "2.2.4",
      commit: "a".repeat(40),
      resolver: "github-deployment:prod",
      source: "config",
    };
    const document = JSON.parse(renderJson(report));
    expect(document.base).toEqual({
      ref: "2.2.4",
      commit: "a".repeat(40),
      resolver: "github-deployment:prod",
      source: "config",
    });
    expect(document.revision).toEqual({ ref: "2.3.4", commit: "b".repeat(40), source: "flag" });
  });

  it("renders an empty report", () => {
    const document = JSON.parse(renderJson(buildReport([])));
    expect(document.layers).toEqual([]);
    expect(document.gate).toEqual({ passed: true, exitCode: 0, reasons: [] });
  });
});
