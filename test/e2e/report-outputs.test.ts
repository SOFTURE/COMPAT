import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/dependencies/f9/${path}`, import.meta.url), "utf8");
const files = (side: "base" | "revision") => ({
  "APP/Directory.Packages.props": fixture(`${side}/Directory.Packages.props`),
  "APP/src/Petseo.Api/Petseo.Api.csproj": fixture("Petseo.Api.csproj"),
});

let repo: TestRepo;
let outDir: string;

beforeAll(() => {
  repo = createRepo([
    { files: files("base"), tag: "2.2.4" },
    { files: files("revision"), tag: "2.3.4" },
  ]);
  writeRepoFile(repo, "compat.json", JSON.stringify({ layers: { dependencies: {} } }));
  outDir = mkdtempSync(join(tmpdir(), "compat-outputs-"));
});
afterAll(() => {
  repo.cleanup();
  rmSync(outDir, { recursive: true, force: true });
});

const check = (...extra: string[]) => [
  "check",
  "--base",
  "2.2.4",
  "--revision",
  "2.3.4",
  "--config",
  "compat.json",
  ...extra,
];

describe("check --json-output", () => {
  it("writes the Markdown and the JSON report from one run", async () => {
    const markdownPath = join(outDir, "report.md");
    const jsonPath = join(outDir, "report.json");
    const run = createIo(repo.dir);

    const code = await main(check("--output", markdownPath, "--json-output", jsonPath), run.io);

    expect(code).toBe(0);
    expect(run.stdout()).toBe("");
    expect(readFileSync(markdownPath, "utf8")).toContain("# ");
    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      base: { ref: string };
      layers: { layer: string }[];
    };
    expect(report.base.ref).toBe("2.2.4");
    expect(report.layers.map((layer) => layer.layer)).toContain("dependencies");
    expect(run.stderr()).toContain(`report written to ${markdownPath}`);
    expect(run.stderr()).toContain(`report written to ${jsonPath}`);
  });

  it("keeps the main report on stdout when only --json-output is given", async () => {
    const jsonPath = join(outDir, "only.json");
    const run = createIo(repo.dir);

    const code = await main(check("--json-output", jsonPath), run.io);

    expect(code).toBe(0);
    expect(run.stdout()).toContain("# ");
    expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toHaveProperty("gate");
  });

  it("cannot run when the JSON report cannot be written", async () => {
    const run = createIo(repo.dir);

    const code = await main(check("--json-output", join(outDir, "missing", "report.json")), run.io);

    expect(code).toBe(2);
    expect(run.stderr()).toContain("cannot write the report to");
  });
});
