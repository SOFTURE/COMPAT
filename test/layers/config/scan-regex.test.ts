import { describe, expect, it } from "vitest";
import { compilePattern } from "../../../src/layers/config/config.js";
import { scanRegex } from "../../../src/layers/config/scan-regex.js";

describe("scanRegex", () => {
  it("reads keys and optional defaults with line numbers", () => {
    const regex = /Get(?:Required)?\("(?<key>[^"]+)"(?:,\s*(?<default>"[^"]*"))?\)/g;
    const text =
      'var a = GetRequired("Shop__BaseUrl");\n\nvar b = Get("Shop__Timeout", "30");\nvar c = Get("Empty", "");';
    expect(scanRegex(text, { regex, comments: "none" })).toEqual([
      { key: "Shop__BaseUrl", line: 1, default: null },
      { key: "Shop__Timeout", line: 3, default: '"30"' },
      { key: "Empty", line: 4, default: '""' },
    ]);
  });

  it("strips comments of the configured style before matching", () => {
    const regex = /Require\("(?<key>[^"]+)"\)/g;
    const text = 'Require("A");\n// Require("B");\n/* Require("C"); */ Require("D");';
    expect(scanRegex(text, { regex, comments: "slash" }).map((d) => d.key)).toEqual(["A", "D"]);
    expect(scanRegex(text, { regex, comments: "none" }).map((d) => d.key)).toEqual(["A", "B", "C", "D"]);
  });

  it("matches Ansible assert lines with hash comments", () => {
    const regex = /^\s*-\s*app_env\.(?<key>\w+) is defined/gm;
    const text = "that:\n  - app_env.Shop__BaseUrl is defined\n  # - app_env.Legacy is defined\n";
    expect(scanRegex(text, { regex, comments: "hash" })).toEqual([
      { key: "Shop__BaseUrl", line: 2, default: null },
    ]);
  });

  it("reports the line of the key when the match starts on an earlier line", () => {
    const compiled = compilePattern("^\\s*-\\s*app_env\\.(?<key>\\w+) is defined", "m");
    if (!("regex" in compiled)) throw new Error(compiled.error);
    const text = "that:\n\n  - app_env.A is defined\n";
    expect(scanRegex(text, { regex: compiled.regex, comments: "none" })).toEqual([
      { key: "A", line: 3, default: null },
    ]);
  });

  it("skips matches with an empty or whitespace key", () => {
    expect(scanRegex("k= ;k=x;", { regex: /k=(?<key>[^;]*);/g, comments: "none" })).toEqual([
      { key: "x", line: 1, default: null },
    ]);
  });

  it("does not hang on a pattern that matches the empty string", () => {
    expect(scanRegex("abc", { regex: /(?<key>x*)/g, comments: "none" })).toEqual([]);
  });

  it("builds a key from a template over several groups of one match", () => {
    const regex = /Get\("(?<section>\w+)", "(?<member>\w+)"\)/dg;
    const text = 'x;\nGet("Shop", "BaseUrl")';
    expect(scanRegex(text, { regex, comments: "none", key: "{section}__{member}" })).toEqual([
      { key: "Shop__BaseUrl", line: 2, default: null },
    ]);
  });

  it("takes a template group from the nearest enclosing match before the key", () => {
    const regex = /public required \w+ (?<member>\w+) \{/dg;
    const enclosing = /class (?<section>\w+?)Settings\b/dg;
    const text = [
      "public required string Orphan { get; }",
      "class ShopSettings {",
      "  public required string BaseUrl { get; }",
      "}",
      "class PaymentSettings {",
      "  public required string BaseUrl { get; }",
      "}",
    ].join("\n");
    expect(scanRegex(text, { regex, enclosing, comments: "none", key: "{section}__{member}" })).toEqual([
      { key: "__Orphan", line: 1, default: null },
      { key: "Shop__BaseUrl", line: 3, default: null },
      { key: "Payment__BaseUrl", line: 6, default: null },
    ]);
  });

  it("prefers a group of the match itself over the same group of the enclosing match", () => {
    const regex = /(?:(?<section>\w+):)?(?<member>\w+)=/dg;
    const enclosing = /\[(?<section>\w+)\]/dg;
    const text = "[Shop]\nBaseUrl=\nPayment:Key=";
    expect(
      scanRegex(text, { regex, enclosing, comments: "none", key: "{section}__{member}" }).map((d) => d.key),
    ).toEqual(["Shop__BaseUrl", "Payment__Key"]);
  });
});
