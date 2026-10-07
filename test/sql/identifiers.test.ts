import { describe, expect, it } from "vitest";
import { NAME_PATTERN, parseName, unescapeSqlString, unquoteIdentifier } from "../../src/sql/identifiers.js";

describe("parseName", () => {
  it("gives one key for every spelling of a Postgres table", () => {
    const keys = ['"Breeds"', 'public."Breeds"', "breeds", "PUBLIC.Breeds"].map(
      (raw) => parseName(raw, "postgres").key,
    );
    expect(new Set(keys)).toEqual(new Set(["public.breeds"]));
  });

  it("gives one key for every spelling of a SQL Server table", () => {
    const keys = ["[Breeds]", "[dbo].[Breeds]", "dbo.Breeds", "[Db].[dbo].[Breeds]"].map(
      (raw) => parseName(raw, "sqlserver").key,
    );
    expect(new Set(keys)).toEqual(new Set(["dbo.breeds"]));
  });

  it("keeps the written case and schema in the display form", () => {
    expect(parseName('notifications."NotificationBroadcasts"', "postgres")).toEqual({
      parts: ["notifications", "NotificationBroadcasts"],
      display: "notifications.NotificationBroadcasts",
      key: "notifications.notificationbroadcasts",
    });
  });

  it("unescapes doubled closing characters", () => {
    expect(parseName("[a]]b]", "sqlserver").display).toBe("a]b");
    expect(parseName('"a""b"', "postgres").display).toBe('a"b');
  });
});

describe("NAME_PATTERN", () => {
  it("matches qualified quoted names with spaces around dots", () => {
    expect(new RegExp(`^${NAME_PATTERN}$`).test('"system" . "FeatureFlags"')).toBe(true);
    expect(new RegExp(`^${NAME_PATTERN}$`).test("[dbo].[My Table]")).toBe(true);
  });
});

describe("unquoteIdentifier and unescapeSqlString", () => {
  it("strips quotes", () => {
    expect(unquoteIdentifier("`x`")).toBe("x");
    expect(unquoteIdentifier("plain")).toBe("plain");
  });

  it("returns the value of a string literal", () => {
    expect(unescapeSqlString("N'it''s'")).toBe("it's");
    expect(unescapeSqlString("'CREATE SCHEMA [system];'")).toBe("CREATE SCHEMA [system];");
  });
});
