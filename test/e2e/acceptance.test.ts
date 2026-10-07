import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { findRealOasdiff, shouldSkipRealOasdiff } from "../helpers/oasdiff.js";
import { createIo } from "../helpers/stub-layer.js";

/**
 * The PETSEO 2.2.4 -> 2.3.4 acceptance table (context/archive/2026-10-07-backward-compat-checker/research.md §1),
 * reproduced in one run over one synthetic repository with every v1 layer enabled.
 *
 * Not covered by v1, so not asserted: F3 (HTTP binding), F8 (message contracts), F9 (messaging runtime),
 * F11 (push payloads) and F12 (behaviour); see context/backlog/later-layers.md.
 */

const read = (path: string) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");

const CONTEXT_PATH = "PETSEO.Infrastructure/Persistence/PetseoDbContext.cs";
const ENUM_PATH = "PETSEO.Domain/Notifications/NotificationType.cs";

/** A DbContext whose `ConfigureEnum<NotificationType>()` call sits on line 188, as in research F7. */
const dbContext = [
  "namespace PETSEO.Infrastructure.Persistence;",
  "",
  "public sealed class PetseoDbContext : DbContext",
  "{",
  "    protected override void ConfigureConventions(ModelConfigurationBuilder builder)",
  "    {",
  ...Array.from({ length: 181 }, (_, index) => `        // convention ${index + 1}`),
  "        builder.ConfigureEnum<NotificationType>();",
  "    }",
  "}",
].join("\n");

const notificationType = (...extra: string[]) =>
  [
    "namespace PETSEO.Domain.Notifications;",
    "",
    "public enum NotificationType",
    "{",
    "    VisitReminder,",
    "    Newsletter,",
    ...extra,
    "}",
  ].join("\n");

function files(side: "base" | "revision"): Record<string, string> {
  const config = (name: string) => read(`config/f10/${side}/${name}`);
  return {
    "api/b2c.yaml": read(`openapi/f1-f2/${side}.yaml`),
    "db/migrations.sql": read(`sql-migrations/ef-postgres/${side}.sql`),
    "db/seed.sql": read(`seed/f6-postgres/${side}.sql`),
    [CONTEXT_PATH]: dbContext,
    [ENUM_PATH]: side === "base" ? notificationType() : notificationType("    TermsChange,"),
    "deploy/docker-compose.yml": config("docker-compose.yml"),
    ".env.example": config(".env.example"),
    "VPS/ANSIBLE/roles/app/tasks/main.yml": config("main.yml"),
    "src/Petseo.Api/Settings/ApiSettings.cs": config("ApiSettings.cs"),
  };
}

const oasdiff = findRealOasdiff();

const F2_ACCEPT = {
  id: "request-property-became-not-nullable",
  operation: "POST /api/pets/{petId}/medications",
  reason: "the old app always sends an array; the handler does ?? []",
};

function buildConfig(acceptF2: boolean) {
  return {
    layers: {
      openapi: {
        apis: [
          {
            name: "b2c",
            source: { kind: "file", path: "api/b2c.yaml" },
            ...(acceptF2 ? { accept: [F2_ACCEPT] } : {}),
          },
        ],
        oasdiff: { path: oasdiff ?? "oasdiff" },
      },
      "sql-migrations": {
        sources: [{ name: "db", dialect: "postgres", kind: "ef-script", path: "db/migrations.sql" }],
      },
      seed: { sources: [{ name: "db", dialect: "postgres", files: ["db/seed.sql"] }] },
      "persisted-enums": {
        sources: "**/*.cs",
        enums: [
          {
            kind: "discover",
            files: "**/*DbContext.cs",
            pattern: "ConfigureEnum<(?<name>[\\w.]+)>",
            storage: "string",
          },
        ],
      },
      config: {
        sources: [
          { kind: "compose" },
          { kind: "dotenv", valuesAreDefaults: true },
          {
            kind: "regex",
            name: "ansible-assert",
            files: ["VPS/ANSIBLE/roles/**/*.yml"],
            pattern: "^\\s*-\\s*app_env\\.(?<key>\\w+) is defined",
            flags: "m",
            comments: "hash",
          },
        ],
      },
    },
  };
}

type Row = { finding: string; layer: string; id: string; subject: string; class: string };

/** One row per in-scope acceptance finding; `subject` pins the finding the research names. */
const ACCEPTANCE: Row[] = [
  { finding: "F1", layer: "openapi", id: "endpoint-added", subject: "GET /api/shop/items", class: "safe" },
  { finding: "F1", layer: "openapi", id: "endpoint-added", subject: "GET /api/feature-flags", class: "safe" },
  {
    finding: "F2",
    layer: "openapi",
    id: F2_ACCEPT.id,
    subject: F2_ACCEPT.operation,
    class: "breaking",
  },
  {
    finding: "F5",
    layer: "sql-migrations",
    id: "insert-explicit-id",
    subject: "20261005073152_AddMissingPetBreeds: Breeds",
    class: "needs-action",
  },
  { finding: "F6", layer: "seed", id: "row-added", subject: "db/seed.sql: EmailTemplates", class: "safe" },
  {
    finding: "F7",
    layer: "persisted-enums",
    id: "enum-member-added",
    subject: "NotificationType.TermsChange",
    class: "rollback-risk",
  },
  {
    finding: "F10",
    layer: "config",
    id: "config-key-added-required",
    subject: "SHOP_BASE_URL",
    class: "needs-action",
  },
  {
    finding: "F10",
    layer: "config",
    id: "config-key-added-required",
    subject: "SHOP_API_KEY",
    class: "needs-action",
  },
];

type JsonFinding = { id: string; class: string; subject: string; accepted?: unknown };
type JsonLayer = { layer: string; status: string; findings: JsonFinding[] };
type JsonReport = { gate: { passed: boolean; reasons: string[] }; layers: JsonLayer[] };

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: files("base"), tag: "2.2.4" },
    { files: files("revision"), tag: "2.3.4" },
  ]);
  writeRepoFile(repo, "plain.json", JSON.stringify(buildConfig(false)));
  writeRepoFile(repo, "accepted.json", JSON.stringify(buildConfig(true)));
});
afterAll(() => repo?.cleanup());

async function check(config: string, ...extra: string[]) {
  const run = createIo(repo.dir);
  const exitCode = await main(
    ["check", "--base", "2.2.4", "--revision", "2.3.4", "--config", config, "--format", "json", ...extra],
    run.io,
  );
  return { exitCode, report: JSON.parse(run.stdout()) as JsonReport };
}

const findLayer = (report: JsonReport, name: string) => {
  const layer = report.layers.find((item) => item.layer === name);
  if (layer === undefined) throw new Error(`layer ${name} is missing from the report`);
  return layer;
};

describe.skipIf(shouldSkipRealOasdiff(oasdiff))("PETSEO acceptance table, all v1 layers in one run", () => {
  it("runs every layer and fails the default gate on F2 only", async () => {
    const { exitCode, report } = await check("plain.json");
    expect(exitCode).toBe(1);
    expect(report.layers.map((layer) => [layer.layer, layer.status])).toEqual([
      ["openapi", "ran"],
      ["sql-migrations", "ran"],
      ["seed", "ran"],
      ["persisted-enums", "ran"],
      ["config", "ran"],
      ["client-usage", "not-configured"],
      ["error-codes", "not-configured"],
      ["dependencies", "not-configured"],
      ["message-contracts", "not-configured"],
      ["behaviour", "not-configured"],
    ]);
    expect(report.gate.reasons).toEqual(["openapi: 1 finding(s) at or above breaking"]);
  });

  it.each(ACCEPTANCE)("$finding: $layer $id on $subject is $class", async (row) => {
    const { report } = await check("plain.json");
    const matches = findLayer(report, row.layer).findings.filter(
      (finding) => finding.id === row.id && finding.subject === row.subject,
    );
    expect(matches.map((finding) => finding.class)).toEqual([row.class]);
  });

  it("F4: every schema change of the revision is safe; only the F5 data migration is not", async () => {
    const { report } = await check("plain.json");
    const findings = findLayer(report, "sql-migrations").findings;
    expect(findings.some((finding) => finding.id === "create-table")).toBe(true);
    expect(findings.filter((finding) => finding.class !== "safe").map((finding) => finding.id)).toEqual([
      "insert-explicit-id",
    ]);
  });

  it("F1 and F6 leave nothing but safe findings next to F2 in their layers", async () => {
    const { report } = await check("plain.json");
    expect(findLayer(report, "seed").findings.filter((finding) => finding.class !== "safe")).toEqual([]);
    const openapi = findLayer(report, "openapi").findings.filter((finding) => finding.class !== "safe");
    expect(openapi.map((finding) => finding.id)).toEqual([F2_ACCEPT.id]);
  });

  it("passes the default gate once F2 is accepted, and still fails at rollback-risk on F7", async () => {
    const accepted = await check("accepted.json");
    expect(accepted.exitCode).toBe(0);
    const f2 = findLayer(accepted.report, "openapi").findings.find((finding) => finding.id === F2_ACCEPT.id);
    expect(f2?.accepted).toBeTruthy();

    const strict = await check("accepted.json", "--fail-on", "rollback-risk");
    expect(strict.exitCode).toBe(1);
    expect(strict.report.gate.reasons).toEqual(["persisted-enums: 1 finding(s) at or above rollback-risk"]);
  });
});
