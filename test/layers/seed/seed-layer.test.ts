import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { seedLayer } from "../../../src/layers/seed/seed-layer.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    {
      files: {
        "db/seed.sql": "INSERT INTO t (id, a) VALUES (1, 'x') ON CONFLICT (id) DO NOTHING;",
        "db/old.sql": "INSERT INTO o (id) VALUES (1) ON CONFLICT DO NOTHING;",
      },
      tag: "v1",
    },
    {
      files: {
        "db/seed.sql":
          "INSERT INTO t (id, a) VALUES (1, 'x'), (2, 'y') ON CONFLICT (id) DO NOTHING;\nUPDATE t SET a = 'z';",
        "db/old.sql": null,
      },
      tag: "v2",
    },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-seed-layer-"));
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
  seedLayer.run({
    config: seedLayer.configSchema.parse(config),
    base,
    revision,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: process.env,
    log: () => {},
  });

describe("seed layer", () => {
  it("reports findings, removed files, notes and accepted findings per source", async () => {
    const result = await run({
      sources: [
        {
          name: "db",
          dialect: "postgres",
          files: ["db/*.sql"],
          accept: [
            { id: "update-data", object: "T", reason: "one-off fix" },
            { id: "truncate", reason: "unused" },
          ],
        },
      ],
    });
    expect(result.status).toBe("ran");
    if (result.status === "skipped") return;
    expect(
      result.findings.map((finding) => [
        finding.scope,
        finding.id,
        finding.class,
        finding.subject,
        finding.accepted,
      ]),
    ).toEqual([
      ["db", "seed-file-removed", "safe", "db/old.sql: db/old.sql", undefined],
      ["db", "update-data", "needs-action", "db/seed.sql: t", { reason: "one-off fix" }],
      ["db", "row-added", "safe", "db/seed.sql: t", undefined],
    ]);
    expect(result.findings[0]?.evidence).toEqual([
      { side: "base", ref: "v1", commit: base.commit, path: "db/old.sql" },
    ]);
    expect(result.notes).toEqual([
      'source "db": 1 file(s), 2 write statement(s), 2 row(s) read at the revision',
      'source "db": accept entry update-data on T accepted 1 finding(s)',
      'source "db": accept entry truncate matched nothing; remove it if the change is gone',
    ]);
  });

  it("fails a source whose files match nothing at the revision and keeps the others' findings", async () => {
    const result = await run({
      sources: [
        { name: "db", dialect: "postgres", files: ["db/seed.sql"] },
        { name: "typo", dialect: "postgres", files: ["db/seeds.sql"] },
      ],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toBe('source "typo": no seed file matches db/seeds.sql at revision v2');
    expect(result.findings.map((finding) => finding.id)).toEqual(["update-data", "row-added"]);
  });
});
