import { describe, expect, it } from "vitest";
import { scanDotenv } from "../../../src/layers/config/scan-dotenv.js";

const text = [
  "# Shop settings",
  "Shop__BaseUrl=https://shop.example.com#anchor",
  "export Shop__ApiKey=",
  'QUOTED="a # b"',
  "SINGLE='x'",
  "INLINE=value # comment",
  "# OLD_KEY=1",
  "not an assignment",
  "  SPACED = 5",
].join("\n");

describe("scanDotenv", () => {
  it("treats every value as a placeholder by default", () => {
    expect(scanDotenv(text, { valuesAreDefaults: false })).toEqual([
      { key: "Shop__BaseUrl", line: 2, default: null },
      { key: "Shop__ApiKey", line: 3, default: null },
      { key: "QUOTED", line: 4, default: null },
      { key: "SINGLE", line: 5, default: null },
      { key: "INLINE", line: 6, default: null },
      { key: "SPACED", line: 9, default: null },
    ]);
  });

  it("uses non-empty values as defaults when asked", () => {
    expect(scanDotenv(text, { valuesAreDefaults: true })).toEqual([
      { key: "Shop__BaseUrl", line: 2, default: "https://shop.example.com#anchor" },
      { key: "Shop__ApiKey", line: 3, default: null },
      { key: "QUOTED", line: 4, default: "a # b" },
      { key: "SINGLE", line: 5, default: "x" },
      { key: "INLINE", line: 6, default: "value" },
      { key: "SPACED", line: 9, default: "5" },
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(scanDotenv("", { valuesAreDefaults: false })).toEqual([]);
  });
});
