// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRepo, writeRepoFile } from "../helpers/git-repo.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = `${root}dist/cli.js`;

describe("published package", () => {
  it("has a built CLI with a node shebang", () => {
    expect(existsSync(cliPath), "run `npm run build` before `npm run test:pack`").toBe(true);
    expect(readFileSync(cliPath, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("packs dist only, with the CLI", () => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    });
    const [pack] = JSON.parse(output) as [{ files: { path: string }[] }];
    const paths = pack.files.map((file) => file.path);
    expect(paths).toContain("dist/cli.js");
    expect(paths).toContain("package.json");
    expect(paths).toContain("LICENSE");
    expect(
      paths.filter(
        (path) => path.startsWith("src/") || path.startsWith("test/") || path.startsWith("context/"),
      ),
    ).toEqual([]);
  });

  it("runs --help from the built CLI", () => {
    const output = execFileSync("node", [cliPath, "--help"], { encoding: "utf8" });
    expect(output).toContain("Usage: softure-compat check");
  });

  it("runs init and then check from the built CLI", () => {
    const repo = createRepo([
      { files: { "compose.yaml": "services:\n  api:\n    environment:\n      A: ${A:-1}\n" }, tag: "v1" },
    ]);
    try {
      const init = spawnSync("node", [cliPath, "init"], { cwd: repo.dir, encoding: "utf8" });
      expect(init.status, init.stderr).toBe(0);
      expect(init.stderr).toContain("config enabled: compose.yaml");
      writeRepoFile(
        repo,
        "compose.yaml",
        "services:\n  api:\n    environment:\n      A: ${A:-1}\n      B: ${B}\n",
      );
      repo.git("commit", "-q", "-am", "v2");
      const check = spawnSync("node", [cliPath, "check", "--base", "v1", "--revision", "HEAD"], {
        cwd: repo.dir,
        encoding: "utf8",
      });
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout).toContain("config-key-added-required");
      const strict = spawnSync(
        "node",
        [cliPath, "check", "--base", "v1", "--revision", "HEAD", "--fail-on", "needs-action"],
        { cwd: repo.dir, encoding: "utf8" },
      );
      expect(strict.status).toBe(1);
    } finally {
      repo.cleanup();
    }
  });
});
