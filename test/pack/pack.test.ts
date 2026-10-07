import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});
