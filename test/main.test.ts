import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { createIo } from "./helpers/stub-layer.js";

describe("main", () => {
  it("prints help and returns 0", async () => {
    const run = createIo(process.cwd());
    expect(await main(["--help"], run.io)).toBe(0);
    expect(run.stdout()).toContain("Usage: softure-compat check --base <ref> --revision <ref>");
  });

  it("prints the package version", async () => {
    const run = createIo(process.cwd());
    expect(await main(["--version"], run.io)).toBe(0);
    expect(run.stdout()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([
    [["check", "--base", "a", "--revision", "b", "--colour"], "Unknown option '--colour'"],
    [["check", "--revision", "b"], "--base and --revision are required"],
    [[], "missing command"],
    [["diff", "--base", "a", "--revision", "b"], 'unknown command "diff"'],
    [["check", "--base", "a", "--revision", "b", "--format", "html"], "--format must be one of md, json"],
    [["check", "--base", "a", "--revision", "b", "--fail-on", "info"], "--fail-on must be one of"],
  ])("returns 2 for %j", async (argv, message) => {
    const run = createIo(process.cwd());
    expect(await main(argv, run.io)).toBe(2);
    expect(run.stderr()).toContain(message);
    expect(run.stderr()).toContain("Usage:");
  });
});
