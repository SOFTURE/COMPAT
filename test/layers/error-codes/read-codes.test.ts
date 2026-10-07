import { describe, expect, it } from "vitest";
import { compileCodePattern } from "../../../src/layers/error-codes/config.js";
import { readCodes } from "../../../src/layers/error-codes/read-codes.js";

const compile = (pattern: string, flags = "") => {
  const regex = compileCodePattern(pattern, flags);
  if (!(regex instanceof RegExp)) throw new Error(regex.error);
  return regex;
};

describe("readCodes", () => {
  it("reads every capture with the line of the code, duplicates included", () => {
    const text = [
      "public static readonly Error NotFound = new Error(",
      '    "Shop.Cart.NotFound", "Cart not found");',
      'var e = new Error("Shop.Cart.Full", "full"); var f = new Error("Shop.Cart.NotFound", "x");',
    ].join("\n");
    expect(readCodes(text, compile('new Error\\(\\s*"(?<code>[\\w.]+)"'))).toEqual([
      { code: "Shop.Cart.NotFound", line: 2 },
      { code: "Shop.Cart.Full", line: 3 },
      { code: "Shop.Cart.NotFound", line: 3 },
    ]);
  });

  it("skips empty captures and returns nothing for text without a match", () => {
    expect(readCodes('"": "x",\n"A.B": "y"', compile('"(?<code>[\\w.]*)":'))).toEqual([
      { code: "A.B", line: 2 },
    ]);
    expect(readCodes("", compile('"(?<code>[\\w.]+)":'))).toEqual([]);
  });

  it("reads the same text twice with one regex", () => {
    const regex = compile("(?<code>[A-Z]\\w*)");
    expect(readCodes("Ab Cd", regex)).toHaveLength(2);
    expect(readCodes("Ab Cd", regex)).toHaveLength(2);
  });
});
