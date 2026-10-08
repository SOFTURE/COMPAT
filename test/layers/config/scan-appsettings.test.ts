import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLACEHOLDER,
  readSettingLeaves,
  toDeclarations,
} from "../../../src/layers/config/scan-appsettings.js";

describe("readSettingLeaves", () => {
  it("reads leaves as .NET configuration paths with their lines, arrays by index", () => {
    const text = [
      "{",
      "  // comment",
      '  "Stripe": {',
      '    "SecretKey": "sk",',
      '    "Plans": [ { "ProductId": "p1" }, "p2" ],',
      "    /* block",
      "       comment */",
      '    "Retries": 3,',
      '    "Enabled": true,',
      '    "Missing": null,',
      "  },",
      '  "Empty": {}',
      "}",
    ].join("\n");
    expect(readSettingLeaves(text)).toEqual([
      { key: "Stripe:SecretKey", line: 4, value: "sk" },
      { key: "Stripe:Plans:0:ProductId", line: 5, value: "p1" },
      { key: "Stripe:Plans:1", line: 5, value: "p2" },
      { key: "Stripe:Retries", line: 8, value: "3" },
      { key: "Stripe:Enabled", line: 9, value: "true" },
      { key: "Stripe:Missing", line: 10, value: null },
    ]);
  });

  it("returns null for text that is not JSON", () => {
    expect(readSettingLeaves('{ "a": }')).toBeNull();
    expect(readSettingLeaves('{ "a": 1 } x')).toBeNull();
    expect(readSettingLeaves('{ "a": "open')).toBeNull();
  });
});

describe("toDeclarations", () => {
  it("gives no default to a placeholder, an empty value or null, and keeps every other value", () => {
    const placeholder = new RegExp(DEFAULT_PLACEHOLDER, "i");
    const declarations = toDeclarations(
      [
        { key: "A", line: 1, value: "sk_test_placeholder_set_in_user_secrets" },
        { key: "B", line: 2, value: "set-via-env-Shop__ApiKey" },
        { key: "C", line: 3, value: "ChangeMe" },
        { key: "D", line: 4, value: "" },
        { key: "E", line: 5, value: null },
        { key: "F", line: 6, value: "https://example.test" },
      ],
      placeholder,
    );
    expect(declarations.map((declaration) => declaration.default)).toEqual([
      null,
      null,
      null,
      null,
      null,
      "https://example.test",
    ]);
  });
});
