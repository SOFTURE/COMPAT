import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, selectTags } from "../../../src/layers/client-usage/client-refs.js";

describe("client refs", () => {
  it("parses the first version of a tag", () => {
    expect(parseVersion("v2.10.1-rc1")).toEqual([2, 10, 1]);
    expect(parseVersion("mobile-2.0")).toEqual([2, 0]);
    expect(parseVersion("latest")).toBeUndefined();
  });

  it("compares versions numerically, missing segments as zero", () => {
    expect(compareVersions([2, 10], [2, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([2, 0], [2, 0, 0])).toBe(0);
  });

  it("sorts tags by version and keeps those since a version", () => {
    expect(selectTags(["2.10.0", "2.2.4", "2.0.1", "1.9.0", "beta"], "2.0.1")).toEqual({
      ok: true,
      value: ["2.0.1", "2.2.4", "2.10.0"],
    });
    expect(selectTags(["b", "2.0.0", "a"], undefined)).toEqual({ ok: true, value: ["2.0.0", "a", "b"] });
    expect(selectTags(["2.0.0"], "next")).toEqual({ ok: false, error: '"since" next holds no version' });
  });
});
