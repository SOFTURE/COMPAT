import { describe, expect, it } from "vitest";
import {
  describeObserved,
  expandIdentity,
  matchesIdentity,
} from "../../../src/layers/behaviour/stack-identity.js";

const SHA = "3f2a9c1e0b7d4a6f8e5c2b1a0d9e8f7c6b5a4d3e";

describe("expandIdentity", () => {
  it("replaces every {commit} and {ref}", () => {
    expect(expandIdentity("{ref}@{commit} {commit}", { commit: SHA, ref: "2.3.4" })).toBe(
      `2.3.4@${SHA} ${SHA}`,
    );
  });

  it("keeps a template without placeholders", () => {
    expect(expandIdentity("v2", { commit: SHA, ref: "2.3.4" })).toBe("v2");
  });
});

describe("matchesIdentity", () => {
  it.each([
    ["the exact commit", `${SHA}\n`, SHA, true],
    ["the commit inside a JSON body", `{"commit":"${SHA}","built":"today"}`, SHA, true],
    ["a 7-character short commit", "3f2a9c1", SHA, true],
    ["an upper-case short commit", "rev 3F2A9C1E0B", SHA, true],
    ["a 6-character prefix", "3f2a9c", SHA, false],
    ["another commit's short form", "3f2a9c2", SHA, false],
    ["a short commit glued to other letters", "x3f2a9c1", SHA, false],
    ["empty output", "  \n", SHA, false],
    ["a ref inside the output", "version 2.3.4 (abc)", "2.3.4", true],
    ["another ref", "version 2.3.5", "2.3.4", false],
    ["a short hex value against a ref", "3f2a9c1", "3f2a9c1e", false],
  ])("%s", (_, observed, expected, result) => {
    expect(matchesIdentity(observed, expected)).toBe(result);
  });
});

describe("describeObserved", () => {
  it("quotes trimmed output on one line", () => {
    expect(describeObserved("  a\nb  \n")).toBe('"a b"');
  });

  it("says nothing for empty output", () => {
    expect(describeObserved("\n")).toBe("nothing");
  });

  it("cuts long output", () => {
    expect(describeObserved("x".repeat(250))).toBe(`"${"x".repeat(200)}..."`);
  });
});
