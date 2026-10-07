// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

  it("reports a new pass-through environment entry as a required key", async () => {
    const passRepo = createRepo([
      { files: { "docker-compose.yml": "services:\n  app:\n    environment:\n      - KEPT\n" }, tag: "v1" },
      {
        files: {
          "docker-compose.yml": "services:\n  app:\n    environment:\n      - KEPT\n      - NEW_SECRET\n",
        },
        tag: "v2",
      },
    ]);
    try {
      const opened = await Promise.all([
        openRefTree({ repoDir: passRepo.dir, ref: "v1", side: "base", tempRoot }),
        openRefTree({ repoDir: passRepo.dir, ref: "v2", side: "revision", tempRoot }),
      ]);
      if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
      const result = await run(
        { sources: [{ kind: "compose" }] },
        { base: opened[0].value, revision: opened[1].value },
      );
      expect(result.status).toBe("ran");
      if (result.status !== "ran") return;
      expect(result.findings.map((f) => `${f.subject} ${f.id} ${f.class}`)).toEqual([
        "NEW_SECRET config-key-added-required needs-action",
      ]);
      expect(result.findings[0]?.evidence).toEqual([
        expect.objectContaining({ path: "docker-compose.yml", line: 5 }),
      ]);
    } finally {
      passRepo.cleanup();
    }
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
    expect(result.findings.find((f) => f.subject === "SHOP_API_KEY")).toMatchObject({
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

describe("config layer key normalization (issue #18)", () => {
  let shopRepo: TestRepo;
  let shopBase: RefTree;
  let shopRevision: RefTree;
  const settings = (section: string) =>
    `public sealed class ${section}Settings\n{\n    public required string BaseUrl { get; init; }\n}\n`;
  const dotnet = {
    kind: "regex",
    name: "dotnet-required",
    files: ["src/**/*Settings.cs"],
    pattern: "public required [\\w<>?]+ (?<member>\\w+) \\{",
    enclosing: "class (?<section>\\w+?)Settings\\b",
    key: "{section}__{member}",
    comments: "slash",
  };
  const sources = [
    { kind: "compose" },
    {
      kind: "regex",
      name: "ansible-template",
      files: ["roles/**/*.j2"],
      pattern: "^(?<key>\\w+)=",
      flags: "m",
    },
    dotnet,
  ];

  beforeAll(async () => {
    shopRepo = createRepo([
      {
        files: {
          "docker-compose.yml": "x: ${KEPT}\n",
          "roles/app/templates/env.j2": "Kept=1\n",
          "src/Api/PaymentSettings.cs": settings("Payment"),
        },
        tag: "v1",
      },
      {
        files: {
          "docker-compose.yml": "x: ${KEPT}\ny: ${SHOP_BASE_URL}\n",
          "roles/app/templates/env.j2": "Kept=1\nShop__BaseUrl={{ shop_base_url }}\n",
          "src/Api/ShopSettings.cs": settings("Shop"),
        },
        tag: "v2",
      },
    ]);
    const opened = await Promise.all([
      openRefTree({ repoDir: shopRepo.dir, ref: "v1", side: "base", tempRoot }),
      openRefTree({ repoDir: shopRepo.dir, ref: "v2", side: "revision", tempRoot }),
    ]);
    if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
    shopBase = opened[0].value;
    shopRevision = opened[1].value;
  });

  afterAll(() => shopRepo.cleanup());

  const runShop = (config: unknown) => run(config, { base: shopBase, revision: shopRevision });

  it("reports one setting spelled three ways in three sources as one finding with three evidence entries", async () => {
    const result = await runShop({ sources });
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const required = result.findings.filter((f) => f.id === "config-key-added-required");
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({
      subject: "SHOP_BASE_URL",
      scope: "ansible-template, compose, dotnet-required",
      message: expect.stringContaining("(spelled SHOP_BASE_URL, Shop__BaseUrl)"),
    });
    expect(required[0]?.evidence.map((e) => `${e.side} ${e.path}:${e.line}`)).toEqual([
      "revision docker-compose.yml:2",
      "revision roles/app/templates/env.j2:2",
      "revision src/Api/ShopSettings.cs:3",
    ]);
  });

  it("keeps the BaseUrl members of two settings classes as two keys", async () => {
    // PaymentSettings.BaseUrl exists at both refs; were it the same key as ShopSettings.BaseUrl, nothing would be new.
    const result = await runShop({ sources });
    expect(summary(result)).toEqual([
      "SHOP_BASE_URL config-key-added-required ansible-template, compose, dotnet-required",
    ]);
    expect(result.status === "ran" && result.notes).toContain(
      'source "dotnet-required": 1 key(s) in 1 file(s) at base, 2 key(s) in 2 file(s) at revision (src/Api/PaymentSettings.cs, src/Api/ShopSettings.cs)',
    );
  });

  it("compares keys as written in exact mode", async () => {
    const result = await runShop({ sources, keyMatching: "exact" });
    expect(summary(result)).toEqual([
      "SHOP_BASE_URL config-key-added-required compose",
      "Shop__BaseUrl config-key-added-required ansible-template, dotnet-required",
    ]);
  });

  it("prepends a source prefix before keys are compared, and accepts by any spelling", async () => {
    const result = await runShop({
      sources: [
        { kind: "compose" },
        {
          ...dotnet,
          pattern: "public required [\\w<>?]+ (?<key>\\w+) \\{",
          enclosing: undefined,
          key: undefined,
          files: ["src/**/ShopSettings.cs"],
          prefix: "Shop:",
        },
      ],
      accept: [{ key: "shop.base_url", id: "config-key-added-required", reason: "in the vault" }],
    });
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      subject: "SHOP_BASE_URL",
      scope: "compose, dotnet-required",
      accepted: { reason: "in the vault" },
    });
  });

  describe("chains", () => {
    let chainRepo: TestRepo;
    let chainBase: RefTree;
    let chainRevision: RefTree;
    let chainComplete: RefTree;

    const chainSources = [
      { kind: "compose" },
      {
        kind: "regex",
        name: "ansible-template",
        files: ["roles/app/templates/env.j2"],
        pattern: "^(?<key>\\w+)=",
        flags: "m",
      },
      ...["dev", "prod"].map((env) => ({
        kind: "regex",
        name: `deploy-${env}`,
        files: [`.github/workflows/deploy-${env}.yml`],
        pattern: "^\\s+(?<key>[A-Z_]+): \\$\\{\\{ secrets\\.",
        flags: "m",
      })),
    ];
    const chains = [
      { name: "app-env", sources: ["compose", "ansible-template", "deploy-prod"] },
      { name: "dev-prod-parity", sources: ["deploy-dev", "deploy-prod"] },
    ];
    const workflow = (...keys: string[]) =>
      `jobs:\n  deploy:\n    env:\n${keys.map((key) => `      ${key}: \${{ secrets.${key} }}\n`).join("")}`;

    beforeAll(async () => {
      chainRepo = createRepo([
        {
          files: {
            "docker-compose.yml": "a: ${DB_URL}\n",
            "roles/app/templates/env.j2": "DB_URL={{ db_url }}\n",
            ".github/workflows/deploy-dev.yml": workflow("DB_URL"),
            ".github/workflows/deploy-prod.yml": workflow("DB_URL"),
          },
          tag: "v1",
        },
        {
          files: {
            "docker-compose.yml": "a: ${DB_URL}\nb: ${SHOP_API_KEY}\n",
            "roles/app/templates/env.j2": "DB_URL={{ db_url }}\nShop__ApiKey={{ shop_api_key }}\n",
            ".github/workflows/deploy-dev.yml": workflow("DB_URL", "SHOP_API_KEY"),
            ".github/workflows/deploy-prod.yml": workflow("DB_URL"),
          },
          tag: "v2",
        },
        {
          files: { ".github/workflows/deploy-prod.yml": workflow("DB_URL", "SHOP_API_KEY") },
          tag: "v3",
        },
      ]);
      const opened = await Promise.all([
        openRefTree({ repoDir: chainRepo.dir, ref: "v1", side: "base", tempRoot }),
        openRefTree({ repoDir: chainRepo.dir, ref: "v2", side: "revision", tempRoot }),
        openRefTree({ repoDir: chainRepo.dir, ref: "v3", side: "revision", tempRoot }),
      ]);
      if (!opened[0].ok || !opened[1].ok || !opened[2].ok) throw new Error("cannot open refs");
      chainBase = opened[0].value;
      chainRevision = opened[1].value;
      chainComplete = opened[2].value;
    });

    afterAll(() => chainRepo.cleanup());

    const chainFindings = (result: LayerResult) =>
      result.status === "skipped"
        ? []
        : result.findings
            .filter((f) => f.id === "config-chain-missing")
            .map((f) => `${f.subject} ${f.class} ${f.scope}: ${f.message}`);

    it("reports a key added to compose, the template and deploy-dev but not to deploy-prod", async () => {
      const result = await run(
        { sources: chainSources, chains },
        { base: chainBase, revision: chainRevision },
      );
      expect(result.status).toBe("ran");
      expect(chainFindings(result)).toEqual([
        "SHOP_API_KEY needs-action chain app-env: the key is in compose, ansible-template but missing from deploy-prod; every source of the chain must have it",
        "SHOP_API_KEY needs-action chain dev-prod-parity: the key is in deploy-dev but missing from deploy-prod; every source of the chain must have it",
      ]);
    });

    it("reports nothing when every source of the chain has the key", async () => {
      const result = await run(
        { sources: chainSources, chains },
        { base: chainBase, revision: chainComplete },
      );
      expect(result.status).toBe("ran");
      expect(chainFindings(result)).toEqual([]);
    });

    it("accepts an intentional asymmetry by key and chain and notes the entry", async () => {
      const result = await run(
        {
          sources: chainSources,
          chains,
          accept: [{ key: "shop.api_key", chain: "dev-prod-parity", reason: "rolled out to DEV first" }],
        },
        { base: chainBase, revision: chainRevision },
      );
      if (result.status !== "ran") throw new Error(`layer ${result.status}`);
      const accepted = result.findings.filter((f) => f.accepted !== undefined).map((f) => f.scope);
      expect(accepted).toEqual(["chain dev-prod-parity"]);
      expect(result.notes).toContain(
        "accept entry for chain dev-prod-parity on shop.api_key accepted 1 finding(s)",
      );
    });
  });

  it("runs the presence command in the repository only when a finding needs a value in production", async () => {
    const marker = join(tempRoot, "presence-ran");
    const optionalOnly = await run({
      sources: [{ kind: "compose", files: ["deploy/compose.prod.yaml"] }],
      presence: { run: `touch "${marker}"` },
    });
    expect(summary(optionalOnly)).toEqual(["PROD_ONLY config-key-added-optional compose"]);
    expect(existsSync(marker)).toBe(false);
    const required = await run({
      sources: [{ kind: "compose" }],
      presence: { run: `pwd > "${marker}"; echo new` },
    });
    expect(readFileSync(marker, "utf8").trim()).toBe(realpathSync(repo.dir));
    expect(required.status === "ran" && required.findings.map((f) => `${f.subject} ${f.class}`)).toEqual([
      "NEW safe",
      "OLD safe",
      "PROD_ONLY safe",
    ]);
    expect(required.status === "ran" && required.notes).toContain(
      "presence command listed 1 key(s) in the target environment",
    );
  });
});
