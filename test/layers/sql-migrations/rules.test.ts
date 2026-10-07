import { describe, expect, it } from "vitest";
import {
  matchStatement,
  RULE_CLASSES,
  type StatementMatch,
} from "../../../src/layers/sql-migrations/rules.js";
import type { SqlDialect } from "../../../src/sql/statements.js";

const NO_CONTEXT = { identityInsertTables: new Set<string>() };

function summarize(matches: StatementMatch[]): string[] {
  return matches.map((match) => {
    if (match.kind === "rule") return `${match.rule} ${match.class} ${match.object}`;
    if (match.kind === "identity-insert") return `identity-insert ${match.table.display}`;
    return `nested ${match.sql.trim()}`;
  });
}

const match = (sql: string, dialect: SqlDialect = "postgres", context = NO_CONTEXT) =>
  summarize(matchStatement(sql, dialect, context));

describe("matchStatement rules", () => {
  const cases: [SqlDialect, string, string[]][] = [
    ["postgres", "CREATE SCHEMA IF NOT EXISTS system", ["create-schema safe system"]],
    ["sqlserver", "CREATE SCHEMA [system]", ["create-schema safe system"]],
    [
      "postgres",
      'CREATE TABLE system."FeatureFlags" ("Id" uuid NOT NULL)',
      ["create-table safe system.FeatureFlags"],
    ],
    ["postgres", 'CREATE UNLOGGED TABLE IF NOT EXISTS "Cache" (k text)', ["create-table safe Cache"]],
    ["postgres", 'ALTER TABLE "Pets" ADD "Note" text', ["add-column safe Pets.Note"]],
    ["postgres", 'ALTER TABLE "Pets" ADD "Rank" integer NOT NULL DEFAULT 0', ["add-column safe Pets.Rank"]],
    [
      "postgres",
      "ALTER TABLE pets ADD COLUMN IF NOT EXISTS id2 bigserial NOT NULL",
      ["add-column safe pets.id2"],
    ],
    ["sqlserver", "ALTER TABLE [Pets] ADD [Rank] int NOT NULL DEFAULT 0", ["add-column safe Pets.Rank"]],
    ["sqlserver", "ALTER TABLE [Pets] ADD [Total] AS ([A] + [B])", ["add-column safe Pets.Total"]],
    ["postgres", 'ALTER TABLE "Pets" ADD "Owner" text NOT NULL', ["add-required-column breaking Pets.Owner"]],
    [
      "sqlserver",
      "ALTER TABLE [X] ADD [a] int NULL, [b] int NOT NULL",
      ["add-column safe X.a", "add-required-column breaking X.b"],
    ],
    ["postgres", 'CREATE INDEX "IX_Pets_Name" ON "Pets" ("Name")', ["create-index safe Pets"]],
    ["postgres", "CREATE INDEX CONCURRENTLY ON ONLY pets (name)", ["create-index safe pets"]],
    [
      "sqlserver",
      "CREATE UNIQUE NONCLUSTERED INDEX [IX_Pets_Chip] ON [Pets] ([Chip]) WHERE [Chip] IS NOT NULL",
      ["add-unique-index needs-action Pets"],
    ],
    [
      "postgres",
      'ALTER TABLE "Pets" ADD CONSTRAINT "FK_Pets_Owners" FOREIGN KEY ("OwnerId") REFERENCES "Owners" ("Id")',
      ["add-constraint needs-action Pets"],
    ],
    [
      "sqlserver",
      "ALTER TABLE [Pets] WITH CHECK ADD CONSTRAINT [FK_Pets_Owners] FOREIGN KEY ([OwnerId]) REFERENCES [Owners] ([Id])",
      ["add-constraint needs-action Pets"],
    ],
    ["postgres", "ALTER TABLE pets ADD UNIQUE (chip)", ["add-constraint needs-action pets"]],
    ["sqlserver", "ALTER TABLE [Pets] ADD DEFAULT N'' FOR [Name]", []],
    ["sqlserver", "ALTER TABLE [Pets] ADD CONSTRAINT [DF_Pets_Rank] DEFAULT 0 FOR [Rank]", []],
    ["postgres", 'DROP TABLE "Legacy"', ["drop-table breaking Legacy"]],
    ["postgres", "DROP TABLE IF EXISTS a, b.c", ["drop-table breaking a", "drop-table breaking b.c"]],
    ["postgres", 'ALTER TABLE "Pets" DROP COLUMN "Old"', ["drop-column breaking Pets.Old"]],
    ["postgres", "ALTER TABLE pets DROP IF EXISTS old", ["drop-column breaking pets.old"]],
    [
      "sqlserver",
      "ALTER TABLE [Pets] DROP COLUMN [A], [B]",
      ["drop-column breaking Pets.A", "drop-column breaking Pets.B"],
    ],
    ["sqlserver", "ALTER TABLE [Pets] DROP CONSTRAINT [FK_x]", []],
    ["postgres", "DROP VIEW IF EXISTS report.v_pets", ["drop-object breaking report.v_pets"]],
    ["sqlserver", "DROP PROCEDURE [dbo].[GetPets]", ["drop-object breaking dbo.GetPets"]],
    ["postgres", 'ALTER TABLE "Pets" RENAME TO "Animals"', ["rename-table breaking Pets"]],
    ["sqlserver", "EXEC sp_rename N'[Pets]', N'Animals', N'OBJECT'", ["rename-table breaking Pets"]],
    ["sqlserver", "EXEC sp_rename N'[Pets]', N'Animals'", ["rename-table breaking Pets"]],
    ["sqlserver", "EXEC sp_rename N'[PK_Pets]', N'PK_Animals'", []],
    ["sqlserver", "EXEC sp_rename N'[Pets].[MyIndex]', N'Other', N'INDEX'", []],
    ["postgres", 'ALTER TABLE "Pets" RENAME COLUMN "Url" TO "Address"', ["rename-column breaking Pets.Url"]],
    ["postgres", 'ALTER TABLE "Pets" RENAME CONSTRAINT "a" TO "b"', []],
    [
      "sqlserver",
      "EXEC sp_rename N'[Pets].[Url]', N'Address', N'COLUMN'",
      ["rename-column breaking Pets.Url"],
    ],
    ["postgres", "ALTER TABLE pets SET SCHEMA archive", ["move-table breaking pets"]],
    ["sqlserver", "ALTER SCHEMA [archive] TRANSFER [dbo].[Pets]", ["move-table breaking dbo.Pets"]],
    [
      "postgres",
      'ALTER TABLE "Pets" ALTER COLUMN "Age" TYPE bigint',
      ["change-column-type breaking Pets.Age"],
    ],
    ["postgres", "ALTER TABLE pets ALTER age SET DATA TYPE bigint", ["change-column-type breaking pets.age"]],
    [
      "sqlserver",
      "ALTER TABLE [Pets] ALTER COLUMN [Name] nvarchar(max) NOT NULL",
      ["alter-column breaking Pets.Name"],
    ],
    ["sqlserver", "ALTER TABLE [Pets] ALTER COLUMN [Name] ADD ROWGUIDCOL", []],
    ["postgres", 'ALTER TABLE "Pets" ALTER COLUMN "Name" SET NOT NULL', ["set-not-null breaking Pets.Name"]],
    [
      "postgres",
      'ALTER TABLE "Pets" ALTER COLUMN "Name" DROP NOT NULL',
      ["drop-not-null rollback-risk Pets.Name"],
    ],
    [
      "postgres",
      'ALTER TABLE "Pets" ALTER COLUMN "Name" DROP DEFAULT',
      ["drop-default needs-action Pets.Name"],
    ],
    ["postgres", "ALTER TABLE pets ALTER COLUMN name SET DEFAULT ''", []],
    ["postgres", "ALTER TYPE mood ADD VALUE 'meh'", ["enum-value-added rollback-risk mood"]],
    ["postgres", "ALTER TYPE mood RENAME VALUE 'sad' TO 'blue'", ["enum-value-renamed breaking mood"]],
    ["postgres", "TRUNCATE TABLE ONLY pets", ["truncate breaking pets"]],
    ["sqlserver", "TRUNCATE TABLE [Pets]", ["truncate breaking Pets"]],
    ["postgres", 'UPDATE "Pets" SET "Rank" = 0 WHERE "Rank" IS NULL', ["update-data needs-action Pets"]],
    ["sqlserver", "UPDATE TOP (100) [Pets] SET [Rank] = 0", ["update-data needs-action Pets"]],
    ["postgres", 'DELETE FROM "Pets" WHERE "Id" = 1', ["delete-data needs-action Pets"]],
    ["sqlserver", "DELETE [Pets] WHERE [Id] = 1", ["delete-data needs-action Pets"]],
    [
      "sqlserver",
      "MERGE INTO [Pets] AS t USING s ON t.Id = s.Id WHEN MATCHED THEN UPDATE SET Name = s.Name",
      ["merge-data needs-action Pets"],
    ],
    [
      "postgres",
      'ALTER TABLE "Pets" ADD "A" text, DROP COLUMN "B", ALTER COLUMN "C" SET NOT NULL',
      ["add-column safe Pets.A", "drop-column breaking Pets.B", "set-not-null breaking Pets.C"],
    ],
    ["postgres", 'CREATE VIEW "v" AS SELECT 1', []],
    ["postgres", "SELECT 1", []],
    ["postgres", "SELECT setval('\"Breeds_Id_seq\"', 496)", []],
    ["postgres", "START TRANSACTION", []],
    ["postgres", "END IF", []],
  ];

  it.each(cases)("%s: %s", (dialect, sql, expected) => {
    expect(match(sql, dialect)).toEqual(expected);
  });

  it("covers every rule id except the merged and derived ones", () => {
    const covered = new Set(cases.flatMap(([, , expected]) => expected.map((line) => line.split(" ")[0])));
    const derived = new Set(["insert-explicit-id", "object-redefined"]);
    expect(Object.keys(RULE_CLASSES).filter((id) => !covered.has(id) && !derived.has(id))).toEqual([]);
  });
});

describe("matchStatement explicit ids", () => {
  it("reads the id range of a multi-row insert", () => {
    const [found] = matchStatement(
      "INSERT INTO \"Breeds\" (\"Id\", \"Name\") VALUES (418, 'A'), (419, 'B, c'), (496, 'Z')",
      "postgres",
      NO_CONTEXT,
    );
    expect(found).toMatchObject({
      kind: "rule",
      rule: "insert-explicit-id",
      class: "needs-action",
      explicitIds: { column: "Id", values: ["418", "419", "496"] },
    });
    expect(found?.kind === "rule" && found.message).toContain("max(Id) < 418");
  });

  it("states a precondition without a range for uuid ids", () => {
    const [found] = matchStatement(
      "INSERT INTO pets (id, name) VALUES ('7c9e6679-7425-40de-944b-e07fc1f90ae7', 'x')",
      "postgres",
      NO_CONTEXT,
    );
    expect(found?.kind === "rule" && found.message).toContain("explicit id values");
  });

  it("is silent for an insert without an id column", () => {
    expect(match("INSERT INTO pets (name) VALUES ('x')")).toEqual([]);
  });

  it("uses IDENTITY_INSERT when the id column is not called id", () => {
    const context = { identityInsertTables: new Set(["dbo.breeds"]) };
    expect(match("INSERT INTO [Breeds] ([BreedNo], [Name]) VALUES (1, N'x')", "sqlserver", context)).toEqual([
      "insert-explicit-id needs-action Breeds",
    ]);
  });

  it("reads ids of INSERT ... SELECT as unknown", () => {
    const [found] = matchStatement(
      "INSERT INTO pets (id, name) SELECT id, name FROM old",
      "postgres",
      NO_CONTEXT,
    );
    expect(found).toMatchObject({ explicitIds: { column: "id", values: null } });
  });
});

describe("matchStatement wrappers", () => {
  it("finds a conditional IDENTITY_INSERT", () => {
    const sql =
      "IF EXISTS (SELECT * FROM [sys].[identity_columns] WHERE [name] IN (N'Id', N'Name') AND [object_id] = OBJECT_ID(N'[Breeds]'))\n    SET IDENTITY_INSERT [Breeds] ON";
    expect(match(sql, "sqlserver")).toEqual(["identity-insert Breeds"]);
  });

  it("unwraps an EXEC literal behind an IF condition", () => {
    const [nested] = matchStatement(
      "IF SCHEMA_ID(N'system') IS NULL EXEC(N'CREATE SCHEMA [system];')",
      "sqlserver",
      NO_CONTEXT,
    );
    expect(nested).toEqual({ kind: "nested", sql: "EXEC(N'CREATE SCHEMA [system];')", offset: 32 });
    expect(match("EXEC(N'CREATE SCHEMA [system];')", "sqlserver")).toEqual([
      "nested CREATE SCHEMA [system];",
    ]);
  });

  it("unwraps a multi-line EXEC literal with escaped quotes", () => {
    expect(match("EXEC(N'INSERT INTO [Breeds] ([Id], [Name])\nVALUES (418, N''X'')')", "sqlserver")).toEqual([
      "nested INSERT INTO [Breeds] ([Id], [Name])\nVALUES (418, N'X')",
    ]);
  });

  it("leaves concatenated dynamic SQL alone", () => {
    const sql = "IF @var0 IS NOT NULL EXEC(N'ALTER TABLE [Pets] DROP CONSTRAINT [' + @var0 + '];')";
    expect(matchStatement(sql, "sqlserver", NO_CONTEXT)).toEqual([
      { kind: "nested", sql: "EXEC(N'ALTER TABLE [Pets] DROP CONSTRAINT [' + @var0 + '];')", offset: 21 },
    ]);
    expect(match("EXEC(N'ALTER TABLE [Pets] DROP CONSTRAINT [' + @var0 + '];')", "sqlserver")).toEqual([]);
  });

  it("unwraps a T-SQL IF with a BEGIN block", () => {
    expect(match("IF OBJECT_ID(N'[x]') IS NULL BEGIN CREATE TABLE [x] ([id] int)", "sqlserver")).toEqual([
      "nested CREATE TABLE [x] ([id] int)",
    ]);
  });

  it("unwraps a PL/pgSQL IF ... THEN", () => {
    expect(
      match(
        "IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'system') THEN\n        CREATE SCHEMA system",
      ),
    ).toEqual(["nested CREATE SCHEMA system"]);
  });

  it("unwraps the body of a drizzle DO block up to EXCEPTION", () => {
    const sql =
      'DO $$ BEGIN\n ALTER TABLE "a" ADD CONSTRAINT "fk" FOREIGN KEY ("b") REFERENCES "b"("id");\nEXCEPTION\n WHEN duplicate_object THEN null;\nEND $$';
    expect(match(sql)).toEqual([
      'nested ALTER TABLE "a" ADD CONSTRAINT "fk" FOREIGN KEY ("b") REFERENCES "b"("id");',
    ]);
  });
});
