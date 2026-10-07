import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { openapiLayer } from "../../../src/layers/openapi/openapi-layer.js";
import type { LayerResult } from "../../../src/model/finding.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";
import { FAKE_OASDIFF } from "../../helpers/oasdiff.js";

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

const changes = (items: object[]) => ({
  FAKE_OASDIFF_MODE: "changes",
  FAKE_OASDIFF_OUTPUT: JSON.stringify(items),
});

describe("openapi layer", () => {
  it("is skipped with an install hint when oasdiff is missing", async () => {
    const result = await run({
      apis: [fileApi("b2c", "api/b2c.yaml")],
      oasdiff: { path: "/nonexistent/oasdiff" },
    });
    expect(result).toEqual({
      layer: "openapi",
      status: "skipped",
      reason:
        'oasdiff not found (tried "/nonexistent/oasdiff"; set layers.openapi.oasdiff.path or SOFTURE_COMPAT_OASDIFF, or install it with `go install github.com/oasdiff/oasdiff@v1.33.0`)',
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
    expect(result.status).toBe("ran");
  });

  it("fails naming the API when oasdiff exits non-zero", async () => {
    const result = await run({ apis: [fileApi("b2c", "api/b2c.yaml")] }, { FAKE_OASDIFF_MODE: "fail" });
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: 'API "b2c": oasdiff changelog exited 3: Error: failed to load base spec',
    });
  });

  it("fails when oasdiff prints something other than JSON", async () => {
    const result = await run({ apis: [fileApi("b2c", "api/b2c.yaml")] }, { FAKE_OASDIFF_MODE: "garbage" });
    expect(result).toEqual({
      layer: "openapi",
      status: "failed",
      error: 'API "b2c": oasdiff changelog printed output that is not JSON',
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
      `oasdiff oasdiff version fake at ${FAKE_OASDIFF}`,
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
    });
  });
});
