import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CheckOptions, runCheck } from "../../src/commands/check.js";
import { createFakeGitHub, GITHUB_ENV } from "../helpers/fake-github.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo, createStubLayer } from "../helpers/stub-layer.js";

let repo: TestRepo;
const options = (overrides: Partial<CheckOptions> = {}): CheckOptions => ({
  base: "v1",
  revision: "v2",
  format: "md",
  failOn: "breaking",
  allowIncomplete: false,
  ...overrides,
});

beforeAll(() => {
  repo = createRepo([
    { files: { "a.txt": "1" }, tag: "v1" },
    { files: { "a.txt": "2" }, tag: "v2" },
  ]);
  writeRepoFile(repo, "compat.config.json", JSON.stringify({ layers: { stub: { level: "breaking" } } }));
  writeRepoFile(repo, "empty.json", JSON.stringify({ layers: { stub: { enabled: false } } }));
  writeRepoFile(repo, "safe.json", JSON.stringify({ layers: { stub: { level: "safe" } } }));
});
afterAll(() => repo.cleanup());

describe("runCheck", () => {
  it("returns 1 for a breaking finding and prints the Markdown report", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options(), run.io)).toBe(1);
    expect(run.stdout()).toContain("**Gate: FAIL**");
    expect(run.stdout()).toContain("## breaking (1)");
    expect(run.stderr()).toContain("softure-compat: gate failed");
  });

  it("returns 0 for the same finding with fail-on never", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ failOn: "never" }), run.io)).toBe(0);
  });

  it("returns 0 when findings stay below the threshold", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ configPath: "safe.json" }), run.io)).toBe(0);
    expect(run.stdout()).toContain("**Gate: PASS**");
  });

  it("returns 2 and names the ref when a ref is unknown", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ revision: "v9" }), run.io)).toBe(2);
    expect(run.stderr()).toContain('git ref "v9" does not resolve to a commit');
  });

  it("returns 2 when no layer is enabled", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ configPath: "empty.json" }), run.io)).toBe(2);
    expect(run.stderr()).toContain("no layer is enabled");
  });

  it("reports a disabled layer and fails only when --require names it", async () => {
    const layers = [createStubLayer(), createStubLayer("openapi")];
    const config = JSON.stringify({ layers: { stub: { level: "safe" }, openapi: { enabled: false } } });
    writeRepoFile(repo, "disabled-openapi.json", config);

    const lenient = createIo(repo.dir, layers);
    expect(await runCheck(options({ configPath: "disabled-openapi.json" }), lenient.io)).toBe(0);
    expect(lenient.stdout()).toContain("**Gate: PASS**\n\nNot checked: openapi (disabled)");
    expect(lenient.stdout()).toContain("| openapi | disabled | - | - | - | - | - |");

    const strict = createIo(repo.dir, layers);
    expect(
      await runCheck(options({ configPath: "disabled-openapi.json", required: ["openapi"] }), strict.io),
    ).toBe(1);
    expect(strict.stdout()).toContain("- openapi: layer disabled, but --require names it");
  });

  it("returns 2 when --require names an unknown layer", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ required: ["stub", "openapy"] }), run.io)).toBe(2);
    expect(run.stderr()).toContain("--require names unknown layer(s) openapy; known layers: stub");
  });

  it("returns 2 when the config is missing", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ configPath: "nope.json" }), run.io)).toBe(2);
    expect(run.stderr()).toContain(`config file not found: ${join(repo.dir, "nope.json")}`);
  });

  it("writes the JSON report to --output", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ format: "json", outputPath: "report.json" }), run.io)).toBe(1);
    const document = JSON.parse(readFileSync(join(repo.dir, "report.json"), "utf8"));
    expect(document.revision.ref).toBe("v2");
    expect(run.stdout()).toBe("");
  });

  it("returns 2 when the report cannot be written", async () => {
    mkdirSync(join(repo.dir, "a-directory"), { recursive: true });
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ outputPath: "a-directory" }), run.io)).toBe(2);
    expect(run.stderr()).toContain(`cannot write the report to ${join(repo.dir, "a-directory")}`);
  });

  it("turns a throwing layer into a failed layer", async () => {
    const throwing = createStubLayer("stub", () => {
      throw new Error("kaboom");
    });
    const run = createIo(repo.dir, [throwing]);
    expect(await runCheck(options(), run.io)).toBe(1);
    expect(run.stdout()).toContain("- **stub** failed: unexpected error: kaboom");
    expect(await runCheck(options({ allowIncomplete: true }), createIo(repo.dir, [throwing]).io)).toBe(0);
  });

  it("gives each layer a temporary directory and removes it after the run", async () => {
    let layerTempDir = "";
    const recording = createStubLayer("stub", () => ({
      layer: "stub",
      status: "ran",
      findings: [],
      notes: [],
    }));
    const run = recording.run;
    recording.run = async (context) => {
      layerTempDir = context.tempDir;
      expect(existsSync(layerTempDir)).toBe(true);
      return run(context);
    };
    expect(await runCheck(options(), createIo(repo.dir, [recording]).io)).toBe(0);
    expect(layerTempDir).not.toBe("");
    expect(existsSync(layerTempDir)).toBe(false);
  });
});

describe("runCheck with check defaults in the config", () => {
  const withDefaults = (check: Record<string, unknown>) =>
    JSON.stringify({ check, layers: { stub: { level: "needs-action" } } });
  const commitOf = (tag: string) => repo.git("rev-parse", tag).trim();
  const noFlags = (configPath: string, overrides: Partial<CheckOptions> = {}): CheckOptions => ({
    configPath,
    format: "json",
    allowIncomplete: false,
    ...overrides,
  });

  it("runs with no flags on the base, revision and failOn of the config", async () => {
    writeRepoFile(
      repo,
      "defaults.json",
      withDefaults({ base: "v1", revision: "v2", failOn: "needs-action" }),
    );
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(noFlags("defaults.json"), run.io)).toBe(1);
    const report = JSON.parse(run.stdout());
    expect(report.base).toEqual({ ref: "v1", commit: commitOf("v1"), source: "config" });
    expect(report.revision).toEqual({ ref: "v2", commit: commitOf("v2"), source: "config" });
    expect(report.failOn).toBe("needs-action");
  });

  it("lets each flag override its config value and says so in the header", async () => {
    writeRepoFile(
      repo,
      "defaults-v2.json",
      withDefaults({ base: "v2", revision: "v2", failOn: "needs-action" }),
    );
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(
      await runCheck(noFlags("defaults-v2.json", { base: "v1", failOn: "breaking", format: "md" }), run.io),
    ).toBe(0);
    expect(run.stdout()).toContain(
      `Base \`${commitOf("v1").slice(0, 12)}\` (--base), revision \`${commitOf("v2").slice(0, 12)}\` (config), fail on \`breaking\`.`,
    );
  });

  it("falls back to breaking when neither the flag nor the config sets failOn", async () => {
    writeRepoFile(repo, "refs-only.json", withDefaults({ base: "v1", revision: "v2" }));
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(noFlags("refs-only.json"), run.io)).toBe(0);
    expect(JSON.parse(run.stdout()).failOn).toBe("breaking");
  });

  it.each([
    ["base", { revision: "v2" }, "no base ref: pass --base or set check.base in"],
    ["revision", { base: "v1" }, "no revision ref: pass --revision or set check.revision in"],
  ])(
    "returns 2 when the %s is set neither on the command line nor in the config",
    async (_side, check, message) => {
      writeRepoFile(repo, "partial.json", withDefaults(check));
      const run = createIo(repo.dir, [createStubLayer()]);
      expect(await runCheck(noFlags("partial.json"), run.io)).toBe(2);
      expect(run.stderr()).toContain(message);
      expect(run.stderr()).toContain("partial.json");
      expect(run.stdout()).toBe("");
    },
  );
});

describe("runCheck with ref resolvers", () => {
  const DEPLOYMENTS = "/deployments?environment=prod&per_page=100";

  it("resolves latest-tag and shows the resolver in the report", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(
      await runCheck(options({ base: "v1", revision: "latest-tag:v*", configPath: "safe.json" }), run.io),
    ).toBe(0);
    expect(run.stdout()).toContain("# Backward compatibility: v1 → v2");
    expect(run.stdout()).toMatch(/revision latest-tag:v\* → v2 `[0-9a-f]{12}`/);
  });

  it("compares the commit of the latest successful deployment", async () => {
    const v1 = repo.git("rev-parse", "v1").trim();
    const github = createFakeGitHub({
      [DEPLOYMENTS]: [{ id: 1, sha: v1, ref: "1.0.0" }],
      "/deployments/1/statuses?per_page=1": [{ state: "success" }],
    });
    const run = createIo(repo.dir, [createStubLayer()]);
    const io = { ...run.io, env: GITHUB_ENV, fetch: github.fetch };
    expect(
      await runCheck(
        options({ base: "github-deployment:prod", format: "json", configPath: "safe.json" }),
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(run.stdout()).base).toEqual({
      ref: "1.0.0",
      commit: v1,
      resolver: "github-deployment:prod",
      source: "flag",
    });
  });

  it("returns 2 and asks for a fetch when the deployed commit is not in the clone", async () => {
    const github = createFakeGitHub({
      [DEPLOYMENTS]: [{ id: 1, sha: "f".repeat(40), ref: "9.9.9" }],
      "/deployments/1/statuses?per_page=1": [{ state: "success" }],
    });
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(
      await runCheck(options({ base: "github-deployment:prod" }), {
        ...run.io,
        env: GITHUB_ENV,
        fetch: github.fetch,
      }),
    ).toBe(2);
    expect(run.stderr()).toContain(
      `softure-compat: github-deployment:prod resolved to 9.9.9 (${"f".repeat(40)}), which is not in the local clone; fetch it (actions/checkout with fetch-depth: 0)`,
    );
  });

  it("returns 2 when a resolver finds nothing", async () => {
    const run = createIo(repo.dir, [createStubLayer()]);
    expect(await runCheck(options({ base: "latest-tag:release-*" }), run.io)).toBe(2);
    expect(run.stderr()).toContain(
      'softure-compat: cannot resolve latest-tag:release-*: no tag matches "release-*"',
    );
  });
});
