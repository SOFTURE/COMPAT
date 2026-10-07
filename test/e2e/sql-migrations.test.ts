import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/sql-migrations/${path}`, import.meta.url), "utf8");

type JsonFinding = {
  id: string;
  class: string;
  subject: string;
  message: string;
  evidence: { path: string; line?: number }[];
};
type JsonLayer = { layer: string; status: string; findings: JsonFinding[] };

async function check(repo: TestRepo, revision: string, ...extra: string[]) {
  const run = createIo(repo.dir);
  const exitCode = await main(
    [
      "check",
      "--base",
      "2.2.4",
      "--revision",
      revision,
      "--config",
      "compat.json",
      "--format",
      "json",
      ...extra,
    ],
    run.io,
  );
  const report = run.stdout() === "" ? null : JSON.parse(run.stdout());
  const layer = report?.layers.find((item: JsonLayer) => item.layer === "sql-migrations") as JsonLayer;
  return { exitCode, layer, stderr: run.stderr() };
}

describe.each([
  ["postgres", "ef-postgres"],
  ["sqlserver", "ef-sqlserver"],
] as const)("EF Core idempotent script, %s (research F4, F5)", (dialect, folder) => {
  let repo: TestRepo;

  beforeAll(() => {
    repo = createRepo([
      { files: { "db/migrations.sql": fixture(`${folder}/base.sql`) }, tag: "2.2.4" },
      { files: { "db/migrations.sql": fixture(`${folder}/revision-f4.sql`) }, tag: "f4" },
      { files: { "db/migrations.sql": fixture(`${folder}/revision.sql`) }, tag: "2.3.4" },
    ]);
    writeRepoFile(
      repo,
      "compat.json",
      JSON.stringify({
        layers: {
          "sql-migrations": {
            sources: [{ name: "db", dialect, kind: "ef-script", path: "db/migrations.sql" }],
          },
        },
      }),
    );
  });
  afterAll(() => repo.cleanup());

  it("F4: only new schemas, tables and their indexes give the verdict safe", async () => {
    const { exitCode, layer } = await check(repo, "f4");
    expect(exitCode).toBe(0);
    expect(layer.status).toBe("ran");
    expect(layer.findings.length).toBeGreaterThan(0);
    expect(layer.findings.filter((finding) => finding.class !== "safe")).toEqual([]);
  });

  it("F5: explicit ids 418-496 give one needs-action finding with the precondition", async () => {
    const { exitCode, layer } = await check(repo, "2.3.4");
    expect(exitCode).toBe(0);
    const unsafe = layer.findings.filter((finding) => finding.class !== "safe");
    expect(unsafe.map((finding) => [finding.id, finding.class, finding.subject])).toEqual([
      ["insert-explicit-id", "needs-action", "20261005073152_AddMissingPetBreeds: Breeds"],
    ]);
    expect(unsafe[0]?.message).toContain("79 row(s)");
    expect(unsafe[0]?.message).toContain("418-496");
    expect(unsafe[0]?.message).toContain("max(Id) < 418");
    expect(unsafe[0]?.evidence[0]).toMatchObject({ path: "db/migrations.sql", line: expect.any(Number) });
  });

  it("F5 fails the gate with --fail-on needs-action", async () => {
    expect((await check(repo, "2.3.4", "--fail-on", "needs-action")).exitCode).toBe(1);
  });
});

describe("drizzle folder", () => {
  let repo: TestRepo;
  const config = (accept?: object[]) =>
    JSON.stringify({
      layers: {
        "sql-migrations": {
          sources: [
            {
              name: "app",
              dialect: "postgres",
              kind: "folder",
              path: "drizzle",
              ...(accept ? { accept } : {}),
            },
          ],
        },
      },
    });

  beforeAll(() => {
    repo = createRepo([
      {
        files: {
          "drizzle/0001_init.sql":
            'CREATE TABLE "users" (\n\t"id" serial PRIMARY KEY,\n\t"legacy" text\n);\n',
        },
        tag: "2.2.4",
      },
      {
        files: {
          "drizzle/0002_drop_legacy.sql":
            'ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint\nALTER TABLE "users" DROP COLUMN "legacy";',
        },
        tag: "2.3.4",
      },
    ]);
  });
  afterAll(() => repo.cleanup());

  it("fails the gate on a dropped column with path:line evidence", async () => {
    writeRepoFile(repo, "compat.json", config());
    const { exitCode, layer } = await check(repo, "2.3.4");
    expect(exitCode).toBe(1);
    const breaking = layer.findings.filter((finding) => finding.class === "breaking");
    expect(
      breaking.map((finding) => [
        finding.id,
        finding.subject,
        finding.evidence[0]?.path,
        finding.evidence[0]?.line,
      ]),
    ).toEqual([["drop-column", "0002_drop_legacy.sql: users.legacy", "drizzle/0002_drop_legacy.sql", 2]]);
  });

  it("passes once the dropped column is accepted, and lists it as accepted", async () => {
    writeRepoFile(
      repo,
      "compat.json",
      config([
        {
          id: "drop-column",
          migration: "0002_drop_legacy.sql",
          object: "users.legacy",
          reason: "unused since 2.1",
        },
      ]),
    );
    expect((await check(repo, "2.3.4")).exitCode).toBe(0);
    const run = createIo(repo.dir);
    await main(["check", "--base", "2.2.4", "--revision", "2.3.4", "--config", "compat.json"], run.io);
    expect(run.stdout()).toContain("## Accepted (1)");
    expect(run.stdout()).toContain("unused since 2.1");
  });
});
