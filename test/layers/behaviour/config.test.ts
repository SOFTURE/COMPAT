import { describe, expect, it } from "vitest";
import { behaviourConfigSchema, matchesTestPattern } from "../../../src/layers/behaviour/config.js";

const test = { run: "dotnet test", results: { kind: "trx", path: "**/*.trx" } };

describe("behaviour config", () => {
  it("applies the defaults of the issue", () => {
    const parsed = behaviourConfigSchema.parse({
      start: { run: "./start.sh" },
      test,
      stop: { run: "docker compose down -v" },
    });
    expect(parsed).toEqual({
      start: { side: "revision", run: "./start.sh", background: false, timeoutSeconds: 1800 },
      test: { ...test, side: "base", timeoutSeconds: 3600 },
      stop: { side: "revision", run: "docker compose down -v", timeoutSeconds: 600 },
      retries: 0,
      baseline: false,
    });
  });

  it("accepts a background start with a ready URL holding {port}", () => {
    const parsed = behaviourConfigSchema.safeParse({
      start: { run: "node app.js", background: true, ready: "http://127.0.0.1:{port}/hc" },
      test,
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["no test", { start: { run: "x" } }],
    ["an unknown results kind", { test: { ...test, results: { kind: "nunit", path: "x" } } }],
    ["a ready URL without background", { start: { run: "x", ready: "http://localhost/hc" }, test }],
    ["a ready value that is not a URL", { start: { run: "x", background: true, ready: "hc" }, test }],
    ["too many retries", { test, retries: 6 }],
    ["a zero timeout", { test: { ...test, timeoutSeconds: 0 } }],
    ["an unknown key", { test, typo: true }],
    ["an accept entry without a reason", { test, accept: [{ test: "a" }] }],
  ])("rejects %s", (_, config) => {
    expect(behaviourConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("matchesTestPattern", () => {
  it.each([
    ["Api.PetsTests.Returns_count", "Api.PetsTests.Returns_count", true],
    ["Api.PetsTests.Returns_count", "Api.PetsTests.*", true],
    ["Api.PetsTests.Returns_count", "*Returns*", true],
    ["Api.PetsTests.Returns_count", "Api.PetsTests", false],
    ["ApixPetsTests", "Api.PetsTests", false],
    ["a(b)+c", "a(b)+c", true],
  ])("%s against %s is %s", (name, pattern, expected) => {
    expect(matchesTestPattern(name, pattern)).toBe(expected);
  });
});
