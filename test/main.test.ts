import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { createIo } from "./helpers/stub-layer.js";

describe("main", () => {
  it("prints help and returns 0", async () => {
    const run = createIo(process.cwd());
    expect(await main(["--help"], run.io)).toBe(0);
    expect(run.stdout()).toContain("Usage: softure-compat check [--base <ref>] [--revision <ref>]");
    expect(run.stdout()).toContain("softure-compat init [--repo <dir>] [--config <file>] [--force]");
  });

  it("prints the package version", async () => {
    const run = createIo(process.cwd());
    expect(await main(["--version"], run.io)).toBe(0);
    expect(run.stdout()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([
    [["check", "--base", "a", "--revision", "b", "--colour"], "Unknown option '--colour'"],
    [[], "missing command"],
    [["diff", "--base", "a", "--revision", "b"], 'unknown command "diff"'],
    [["check", "--base", "a", "--revision", "b", "--format", "html"], "--format must be one of md, json"],
    [["check", "--base", "a", "--revision", "b", "--fail-on", "info"], "--fail-on must be one of"],
    [["check", "--base", "a", "--revision", "b", "--force"], "--force is only for init"],
    [["init", "--base", "a"], "--base is only for check"],
    [["init", "--fail-on", "never"], "--fail-on is only for check"],
    [["init", "now"], 'unknown command "init now"'],
    [
      ["check", "--base", "a", "--revision", "b", "--require", " , "],
      "--require needs at least one layer name",
    ],
    [["init", "--require", "openapi"], "--require is only for check"],
  ])("returns 2 for %j", async (argv, message) => {
    const run = createIo(process.cwd());
    expect(await main(argv, run.io)).toBe(2);
    expect(run.stderr()).toContain(message);
    expect(run.stderr()).toContain("Usage:");
  });

  it("asks for a base ref after reading the config when neither --base nor check.base sets it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "softure-compat-main-"));
    try {
      writeFileSync(
        join(dir, "compat.config.json"),
        JSON.stringify({
          layers: { seed: { sources: [{ name: "db", dialect: "postgres", files: ["seed.sql"] }] } },
        }),
      );
      const run = createIo(dir);
      expect(await main(["check", "--revision", "b"], run.io)).toBe(2);
      expect(run.stderr()).toContain("no base ref: pass --base or set check.base in");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
