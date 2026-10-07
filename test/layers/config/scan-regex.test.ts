import { describe, expect, it } from "vitest";
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

  it("skips matches with an empty or whitespace key", () => {
    expect(scanRegex("k= ;k=x;", { regex: /k=(?<key>[^;]*);/g, comments: "none" })).toEqual([
      { key: "x", line: 1, default: null },
    ]);
  });

  it("does not hang on a pattern that matches the empty string", () => {
    expect(scanRegex("abc", { regex: /(?<key>x*)/g, comments: "none" })).toEqual([]);
  });
});
