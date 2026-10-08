import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { getAssetSuffix, PINNED_OASDIFF } from "../../../src/layers/openapi/oasdiff-download.js";
import { openapiLayer } from "../../../src/layers/openapi/openapi-layer.js";
import type { LayerResult } from "../../../src/model/finding.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";
import { FAKE_OASDIFF } from "../../helpers/oasdiff.js";
import { createTarGz } from "../../helpers/tar.js";

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    { files: { "api/b2c.yaml": "base", "api/admin.yaml": "base" }, tag: "v1" },
    { files: { "api/b2c.yaml": "revision", "api/admin.yaml": null, "api/shop.yaml": "new" }, tag: "v2" },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-openapi-layer-"));
  const opened = await Promise.all([
    openRefTree({ repoDir: repo.dir, ref: "v1", side: "base", tempRoot }),
    openRefTree({ repoDir: repo.dir, ref: "v2", side: "revision", tempRoot }),
  ]);
  if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
  base = opened[0].value;
  revision = opened[1].value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

const fileApi = (name: string, path: string, accept?: unknown[]) => ({
  name,
  source: { kind: "file", path },
  ...(accept ? { accept } : {}),
});

function run(config: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): Promise<LayerResult> {
  return openapiLayer.run({
    config: { oasdiff: { path: FAKE_OASDIFF }, ...config },
    base,
    revision,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: { ...process.env, ...env },
    log: () => {},
  });
}

const FAKE_NOTE = `oasdiff oasdiff version fake at ${FAKE_OASDIFF} (from layers.openapi.oasdiff.path)`;

const changes = (items: object[]) => ({
  FAKE_OASDIFF_MODE: "changes",
  FAKE_OASDIFF_OUTPUT: JSON.stringify(items),
});

describe("openapi layer", () => {
  it("fails when a configured oasdiff path does not exist", async () => {
    const result = await run({
      apis: [fileApi("b2c", "api/b2c.yaml")],
      oasdiff: { path: "/nonexistent/oasdiff" },
    });
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: "oasdiff at /nonexistent/oasdiff cannot run --version (ENOENT)",
      findings: [],
      notes: [],
    });
  });

  it("resolves a relative configured path against the repository and fails when it is not executable", async () => {
    writeFileSync(join(repo.dir, "oasdiff-not-executable"), "#!/bin/sh\n");
    chmodSync(join(repo.dir, "oasdiff-not-executable"), 0o644);
    const result = await run({
      apis: [fileApi("b2c", "api/b2c.yaml")],
      oasdiff: { path: "./oasdiff-not-executable" },
    });
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: `oasdiff at ${join(repo.dir, "oasdiff-not-executable")} cannot run --version (EACCES)`,
      findings: [],
      notes: [],
    });
  });

  it("fails when oasdiff --version exits non-zero", async () => {
    const result = await run(
      { apis: [fileApi("b2c", "api/b2c.yaml")] },
      { FAKE_OASDIFF_MODE: "version-fail" },
    );
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: `oasdiff at ${FAKE_OASDIFF} --version exited 2`,
      findings: [],
      notes: [],
    });
  });

  it("keeps the findings of other APIs when one API fails", async () => {
    const result = await run(
      { apis: [fileApi("b2c", "api/b2c.yaml"), fileApi("b2b", "api/b2b.yaml")] },
      changes([{ id: "endpoint-removed", text: "removed", level: 3, operation: "GET", path: "/a" }]),
    );
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: 'API "b2b": spec api/b2b.yaml exists at neither ref',
      findings: [expect.objectContaining({ id: "endpoint-removed", class: "breaking", scope: "b2c" })],
      notes: [FAKE_NOTE],
    });
  });

  it("finds oasdiff through SOFTURE_COMPAT_OASDIFF", async () => {
    const result = await openapiLayer.run({
      config: { apis: [fileApi("b2c", "api/b2c.yaml")] },
      base,
      revision,
      repoDir: repo.dir,
      tempDir: tempRoot,
      env: { ...process.env, SOFTURE_COMPAT_OASDIFF: FAKE_OASDIFF, ...changes([]) },
      log: () => {},
    });
    expect(result).toEqual({
      layer: "openapi",
      status: "ran",
      findings: [],
      notes: [`oasdiff oasdiff version fake at ${FAKE_OASDIFF} (from SOFTURE_COMPAT_OASDIFF)`],
    });
  });

  it("fails naming the API when oasdiff exits non-zero", async () => {
    const result = await run({ apis: [fileApi("b2c", "api/b2c.yaml")] }, { FAKE_OASDIFF_MODE: "fail" });
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: 'API "b2c": oasdiff changelog exited 3: Error: failed to load base spec',
      findings: [],
      notes: [FAKE_NOTE],
    });
  });

  it("fails when oasdiff prints something other than JSON", async () => {
    const result = await run({ apis: [fileApi("b2c", "api/b2c.yaml")] }, { FAKE_OASDIFF_MODE: "garbage" });
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: 'API "b2c": oasdiff changelog printed output that is not JSON',
      findings: [],
      notes: [FAKE_NOTE],
    });
  });

  it("classifies oasdiff output, applies accept entries and reports their usage", async () => {
    const logFile = join(tempRoot, "fake-args.log");
    const result = await run(
      {
        apis: [
          fileApi("b2c", "api/b2c.yaml", [
            { id: "endpoint-removed", operation: "GET /a", reason: "unused" },
            { id: "never-seen", reason: "stale" },
          ]),
        ],
        oasdiff: { path: FAKE_OASDIFF, args: ["--flatten-allof"] },
      },
      {
        ...changes([
          { id: "endpoint-removed", text: "removed", level: 3, operation: "GET", path: "/a" },
          { id: "endpoint-added", text: "added", level: 1, operation: "GET", path: "/b" },
        ]),
        FAKE_OASDIFF_LOG: logFile,
      },
    );
    if (result.status !== "ran") throw new Error(JSON.stringify(result));
    expect(result.findings.map((finding) => [finding.id, finding.class, finding.accepted?.reason])).toEqual([
      ["endpoint-removed", "breaking", "unused"],
      ["endpoint-added", "safe", undefined],
    ]);
    expect(result.notes).toEqual([
      FAKE_NOTE,
      'API "b2c": accept entry endpoint-removed on GET /a accepted 1 finding(s)',
      'API "b2c": accept entry never-seen matched nothing; remove it if the change is gone',
    ]);
    const calls = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const changelog = calls.find((args) => args[0] === "changelog") ?? [];
    expect(changelog.slice(0, 5)).toEqual(["changelog", "--flatten-allof", "--format", "json", "--"]);
  });

  it("reports an API added in the revision as safe", async () => {
    const result = await run({ apis: [fileApi("shop", "api/shop.yaml")] }, changes([]));
    if (result.status !== "ran") throw new Error(JSON.stringify(result));
    expect(result.findings).toEqual([
      expect.objectContaining({ id: "api-added", class: "safe", subject: "api/shop.yaml", scope: "shop" }),
    ]);
  });

  it("reports an API removed in the revision as breaking", async () => {
    const result = await run({ apis: [fileApi("admin", "api/admin.yaml")] }, changes([]));
    if (result.status !== "ran") throw new Error(JSON.stringify(result));
    expect(result.findings).toEqual([
      expect.objectContaining({
        id: "api-removed",
        class: "breaking",
        evidence: [{ side: "base", ref: "v1", commit: base.commit, path: "api/admin.yaml" }],
      }),
    ]);
  });

  it("fails when the spec exists at neither ref", async () => {
    const result = await run({ apis: [fileApi("b2b", "api/b2b.yaml")] }, changes([]));
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: 'API "b2b": spec api/b2b.yaml exists at neither ref',
      findings: [],
      notes: [FAKE_NOTE],
    });
  });

  describe("setup and concurrency", () => {
    let workDir: string;

    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), "compat-openapi-setup-"));
    });

    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    const commandApi = (name: string) => ({
      name,
      // Fails unless the setup of the same side already ran in this tree.
      source: {
        kind: "command",
        run: `test -f "$WORK_DIR/setup-$COMPAT_SIDE" && cp api/b2c.yaml out-${name}.yaml`,
        output: `out-${name}.yaml`,
      },
    });

    const readLines = async (file: string) =>
      (await readFile(file, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== "")
        .sort();

    // Each side records that it started, then waits up to 2 s for the other side to start too.
    const BARRIER_SETUP = [
      'touch "$WORK_DIR/started-$COMPAT_SIDE"',
      'other=base; [ "$COMPAT_SIDE" = base ] && other=revision',
      "i=0",
      'while [ $i -lt 20 ]; do if [ -f "$WORK_DIR/started-$other" ]; then echo "$COMPAT_SIDE" >> "$WORK_DIR/overlap"; break; fi; sleep 0.1; i=$((i+1)); done',
    ].join("; ");

    it("runs the setup command once per side, before the spec commands, whatever the number of APIs", async () => {
      const result = await run(
        {
          setup: {
            run: 'echo "$COMPAT_SIDE $COMPAT_REF" >> "$WORK_DIR/count"; touch "$WORK_DIR/setup-$COMPAT_SIDE"',
          },
          apis: [commandApi("b2c"), commandApi("b2b"), commandApi("admin")],
        },
        { ...changes([]), WORK_DIR: workDir },
      );
      expect(result).toEqual({
        layer: "openapi",
        status: "ran",
        findings: [],
        notes: [FAKE_NOTE],
      });
      expect(await readLines(join(workDir, "count"))).toEqual(["base v1", "revision v2"]);
    });

    it("fails the layer naming the side and ref when the setup command fails at one side", async () => {
      const result = await run(
        {
          setup: { run: '[ "$COMPAT_SIDE" = revision ] && { echo build broke >&2; exit 2; }; true' },
          apis: [fileApi("b2c", "api/b2c.yaml")],
        },
        changes([]),
      );
      expect(result).toEqual({
        layer: "openapi",
        status: "failed",
        error: "setup command at revision (v2) exited 2: build broke",
        findings: [],
        notes: [FAKE_NOTE],
      });
    });

    it("names both sides when the setup command fails at both", async () => {
      const result = await run(
        { setup: { run: "echo no sdk >&2; exit 1" }, apis: [fileApi("b2c", "api/b2c.yaml")] },
        changes([]),
      );
      expect(result).toMatchObject({
        status: "failed",
        error: "setup command at base (v1) exited 1: no sdk; setup command at revision (v2) exited 1: no sdk",
      });
    });

    it("prepares base and revision in parallel by default", async () => {
      const result = await run(
        { setup: { run: BARRIER_SETUP }, apis: [fileApi("b2c", "api/b2c.yaml")] },
        { ...changes([]), WORK_DIR: workDir },
      );
      expect(result.status).toBe("ran");
      expect(await readLines(join(workDir, "overlap"))).toEqual(["base", "revision"]);
    });

    it("prepares base and revision one after the other with concurrency 1", async () => {
      const result = await run(
        { setup: { run: BARRIER_SETUP }, concurrency: 1, apis: [fileApi("b2c", "api/b2c.yaml")] },
        { ...changes([]), WORK_DIR: workDir },
      );
      expect(result.status).toBe("ran");
      // Base finished waiting before the revision started, so only the revision saw the other side.
      expect(await readLines(join(workDir, "overlap"))).toEqual(["revision"]);
    });
  });
});

describe("openapi layer without oasdiff on PATH", () => {
  const suffix = getAssetSuffix(process.platform, process.arch);
  const binaryName = process.platform === "win32" ? "oasdiff.exe" : "oasdiff";
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "compat-openapi-cache-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(cacheDir, { recursive: true, force: true });
  });

  function runWithoutOasdiff(config: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
    return openapiLayer.run({
      config: { apis: [fileApi("b2c", "api/b2c.yaml")], ...config },
      base,
      revision,
      repoDir: repo.dir,
      tempDir: tempRoot,
      env: {
        ...process.env,
        PATH: "/nonexistent",
        SOFTURE_COMPAT_OASDIFF: undefined,
        SOFTURE_COMPAT_NO_DOWNLOAD: undefined,
        SOFTURE_COMPAT_CACHE_DIR: cacheDir,
        ...env,
      },
      log: () => {},
    });
  }

  const skippedReason =
    "oasdiff not found on PATH and downloading is turned off (set layers.openapi.oasdiff.path or SOFTURE_COMPAT_OASDIFF, or install it with `go install github.com/oasdiff/oasdiff@v1.33.0`)";

  it("is skipped with an install hint when downloading is turned off in the config", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await runWithoutOasdiff({ oasdiff: { download: false } })).toEqual({
      layer: "openapi",
      status: "skipped",
      reason: skippedReason,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is skipped when SOFTURE_COMPAT_NO_DOWNLOAD is set", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(await runWithoutOasdiff({}, { SOFTURE_COMPAT_NO_DOWNLOAD: "1" })).toEqual({
      layer: "openapi",
      status: "skipped",
      reason: skippedReason,
    });
  });

  it.runIf(suffix !== undefined)(
    "fails, never passes, when the downloaded archive is tampered with",
    async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new Uint8Array(createTarGz({ oasdiff: "#!/bin/sh\necho evil\n" })))),
      );
      const result = await runWithoutOasdiff();
      expect(result).toEqual({
        layer: "openapi",
        status: "failed",
        error: expect.stringContaining("failed the checksum check"),
        findings: [],
        notes: [],
      });
      expect(existsSync(join(cacheDir, "oasdiff"))).toBe(false);
    },
  );

  /** Caches the fake as the pinned binary, with its checksum standing in for the shipped one. */
  async function cacheFakeOasdiff(): Promise<string> {
    const binarySha = PINNED_OASDIFF.binarySha256 as Record<string, string>;
    const key = suffix ?? "";
    const pinnedSha = binarySha[key];
    binarySha[key] = createHash("sha256").update(readFileSync(FAKE_OASDIFF)).digest("hex");
    onTestFinished(() => {
      if (pinnedSha !== undefined) binarySha[key] = pinnedSha;
    });
    const cached = join(cacheDir, "oasdiff", "1.33.0", key, binaryName);
    await mkdir(dirname(cached), { recursive: true });
    await copyFile(FAKE_OASDIFF, cached);
    return cached;
  }

  const hasCacheableRelease = suffix !== undefined && process.platform !== "win32";

  it.runIf(hasCacheableRelease).each([
    ["downloads are on", {}, {}],
    ["the config turns downloads off", { oasdiff: { download: false } }, {}],
    ["SOFTURE_COMPAT_NO_DOWNLOAD is set", {}, { SOFTURE_COMPAT_NO_DOWNLOAD: "1" }],
  ])("uses the cached pinned release without network access when %s", async (_, config, env) => {
    const cached = await cacheFakeOasdiff();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // The fake is a node script; PATH must still find node for its shebang.
    const result = await runWithoutOasdiff(config, {
      PATH: dirname(process.execPath),
      ...changes([]),
      ...env,
    });
    expect(result).toEqual({
      layer: "openapi",
      status: "ran",
      findings: [],
      notes: [`oasdiff oasdiff version fake at ${cached} (pinned release from the cache)`],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.runIf(hasCacheableRelease)(
    "is skipped when downloads are off and the cached binary does not match its checksum",
    async () => {
      const cached = await cacheFakeOasdiff();
      writeFileSync(cached, "#!/bin/sh\necho evil\n");
      vi.stubGlobal("fetch", vi.fn());
      expect(await runWithoutOasdiff({}, { SOFTURE_COMPAT_NO_DOWNLOAD: "1" })).toEqual({
        layer: "openapi",
        status: "skipped",
        reason: skippedReason,
      });
    },
  );
});
