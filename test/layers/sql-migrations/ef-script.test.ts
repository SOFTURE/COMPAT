import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEfScript } from "../../../src/layers/sql-migrations/ef-script.js";

const fixture = (path: string) =>
  readFileSync(new URL(`../../fixtures/sql-migrations/${path}`, import.meta.url), "utf8");
const HISTORY = "__EFMigrationsHistory";

describe("parseEfScript", () => {
  it.each([
    ["postgres", "ef-postgres/revision.sql"],
    ["sqlserver", "ef-sqlserver/revision.sql"],
  ] as const)("gathers %s migrations in script order without bookkeeping", (dialect, path) => {
    const text = fixture(path);
    const parsed = parseEfScript(text, dialect, HISTORY);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.map((migration) => migration.id)).toEqual([
      "20260901000000_Init",
      "20261001000000_AddFeatureFlags",
      "20261002000000_AddNotificationBroadcasts",
      "20261005073152_AddMissingPetBreeds",
    ]);
    const statements = parsed.value.flatMap((migration) => migration.statements);
    expect(statements.some((statement) => statement.sql.includes(HISTORY))).toBe(false);
    const lines = text.split("\n");
    for (const statement of statements) {
      expect(lines[statement.line - 1]?.trim().startsWith(statement.sql.split("\n")[0]?.trim() ?? "")).toBe(
        true,
      );
    }
  });

  it("reads a one-line SqlServer guard and a custom history table", () => {
    const text = [
      "IF NOT EXISTS(SELECT * FROM [dbo].[Migrations] WHERE [MigrationId] = N'A')",
      "BEGIN",
      "    DROP TABLE [Old];",
      "END;",
      "GO",
    ].join("\n");
    expect(parseEfScript(text, "sqlserver", "Migrations")).toEqual({
      ok: true,
      value: [{ id: "A", statements: [{ sql: "DROP TABLE [Old]", line: 3, offset: text.indexOf("DROP") }] }],
    });
  });

  it("returns no migrations for an empty script", () => {
    expect(parseEfScript(" \n", "postgres", HISTORY)).toEqual({ ok: true, value: [] });
  });

  it("fails when the script has no guard", () => {
    const parsed = parseEfScript("CREATE TABLE a (id int);", "postgres", HISTORY);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("--idempotent");
  });

  it("fails for a script of the other dialect", () => {
    expect(parseEfScript(fixture("ef-sqlserver/base.sql"), "postgres", HISTORY).ok).toBe(false);
  });
});
