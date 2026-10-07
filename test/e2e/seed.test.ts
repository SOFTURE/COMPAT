import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (path: string) => readFileSync(new URL(`../fixtures/seed/${path}`, import.meta.url), "utf8");

type JsonFinding = {
  id: string;
  class: string;
  subject: string;
  message: string;
  evidence: { line?: number }[];
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
  const layer = report?.layers.find((item: JsonLayer) => item.layer === "seed") as JsonLayer;
  return { exitCode, layer, stderr: run.stderr() };
}

describe.each([
  ["postgres", "f6-postgres", "EmailTemplates"],
  ["sqlserver", "f6-sqlserver", "dbo.EmailTemplates"],
] as const)("seed script, %s (research F6)", (dialect, folder, table) => {
  let repo: TestRepo;

  beforeAll(() => {
    const revisionSeed = fixture(`${folder}/revision.sql`);
    repo = createRepo([
      { files: { "db/seed.sql": fixture(`${folder}/base.sql`) }, tag: "2.2.4" },
      { files: { "db/seed.sql": revisionSeed }, tag: "2.3.4" },
      {
        files: { "db/seed.sql": revisionSeed.replace("Use this link: {{link}}", "Reset it here: {{link}}") },
        tag: "changed",
      },
    ]);
    writeRepoFile(
      repo,
      "compat.json",
      JSON.stringify({ layers: { seed: { sources: [{ name: "db", dialect, files: ["db/seed.sql"] }] } } }),
    );
  });
  afterAll(() => repo.cleanup());

  it("F6: three new templates under an upsert are safe, also with --fail-on needs-action", async () => {
    const { exitCode, layer, stderr } = await check(repo, "2.3.4", "--fail-on", "needs-action");
    expect(stderr).toContain("gate passed");
    expect(exitCode).toBe(0);
    expect(layer.status).toBe("ran");
    expect(layer.findings.map((finding) => [finding.id, finding.class, finding.subject])).toEqual([
      ["row-added", "safe", `db/seed.sql: ${table}`],
    ]);
    expect(layer.findings[0]?.message).toContain("adds 3 row(s)");
    expect(layer.findings[0]?.message).toContain("501; 502; 503");
  });

  it("an edited existing template under the upsert needs action", async () => {
    const { exitCode, layer } = await check(repo, "changed", "--fail-on", "needs-action");
    expect(exitCode).toBe(1);
    expect(layer.findings.filter((finding) => finding.class !== "safe").map((finding) => finding.id)).toEqual(
      ["row-changed"],
    );
    expect(layer.findings.find((finding) => finding.id === "row-changed")?.message).toContain("201");
  });
});
