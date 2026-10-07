import { describe, expect, it } from "vitest";
import { matchesGlob } from "../../src/git/glob.js";

describe("matchesGlob", () => {
  it.each([
    ["openapi.yaml", "openapi.yaml", true],
    ["api/openapi.yaml", "*.yaml", false],
    ["api/openapi.yaml", "**/*.yaml", true],
    ["openapi.yaml", "**/*.yaml", true],
    ["db/migrations/0001_init.sql", "db/migrations/*.sql", true],
    ["db/migrations/sub/0001.sql", "db/migrations/*.sql", false],
    ["db/migrations/sub/0001.sql", "db/**/*.sql", true],
    ["a.json", "a.{json,yaml}", true],
    ["a.yml", "a.{json,yaml}", false],
    ["a1.sql", "a?.sql", true],
    ["a+b.sql", "a+b.sql", true],
    ["axb.sql", "a.b.sql", false],
  ])("%s against %s is %s", (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });
});
