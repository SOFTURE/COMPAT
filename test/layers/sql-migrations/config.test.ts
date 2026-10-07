import { describe, expect, it } from "vitest";
import { sqlMigrationsConfigSchema } from "../../../src/layers/sql-migrations/config.js";

const parse = (config: unknown) => sqlMigrationsConfigSchema.safeParse(config);
const folder = (extra: object = {}) => ({
  name: "app",
  dialect: "postgres",
  kind: "folder",
  path: "drizzle",
  ...extra,
});

describe("sql-migrations config", () => {
  it("accepts both source kinds and fills defaults", () => {
    const parsed = parse({
      sources: [folder(), { name: "ef", dialect: "sqlserver", kind: "ef-script", path: "db/migrations.sql" }],
    });
    expect(parsed.success && parsed.data.sources).toEqual([
      { ...folder(), include: ["**/*.sql"] },
      {
        name: "ef",
        dialect: "sqlserver",
        kind: "ef-script",
        path: "db/migrations.sql",
        historyTable: "__EFMigrationsHistory",
      },
    ]);
  });

  it("normalises a trailing slash and the repository root", () => {
    const parsed = parse({ sources: [folder({ path: "db/" }), folder({ name: "root", path: "." })] });
    expect(parsed.success && parsed.data.sources.map((source) => source.path)).toEqual(["db", ""]);
  });

  it.each([
    ["an unknown kind", { sources: [folder({ kind: "liquibase" })] }],
    ["an unknown dialect", { sources: [folder({ dialect: "mysql" })] }],
    ["duplicate names", { sources: [folder(), folder()] }],
    ["a parent path", { sources: [folder({ path: "../other" })] }],
    ["an absolute path", { sources: [folder({ path: "/etc" })] }],
    ["a parent glob", { sources: [folder({ include: ["../*.sql"] })] }],
    [
      "a nested typo",
      { sources: [folder({ accept: [{ id: "drop-column", migration: "0001.sql", reson: "x" }] })] },
    ],
    ["a top-level typo", { source: [folder()] }],
    ["no sources", { sources: [] }],
  ])("rejects %s", (_name, config) => {
    expect(parse(config).success).toBe(false);
  });
});
