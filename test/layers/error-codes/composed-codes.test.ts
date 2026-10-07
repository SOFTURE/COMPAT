import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { errorCodesLayer } from "../../../src/layers/error-codes/error-codes-layer.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

const REPOSITORY_ERRORS = [
  "public static class RepositoryErrors<TEntity> where TEntity : IEntity {",
  '  public static readonly Error NotFound = new($"{typeof(TEntity).Name}Repository.NotFound", "Not found");',
  "}",
  "public static class CartErrors {",
  '  public static readonly Error Full = new("Shop.Cart.Full", "Cart is full");',
  "}",
].join("\n");

const PET_REPOSITORY = "return RepositoryErrors<Pet>.NotFound;\n";
const FLAG_REPOSITORY = "var x = 1;\nreturn RepositoryErrors< FeatureFlag >.NotFound;\n";

const map = (codes: string[]) =>
  `export const API_ERRORS = {\n${codes.map((code) => `  "${code}": "text",`).join("\n")}\n};\n`;

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    { files: { "app/api.ts": map(["Shop.Cart.Full", "PetRepository.NotFound"]) }, tag: "mobile-1" },
    {
      files: { "src/Errors.cs": REPOSITORY_ERRORS, "src/PetRepository.cs": PET_REPOSITORY },
      tag: "server-1",
    },
    { files: { "src/FeatureFlagRepository.cs": FLAG_REPOSITORY }, tag: "server-2" },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-composed-codes-"));
  const opened = await Promise.all([
    openRefTree({ repoDir: repo.dir, ref: "server-1", side: "base", tempRoot }),
    openRefTree({ repoDir: repo.dir, ref: "server-2", side: "revision", tempRoot }),
  ]);
  if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
  base = opened[0].value;
  revision = opened[1].value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

const literal = {
  name: "literal",
  files: ["src/**/*.cs"],
  pattern: 'static readonly Error \\w+ = new\\(\\s*"(?<code>[\\w.]+)"',
};
const entities = {
  kind: "regex",
  name: "repository-entities",
  files: ["src/**/*.cs"],
  pattern: "RepositoryErrors<\\s*(?<code>(?!TEntity)\\w+)\\s*>",
  report: false,
};
const notFound = {
  kind: "composed",
  name: "repository-not-found",
  template: "{entity}Repository.NotFound",
  parts: { entity: "repository-entities" },
};
const mobile = { name: "mobile", refs: ["mobile-1"], files: ["app/api.ts"], pattern: '"(?<code>[\\w.]+)":' };

const run = (config: unknown) =>
  errorCodesLayer.run({
    config: errorCodesLayer.configSchema.parse(config),
    base,
    revision,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: process.env,
    log: () => {},
  });

describe("error-codes layer with a composed code source", () => {
  it("reports a code built from a part a new usage supplies", async () => {
    const result = await run({ codes: [literal, entities, notFound], clients: [mobile] });
    expect(result.status).toBe("ran");
    if (result.status === "skipped") return;
    expect(result.findings.map((finding) => [finding.id, finding.scope, finding.subject])).toEqual([
      ["error-code-added", "repository-not-found", "FeatureFlagRepository.NotFound"],
      ["error-code-unknown-to-client", "mobile", "FeatureFlagRepository.NotFound"],
    ]);
    expect(result.findings[0]?.evidence).toEqual([
      expect.objectContaining({ side: "revision", path: "src/FeatureFlagRepository.cs", line: 2 }),
    ]);
    expect(result.notes.slice(0, 3)).toEqual([
      'code source "literal": 1 code(s) at base, 1 at revision',
      'code source "repository-entities": 1 code(s) at base, 2 at revision (a part, not reported)',
      'code source "repository-not-found": 1 code(s) at base, 2 at revision',
    ]);
  });

  it("runs when a part source captures nothing at the base", async () => {
    const result = await run({
      codes: [literal, { ...entities, pattern: "RepositoryErrors<\\s*(?<code>FeatureFlag)\\s*>" }, notFound],
      clients: [mobile],
    });
    expect(result.status).toBe("ran");
    if (result.status === "skipped") return;
    expect(result.findings.map((finding) => [finding.id, finding.subject])).toEqual([
      ["error-code-added", "FeatureFlagRepository.NotFound"],
      ["error-code-unknown-to-client", "FeatureFlagRepository.NotFound"],
    ]);
  });

  it("fails when the composed source builds no code at the revision", async () => {
    const result = await run({
      codes: [literal, { ...entities, pattern: "Missing<(?<code>\\w+)>" }, notFound],
      clients: [mobile],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toBe('code source "repository-not-found": builds no code at revision server-2');
    expect(result.findings).toEqual([]);
  });

  it("fails the composed source when its part source fails", async () => {
    const result = await run({
      codes: [literal, { ...entities, files: ["lib/**/*.cs"] }, notFound],
      clients: [mobile],
    });
    expect(result.status === "failed" && result.error).toBe(
      'code source "repository-entities": no file matches lib/**/*.cs at revision server-2; ' +
        'code source "repository-not-found": skipped because part source "repository-entities" failed',
    );
  });
});
