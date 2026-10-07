import { describe, expect, it } from "vitest";
import {
  applyAccept,
  type ClassifiedFinding,
  classifyMigrations,
  type Migration,
} from "../../../src/layers/sql-migrations/classify.js";
import { type SqlDialect, splitStatements } from "../../../src/sql/statements.js";

const REVISION = { side: "revision" as const, ref: "v2", commit: "c".repeat(40) };

function migration(id: string, sql: string, dialect: SqlDialect = "postgres"): Migration {
  return { id, path: `db/${id}.sql`, statements: splitStatements(sql, dialect) };
}

function classify(
  migrations: Migration[],
  options: { dialect?: SqlDialect; baseTables?: string[] } = {},
): ClassifiedFinding[] {
  return classifyMigrations({
    sourceName: "app",
    dialect: options.dialect ?? "postgres",
    migrations,
    baseTables: new Set(options.baseTables ?? []),
    revision: REVISION,
  });
}

const summary = (items: ClassifiedFinding[]) =>
  items.map(({ finding }) => `${finding.id} ${finding.class} ${finding.subject}`);

describe("classifyMigrations", () => {
  it("makes indexes and foreign keys on a table created by the new migrations safe", () => {
    const items = classify([
      migration(
        "0002",
        [
          'CREATE TABLE "Flags" ("Id" uuid NOT NULL, "Key" text NOT NULL);',
          'CREATE UNIQUE INDEX "IX_Flags_Key" ON "Flags" ("Key");',
          'ALTER TABLE "Flags" ADD CONSTRAINT "FK_x" FOREIGN KEY ("Id") REFERENCES "Owners" ("Id");',
          'CREATE UNIQUE INDEX "IX_Owners_Mail" ON "Owners" ("Mail");',
        ].join("\n"),
      ),
    ]);
    expect(summary(items)).toEqual([
      "create-table safe 0002: Flags",
      "add-unique-index safe 0002: Flags",
      "add-constraint safe 0002: Flags",
      "add-unique-index needs-action 0002: Owners",
    ]);
    expect(items[1]?.finding.message).toMatch(/^on a table created by these migrations/);
    expect(items[3]?.finding.evidence).toEqual([{ ...REVISION, path: "db/0002.sql", line: 4 }]);
  });

  it("keeps a drop and recreate of an existing table breaking", () => {
    const items = classify([
      migration(
        "0002",
        'DROP TABLE "Pets";\nCREATE TABLE "Pets" ("Id" int);\nCREATE UNIQUE INDEX i ON "Pets" ("Id");',
      ),
    ]);
    expect(summary(items)).toEqual([
      "drop-table breaking 0002: Pets",
      "create-table safe 0002: Pets",
      "add-unique-index needs-action 0002: Pets",
    ]);
  });

  it("does not treat CREATE TABLE IF NOT EXISTS of a base table as new", () => {
    const sql = 'CREATE TABLE IF NOT EXISTS "Pets" ("Id" int);\nCREATE UNIQUE INDEX i ON "Pets" ("Id");';
    expect(summary(classify([migration("0002", sql)], { baseTables: ["public.pets"] }))[1]).toBe(
      "add-unique-index needs-action 0002: Pets",
    );
    expect(summary(classify([migration("0002", sql)]))[1]).toBe("add-unique-index safe 0002: Pets");
  });

  it("follows a rename of a table created by the new migrations", () => {
    const items = classify([
      migration("0002", 'CREATE TABLE "a" ("id" int);'),
      migration("0003", 'ALTER TABLE "a" RENAME TO "b";\nCREATE UNIQUE INDEX i ON "b" ("id");'),
    ]);
    expect(summary(items)).toEqual([
      "create-table safe 0002: a",
      "rename-table safe 0003: a",
      "add-unique-index safe 0003: b",
    ]);
  });

  it("reports a dropped view that is created again as a redefinition", () => {
    const items = classify([
      migration("0002", "DROP VIEW v_pets;\nCREATE OR REPLACE VIEW v_pets AS SELECT 1;\nDROP VIEW v_old;"),
    ]);
    expect(summary(items)).toEqual([
      "object-redefined needs-action 0002: v_pets",
      "drop-object breaking 0002: v_old",
    ]);
  });

  it("merges single-row explicit-id inserts into one finding per migration and table", () => {
    const sql = [1, 2, 3]
      .map((id) => `INSERT INTO "Breeds" ("Id", "Name") VALUES (${id}, 'b${id}');`)
      .join("\n");
    const items = classify([
      migration("0002", sql),
      migration("0003", 'INSERT INTO "Breeds" ("Id") VALUES (9);'),
    ]);
    expect(summary(items)).toEqual([
      "insert-explicit-id needs-action 0002: Breeds",
      "insert-explicit-id needs-action 0003: Breeds",
    ]);
    expect(items[0]?.finding.message).toContain("inserts 3 row(s) into Breeds with explicit Id 1-3");
    expect(items[0]?.finding.evidence[0]?.line).toBe(1);
  });

  it("applies IDENTITY_INSERT only within the same migration", () => {
    const identity = migration(
      "A",
      "IF EXISTS (SELECT * FROM [sys].[identity_columns] WHERE [object_id] = OBJECT_ID(N'[Breeds]'))\n    SET IDENTITY_INSERT [Breeds] ON;\nINSERT INTO [Breeds] ([No]) VALUES (1);",
      "sqlserver",
    );
    const later = migration("B", "INSERT INTO [Breeds] ([No]) VALUES (2);", "sqlserver");
    expect(summary(classify([identity, later], { dialect: "sqlserver" }))).toEqual([
      "insert-explicit-id needs-action A: Breeds",
    ]);
  });

  it("reports nested EXEC statements at the line of the EXEC", () => {
    const items = classify(
      [
        migration(
          "A",
          "SELECT 1;\nIF SCHEMA_ID(N'system') IS NULL EXEC(N'CREATE SCHEMA [system];\nDROP TABLE [x];');",
          "sqlserver",
        ),
      ],
      { dialect: "sqlserver" },
    );
    expect(items.map(({ finding }) => [finding.id, finding.evidence[0]?.line])).toEqual([
      ["create-schema", 2],
      ["drop-table", 2],
    ]);
  });

  it("matches statements inside a drizzle DO block at their own line", () => {
    const sql = [
      'CREATE TABLE "a" ("id" serial);',
      "--> statement-breakpoint",
      "DO $$ BEGIN",
      ' ALTER TABLE "b" ADD CONSTRAINT "fk" FOREIGN KEY ("a_id") REFERENCES "a"("id");',
      "EXCEPTION",
      " WHEN duplicate_object THEN null;",
      "END $$;",
    ].join("\n");
    const items = classify([migration("0002", sql)]);
    expect(items.map(({ finding }) => [finding.id, finding.class, finding.evidence[0]?.line])).toEqual([
      ["create-table", "safe", 1],
      ["add-constraint", "needs-action", 4],
    ]);
  });

  it("reads EF Npgsql EnsureSchema inside a guard body", () => {
    const body =
      "IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'system') THEN\n    CREATE SCHEMA system;\nEND IF;";
    expect(summary(classify([migration("Init", body)]))).toEqual(["create-schema safe Init: system"]);
  });
});

describe("applyAccept", () => {
  const items = classify([
    migration("0002", 'ALTER TABLE "Pets" DROP COLUMN "A";\nALTER TABLE "Pets" DROP COLUMN "B";'),
  ]);

  it("accepts by rule and migration, keeping the class", () => {
    const { findings, usage } = applyAccept(items, [
      { id: "drop-column", migration: "0002", reason: "unused since 2.1" },
    ]);
    expect(findings.map((finding) => [finding.class, finding.accepted?.reason])).toEqual([
      ["breaking", "unused since 2.1"],
      ["breaking", "unused since 2.1"],
    ]);
    expect(usage[0]?.count).toBe(2);
  });

  it("narrows by object, case-insensitively, and reports unused entries", () => {
    const { findings, usage } = applyAccept(items, [
      { id: "drop-column", migration: "0002", object: "pets.a", reason: "r" },
      { id: "drop-column", migration: "0003", reason: "wrong migration" },
    ]);
    expect(findings.map((finding) => finding.accepted !== undefined)).toEqual([true, false]);
    expect(usage.map(({ count }) => count)).toEqual([1, 0]);
  });
});
