import { describe, expect, it } from "vitest";
import {
  compareVersions,
  getBump,
  isBreakingUpgrade,
  parseVersion,
  type Version,
} from "../../../src/layers/dependencies/versions.js";

const version = (text: string) => parseVersion(text) as Version;

describe("parseVersion", () => {
  it.each([
    ["1.2.3", [1, 2, 3, 0], ""],
    ["^1.2.3", [1, 2, 3, 0], ""],
    ["~0.4", [0, 4, 0, 0], ""],
    [">=1.2.0 <2", [1, 2, 0, 0], ""],
    ["[1.2,2.0)", [1, 2, 0, 0], ""],
    ["1.x", [1, 0, 0, 0], ""],
    ["8.0.0.1", [8, 0, 0, 1], ""],
    ["2.0.0-rc.1", [2, 0, 0, 0], "rc.1"],
    ["npm:other@^3.1.0", [3, 1, 0, 0], ""],
  ])("reads %s", (text, parts, prerelease) => {
    expect(parseVersion(text)).toEqual({ parts, prerelease, text });
  });

  it.each([
    "latest",
    "*",
    "workspace:*",
    "file:../lib",
    "git+https://github.com/a/b.git",
    "user/repo",
    "$(Missing)",
  ])("returns null for %s", (text) => {
    expect(parseVersion(text)).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by number, then a prerelease before its release", () => {
    expect(compareVersions(version("1.2.0"), version("1.10.0"))).toBeLessThan(0);
    expect(compareVersions(version("2.0.0-rc.1"), version("2.0.0"))).toBeLessThan(0);
    expect(compareVersions(version("2.0.0-rc.2"), version("2.0.0-rc.10"))).toBeLessThan(0);
    expect(compareVersions(version("1.2"), version("1.2.0"))).toBe(0);
  });
});

describe("getBump and isBreakingUpgrade", () => {
  it.each([
    ["0.4.0", "1.2.0", "major", true],
    ["3.1.0", "3.2.0", "minor", false],
    ["3.1.0", "3.1.5", "patch", false],
    ["0.4.0", "0.5.0", "minor", true],
    ["0.4.0", "0.4.1", "patch", false],
    ["0.0.3", "0.0.4", "patch", true],
    ["1.0.0-rc.1", "1.0.0", "other", false],
  ])("%s → %s is a %s bump, breaking: %s", (from, to, bump, isBreaking) => {
    expect(getBump(version(from), version(to))).toBe(bump);
    expect(isBreakingUpgrade(version(from), version(to))).toBe(isBreaking);
  });
});
