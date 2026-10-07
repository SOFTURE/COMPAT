// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { configLayerConfigSchema } from "../../../src/layers/config/config.js";
import { configLayer } from "../../../src/layers/config/config-layer.js";
import type { LayerResult } from "../../../src/model/finding.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    {
      files: {
        "docker-compose.yml": "a: ${KEPT}\nb: ${OLD}\n",
        "old/.env.example": "MOVED=\n",
        "notes.txt": "nothing to see\n",
      },
      tag: "v1",
    },
    {
      files: {
        "docker-compose.yml": "a: ${KEPT}\nc: ${NEW}\n",
        "deploy/compose.prod.yaml": "d: ${PROD_ONLY:-x}\n",
        "settings.cs": 'Require("Shop__ApiKey");\n',
        "old/.env.example": null,
      },
      tag: "v2",
    },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-config-layer-"));
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

function run(config: unknown, trees: { base?: RefTree; revision?: RefTree } = {}): Promise<LayerResult> {
  return configLayer.run({
    config: configLayerConfigSchema.parse(config),
    base: trees.base ?? base,
    revision: trees.revision ?? revision,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: process.env,
    log: () => {},
  });
}

const summary = (result: LayerResult) =>
  result.status === "skipped" ? [] : result.findings.map((f) => `${f.subject} ${f.id} ${f.scope}`);

describe("config layer", () => {
  it("classifies compose keys from every matching file, including one present only in the revision", async () => {
    const result = await run({ sources: [{ kind: "compose" }] });
    expect(result.status).toBe("ran");
    expect(summary(result)).toEqual([
      "NEW config-key-added-required compose",
      "OLD config-key-removed compose",
      "PROD_ONLY config-key-added-optional compose",
    ]);
    expect(result.status === "ran" && result.notes).toEqual([
      'source "compose": 2 key(s) in 1 file(s) at base, 3 key(s) in 2 file(s) at revision (deploy/compose.prod.yaml, docker-compose.yml)',
    ]);
  });

  it("fails for a source that matches no file at either ref and still reports the other sources", async () => {
    const result = await run({ sources: [{ kind: "compose" }, { kind: "dotenv", files: ["*.env"] }] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toBe('source "dotenv": no file matches "*.env" at either ref');
    expect(summary(result)).toHaveLength(3);
  });

  it("fails for a source whose files exist at the base but not in the revision", async () => {
    const result = await run({ sources: [{ kind: "dotenv" }] });
    expect(result).toMatchObject({
      status: "failed",
      error:
        'source "dotenv": no file matches "**/.env.{example,sample,template,dist}", "**/{example,sample}.env" in the revision, but 1 did at the base; update the globs if the files moved',
      findings: [],
    });
  });

  it("fails for a regex source that finds no key at either ref", async () => {
    const result = await run({
      sources: [
        {
          kind: "regex",
          name: "typo",
          files: ["**/*.cs", "notes.txt"],
          pattern: 'Requird\\("(?<key>[^"]+)"\\)',
        },
      ],
    });
    expect(result).toMatchObject({
      status: "failed",
      error: 'source "typo": the pattern matches no key in "**/*.cs", "notes.txt" at either ref',
    });
  });

  it("fails for a source that had keys at the base and finds none in the revision", async () => {
    const result = await run({
      sources: [
        { kind: "regex", name: "old-only", files: ["docker-compose.yml"], pattern: "\\$\\{(?<key>OLD)\\}" },
      ],
    });
    expect(result).toMatchObject({
      status: "failed",
      error:
        'source "old-only": found 1 key(s) in "docker-compose.yml" at the base but none in the revision; check the files and the source settings',
      findings: [],
    });
  });

  it("fails for a dotenv source that finds no key at either ref", async () => {
    const result = await run({ sources: [{ kind: "dotenv", files: ["notes.txt", "docker-compose.yml"] }] });
    expect(result).toMatchObject({
      status: "failed",
      error: 'source "dotenv": no key found in "notes.txt", "docker-compose.yml" at either ref',
    });
  });

  it("drops a source that cannot be read at one ref instead of inventing added keys", async () => {
    const broken: RefTree = { ...revision, listFiles: async () => ({ ok: false, error: "git exploded" }) };
    const result = await run(
      {
        sources: [
          { kind: "regex", name: "csharp", files: ["**/*.cs"], pattern: 'Require\\("(?<key>[^"]+)"\\)' },
        ],
      },
      { revision: broken },
    );
    expect(result).toEqual({
      layer: "config",
      status: "failed",
      error: 'source "csharp": cannot list files at v2: git exploded',
      findings: [],
      notes: [],
    });
  });

  it("joins regex sources with compose sources and applies accept entries", async () => {
    const result = await run({
      sources: [
        { kind: "compose" },
        {
          kind: "regex",
          name: "csharp",
          files: ["**/*.cs"],
          pattern: 'Require\\("(?<key>[^"]+)"\\)',
          comments: "slash",
        },
      ],
      accept: [
        { key: "Shop__ApiKey", id: "config-key-added-required", reason: "already in the vault" },
        { key: "Gone", id: "config-key-removed", reason: "stale" },
      ],
    });
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    expect(result.findings.find((f) => f.subject === "Shop__ApiKey")).toMatchObject({
      id: "config-key-added-required",
      scope: "csharp",
      accepted: { reason: "already in the vault" },
      evidence: [{ side: "revision", ref: "v2", path: "settings.cs", line: 1 }],
    });
    expect(result.notes).toEqual([
      'source "compose": 2 key(s) in 1 file(s) at base, 3 key(s) in 2 file(s) at revision (deploy/compose.prod.yaml, docker-compose.yml)',
      'source "csharp": 0 key(s) in 0 file(s) at base, 1 key(s) in 1 file(s) at revision (settings.cs)',
      "accept entry config-key-added-required on Shop__ApiKey accepted 1 finding(s)",
      "accept entry config-key-removed on Gone matched nothing; remove it if the change is gone",
    ]);
  });
});
