// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const SETTINGS_PATH = "APP/src/Shop.Api/appsettings.json";
const COMPOSE_PATH = "VPS/DOCKER/APPS/docker-compose.yml";

const settings = (...sections: string[]) =>
  [
    "{",
    '  "Logging": { "LogLevel": { "Default": "Information" } }',
    ...sections.map((section) => `  ,${section}`),
    "}",
  ].join("\n");

const compose = (...environment: string[]) =>
  [
    "services:",
    "  api:",
    "    image: shop-api",
    "    environment:",
    "      - ASPNETCORE_ENVIRONMENT=Production",
    ...environment.map((entry) => `      - ${entry}`),
    "",
  ].join("\n");

type JsonFinding = {
  layer: string;
  id: string;
  subject: string;
  topic?: string;
  evidence: { path: string }[];
};
type JsonLayer = { layer: string; status: string; findings: JsonFinding[] };

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: { [SETTINGS_PATH]: settings(), [COMPOSE_PATH]: compose() }, tag: "2.2.4" },
    {
      files: {
        [SETTINGS_PATH]: settings('"Shop": { "BaseUrl": "https://api-shop-dev.example.com" }'),
        [COMPOSE_PATH]: compose("Shop__BaseUrl=${SHOP_BASE_URL}"),
      },
      tag: "2.3.4",
    },
  ]);
  writeRepoFile(
    repo,
    "compat.json",
    JSON.stringify({
      layers: {
        config: { sources: [{ kind: "compose", files: [COMPOSE_PATH] }] },
        outbound: {
          targets: [
            {
              name: "appsettings-urls",
              files: ["APP/**/appsettings.json"],
              pattern: '"BaseUrl"\\s*:\\s*"(?<host>https?://[^"/]+)',
              keyFrom: "appsettings",
              service: "api",
              composeFiles: [COMPOSE_PATH],
            },
          ],
        },
      },
    }),
  );
});
afterAll(() => repo.cleanup());

const CHECK = ["check", "--base", "2.2.4", "--revision", "2.3.4", "--config", "compat.json"];

describe("outbound target whose config key the deploy overrides (issue #127)", () => {
  it("reports the key, not the file's DEV host, with the file and the compose entry as evidence", async () => {
    const run = createIo(repo.dir);
    await main([...CHECK, "--format", "json"], run.io);
    const report = JSON.parse(run.stdout()) as { layers: JsonLayer[] };
    const outbound = report.layers.find((layer) => layer.layer === "outbound");
    expect(outbound?.status).toBe("ran");
    expect(
      outbound?.findings.map((finding) => [
        finding.id,
        finding.subject,
        finding.topic,
        finding.evidence.map((evidence) => evidence.path),
      ]),
    ).toEqual([["outbound-added", "Shop:BaseUrl", "SHOP_BASE_URL", [SETTINGS_PATH, COMPOSE_PATH]]]);
    const config = report.layers.find((layer) => layer.layer === "config");
    expect(config?.findings.map((finding) => [finding.id, finding.subject])).toEqual([
      ["config-key-added-required", "SHOP_BASE_URL"],
    ]);
  });

  it("groups the outbound finding with the config finding of the same key in the Markdown report", async () => {
    const run = createIo(repo.dir);
    await main(CHECK, run.io);
    const markdown = run.stdout();
    expect(markdown).toContain("- **SHOP_BASE_URL** (config, outbound)\n");
    expect(markdown).toContain(
      "`outbound-added` Shop:BaseUrl: outbound call through config key Shop:BaseUrl",
    );
    expect(markdown).not.toContain("outbound call to api-shop-dev.example.com");
  });
});

describe("outbound service lookup without composeFiles", () => {
  const LOCAL_COMPOSE_PATH = "APP/docker-compose.yml";
  let localRepo: TestRepo;

  beforeAll(() => {
    localRepo = createRepo([
      {
        files: {
          [SETTINGS_PATH]: settings(),
          [COMPOSE_PATH]: compose(),
          [LOCAL_COMPOSE_PATH]: compose("Shop__BaseUrl=${SHOP_BASE_URL:-https://localhost:5001}"),
        },
        tag: "2.2.4",
      },
      {
        files: { [SETTINGS_PATH]: settings('"Shop": { "BaseUrl": "https://api-shop-dev.example.com" }') },
        tag: "2.3.4",
      },
    ]);
    const target = {
      name: "appsettings-urls",
      files: ["APP/**/appsettings.json"],
      pattern: '"BaseUrl"\\s*:\\s*"(?<host>https?://[^"/]+)',
      keyFrom: "appsettings",
      service: "api",
    };
    writeRepoFile(
      localRepo,
      "compat.json",
      JSON.stringify({
        layers: {
          config: { sources: [{ kind: "compose", files: [COMPOSE_PATH] }] },
          outbound: { targets: [target] },
        },
      }),
    );
    writeRepoFile(
      localRepo,
      "outbound-only.json",
      JSON.stringify({ layers: { outbound: { targets: [target] } } }),
    );
  });
  afterAll(() => localRepo.cleanup());

  const readOutbound = async (configFile: string) => {
    const run = createIo(localRepo.dir);
    await main(
      ["check", "--base", "2.2.4", "--revision", "2.3.4", "--config", configFile, "--format", "json"],
      run.io,
    );
    const report = JSON.parse(run.stdout()) as { layers: JsonLayer[] };
    return report.layers.find((layer) => layer.layer === "outbound");
  };

  it("reads the config layer's compose sources as the deploy, so a local-dev compose does not set the key", async () => {
    const outbound = await readOutbound("compat.json");
    expect(outbound?.findings.map((finding) => [finding.id, finding.subject])).toEqual([
      ["outbound-added", "api-shop-dev.example.com"],
    ]);
  });

  it("falls back to every compose file without a config compose source", async () => {
    const outbound = await readOutbound("outbound-only.json");
    expect(outbound?.findings.map((finding) => [finding.id, finding.subject])).toEqual([
      ["outbound-added", "Shop:BaseUrl"],
    ]);
  });
});
