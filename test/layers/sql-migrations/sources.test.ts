import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { type MigrationSource, sourceSchema } from "../../../src/layers/sql-migrations/config.js";
import { readSourceChanges } from "../../../src/layers/sql-migrations/sources.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

const EF_BLOCK = (id: string, sql: string) =>
  `DO $EF$\nBEGIN\n    IF NOT EXISTS(SELECT 1 FROM "__EFMigrationsHistory" WHERE "MigrationId" = '${id}') THEN\n    ${sql}\n    END IF;\nEND $EF$;\n`;

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    {
      files: {
        "drizzle/0000_init.sql": 'CREATE TABLE "pets" ("id" serial);',
        "drizzle/0001_edit.sql": 'ALTER TABLE "pets" ADD "a" text;',
        "drizzle/0002_gone.sql": 'ALTER TABLE "pets" ADD "b" text;',
        "drizzle/meta/_journal.json": "{}",
        "db/ef.sql": EF_BLOCK("A", 'CREATE TABLE "Breeds" ("Id" int);') + EF_BLOCK("B", "SELECT 1;"),
      },
      tag: "v1",
    },
    {
      files: {
        "drizzle/0001_edit.sql": 'ALTER TABLE "pets" ADD "a" varchar(10);',
        "drizzle/0002_gone.sql": null,
        "drizzle/0003_new.sql": 'ALTER TABLE "pets" DROP COLUMN "a";',
        "db/ef.sql":
          EF_BLOCK("A", 'CREATE TABLE "Breeds" ("Id" int);') +
          EF_BLOCK("C", 'DROP TABLE "Breeds";') +
          'TRUNCATE "Pets";\n',
        "db/new-ef.sql": EF_BLOCK("X", "SELECT 1;"),
      },
      tag: "v2",
    },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-sql-sources-"));
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

const source = (config: object): MigrationSource =>
  sourceSchema.parse({ name: "s", dialect: "postgres", ...config });

describe("readSourceChanges", () => {
  it("reads new, edited and removed folder migrations", async () => {
    const changes = await readSourceChanges({
      source: source({ kind: "folder", path: "drizzle/" }),
      base,
      revision,
    });
    if (!changes.ok) throw new Error(changes.error);
    expect(
      changes.value.newMigrations.map((migration) => [
        migration.id,
        migration.path,
        migration.statements.length,
      ]),
    ).toEqual([["0003_new.sql", "drizzle/0003_new.sql", 1]]);
    expect(changes.value.changed).toEqual([
      { kind: "modified", migration: "0001_edit.sql", path: "drizzle/0001_edit.sql", side: "revision" },
      { kind: "removed", migration: "0002_gone.sql", path: "drizzle/0002_gone.sql", side: "base" },
    ]);
    expect([...changes.value.baseTables]).toEqual(["public.pets"]);
  });

  it("fails when no file matches at the revision", async () => {
    const changes = await readSourceChanges({
      source: source({ kind: "folder", path: "migrations" }),
      base,
      revision,
    });
    expect(changes).toEqual({
      ok: false,
      error: "no migration file matches migrations/**/*.sql at revision v2",
    });
  });

  it("reads new and removed EF migrations by id", async () => {
    const changes = await readSourceChanges({
      source: source({ kind: "ef-script", path: "db/ef.sql" }),
      base,
      revision,
    });
    if (!changes.ok) throw new Error(changes.error);
    expect(
      changes.value.newMigrations.map((migration) => [migration.id, migration.statements.map((s) => s.sql)]),
    ).toEqual([
      ["C", ['DROP TABLE "Breeds"']],
      ["(outside migration guards)", ['TRUNCATE "Pets"']],
    ]);
    expect(changes.value.changed).toEqual([
      { kind: "removed", migration: "B", path: "db/ef.sql", side: "base" },
    ]);
    expect([...changes.value.baseTables]).toEqual(["public.breeds"]);
  });

  it("treats every migration as new when the EF script is new", async () => {
    const changes = await readSourceChanges({
      source: source({ kind: "ef-script", path: "db/new-ef.sql" }),
      base,
      revision,
    });
    expect(changes.ok && changes.value.newMigrations.map((migration) => migration.id)).toEqual(["X"]);
  });

  it("fails when the EF script is missing at the revision", async () => {
    const changes = await readSourceChanges({
      source: source({ kind: "ef-script", path: "db/none.sql" }),
      base,
      revision,
    });
    expect(changes).toEqual({ ok: false, error: "EF script db/none.sql does not exist at revision v2" });
  });

  it("fails when the EF script has no guard", async () => {
    const changes = await readSourceChanges({
      source: source({ kind: "ef-script", path: "drizzle/0003_new.sql" }),
      base,
      revision,
    });
    expect(!changes.ok && changes.error).toMatch(
      /^drizzle\/0003_new\.sql at revision v2: no EF Core migration guard/,
    );
  });
});
