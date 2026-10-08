import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import {
  applyPreconditions,
  parsePreconditionsOutput,
  preconditionsSchema,
} from "../../../src/layers/sql-migrations/preconditions.js";
import { sqlMigrationsLayer } from "../../../src/layers/sql-migrations/sql-migrations-layer.js";
import { parseName } from "../../../src/sql/identifiers.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

const INSERTS = 'INSERT INTO dictionaries."PetBreeds" ("Id", "Name") VALUES (418, \'a\'), (496, \'b\');';
const SETVAL = `SELECT setval(pg_get_serial_sequence('dictionaries."PetBreeds"', 'Id'), (SELECT MAX("Id") FROM dictionaries."PetBreeds"));`;

describe("parsePreconditionsOutput", () => {
  it("reads table and max id lines, empty tables, and skips everything else", () => {
    const maxIds = parsePreconditionsOutput(
      'dictionaries.PetBreeds\t417\r\n\n# comment\n"Pets"\t\nOther\tNULL\nnoise line\nBad\tx\nMore\t1\t2\n',
      "postgres",
    );
    expect([...maxIds]).toEqual([
      ["dictionaries.petbreeds", 417],
      ["public.pets", null],
      ["public.other", null],
    ]);
  });

  it("rejects an empty command and a timeout above an hour", () => {
    expect(preconditionsSchema.safeParse({ run: "" }).success).toBe(false);
    expect(preconditionsSchema.safeParse({ run: "x", timeoutSeconds: 3601 }).success).toBe(false);
  });
});

describe("applyPreconditions", () => {
  const insert = (isSequenceMoved: boolean) => ({
    migration: "0002",
    object: "T",
    finding: {
      layer: "sql-migrations",
      scope: "db",
      id: "insert-explicit-id",
      subject: "0002: T",
      class: "needs-action" as const,
      message: "m",
      evidence: [],
    },
    explicitIds: {
      table: parseName("T", "postgres"),
      ids: { column: "Id", rows: 1, range: { first: 5, last: 5 } },
      isSequenceMoved,
    },
  });

  it("keeps an insert without a sequence move needs-action, and reads an empty table as below the first id", () => {
    const items = [insert(false), insert(true)];
    applyPreconditions(items, new Map([["public.t", null]]));
    expect(items.map(({ finding }) => [finding.class, finding.message])).toEqual([
      [
        "needs-action",
        "m; production T is empty (preconditions command); the identity sequence half remains",
      ],
      ["safe", "m; production T is empty (preconditions command)"],
    ]);
  });
});

describe("sql-migrations preconditions", () => {
  let repo: TestRepo;
  let tempRoot: string;
  let base: RefTree;
  let revision: RefTree;

  beforeAll(async () => {
    repo = createRepo([
      {
        files: { "db/0001.sql": 'CREATE TABLE dictionaries."PetBreeds" ("Id" int, "Name" text);' },
        tag: "v1",
      },
      {
        files: { "db/0002.sql": `${INSERTS}\n${SETVAL}`, "plain/0001.sql": "SELECT 1;" },
        tag: "v2",
      },
    ]);
    tempRoot = await mkdtemp(join(tmpdir(), "compat-sql-preconditions-"));
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

  const run = async (run: string, path = "db") => {
    const result = await sqlMigrationsLayer.run({
      config: sqlMigrationsLayer.configSchema.parse({
        sources: [{ name: "db", dialect: "postgres", kind: "folder", path, preconditions: { run } }],
      }),
      base,
      revision,
      repoDir: repo.dir,
      tempDir: tempRoot,
      env: process.env,
      log: () => {},
    });
    if (result.status !== "ran") throw new Error(`layer status ${result.status}`);
    return result;
  };

  const HEAD =
    "inserts 2 row(s) into dictionaries.PetBreeds with explicit Id 418-496; precondition: production max(Id) < 418; the migration moves the identity sequence past them";

  const NO_BASE_IDS = "the base migrations insert no explicit ids into dictionaries.PetBreeds";

  it("turns the insert safe when production max(Id) is below the first id, reading COMPAT_TABLES", async () => {
    const result = await run(`printf '%s\\t417\\n' "$COMPAT_TABLES"`);
    expect(result.findings.map((finding) => [finding.id, finding.class, finding.message])).toEqual([
      ["insert-explicit-id", "safe", `${HEAD}; production max(Id) = 417 < 418 (preconditions command)`],
    ]);
    expect(result.notes).toContain('source "db": preconditions command listed 1 table(s)');
  });

  it("turns the insert breaking when production max(Id) reaches the first id", async () => {
    const result = await run("printf 'dictionaries.PetBreeds\\t420\\n'");
    expect(result.findings.map((finding) => [finding.class, finding.message])).toEqual([
      ["breaking", `${HEAD}; production max(Id) = 420 >= 418, the insert collides (preconditions command)`],
    ]);
  });

  it("keeps the class when the table is not listed or the command fails", async () => {
    const missing = await run("printf 'other\\t1\\n'");
    expect(missing.findings.map((finding) => [finding.class, finding.message])).toEqual([
      [
        "needs-action",
        `${HEAD}; dictionaries.PetBreeds not listed by the preconditions command; ${NO_BASE_IDS}`,
      ],
    ]);
    const failed = await run("echo secret; exit 3");
    expect(failed.findings.map((finding) => [finding.class, finding.message])).toEqual([
      ["needs-action", `${HEAD}; ${NO_BASE_IDS}`],
    ]);
    expect(failed.notes).toContain(
      'source "db": preconditions command exited 3; explicit-id inserts stay unresolved',
    );
  });

  it("does not run the command without an explicit-id insert", async () => {
    const result = await run("touch ran.txt", "plain");
    expect(result.findings).toEqual([]);
    expect(existsSync(join(repo.dir, "ran.txt"))).toBe(false);
  });
});
