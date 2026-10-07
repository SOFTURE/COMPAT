import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { sqlMigrationsLayer } from "../../../src/layers/sql-migrations/sql-migrations-layer.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    { files: { "a/0001.sql": "CREATE TABLE t (id int);", "a/0002.sql": "SELECT 1;" }, tag: "v1" },
    { files: { "a/0002.sql": null, "a/0003.sql": "ALTER TABLE t DROP COLUMN x;" }, tag: "v2" },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-sql-layer-"));
  const opened = await Promise.all([
    openRefTree({ repoDir: repo.dir, ref: "v1", side: "base", tempRoot }),
    openRefTree({ repoDir: repo.dir, ref: "v2", side: "revision", tempRoot }),
  ]);
  if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
  base = opened[0].value;
  revision = opened[1].value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

const run = (config: unknown) =>
  sqlMigrationsLayer.run({
    config: sqlMigrationsLayer.configSchema.parse(config),
    base,
    revision,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: process.env,
    log: () => {},
  });

describe("sql-migrations layer", () => {
  it("reports findings and notes per source", async () => {
    const result = await run({
      sources: [
        {
          name: "a",
          dialect: "postgres",
          kind: "folder",
          path: "a",
          accept: [{ id: "drop-column", migration: "0009.sql", reason: "old" }],
        },
      ],
    });
    expect(result.status).toBe("ran");
    if (result.status === "skipped") return;
    expect(
      result.findings.map((finding) => [finding.scope, finding.id, finding.class, finding.subject]),
    ).toEqual([
      ["a", "drop-column", "breaking", "0003.sql: t.x"],
      ["a", "migration-removed", "needs-action", "0002.sql"],
    ]);
    expect(result.findings[1]?.evidence).toEqual([
      { side: "base", ref: "v1", commit: base.commit, path: "a/0002.sql" },
    ]);
    expect(result.notes).toEqual([
      'source "a": 1 new migration(s), 1 statement(s) read',
      'source "a": accept entry drop-column in 0009.sql matched nothing; remove it if the change is gone',
    ]);
  });

  it("fails with the findings of the sources that worked", async () => {
    const result = await run({
      sources: [
        { name: "a", dialect: "postgres", kind: "folder", path: "a" },
        { name: "missing", dialect: "postgres", kind: "ef-script", path: "db/none.sql" },
      ],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toBe('source "missing": EF script db/none.sql does not exist at revision v2');
    expect(result.findings).toHaveLength(2);
  });
});
