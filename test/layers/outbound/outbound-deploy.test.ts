// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { outboundLayer } from "../../../src/layers/outbound/outbound-layer.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

const settings = (sections: Record<string, string>) =>
  [
    "{",
    '  "Logging": { "LogLevel": { "Default": "Information" } },',
    ...Object.entries(sections).map(
      ([section, url], index, all) =>
        `  "${section}": { "BaseUrl": "${url}" }${index < all.length - 1 ? "," : ""}`,
    ),
    "}",
  ].join("\n");

const compose = (environment: string[]) =>
  [
    "services:",
    "  api:",
    "    image: api",
    "    environment:",
    ...environment.map((line) => `      - ${line}`),
    "",
  ].join("\n");

const BASE_SETTINGS = settings({ Payments: "https://pay-dev.example.com" });
const REVISION_SETTINGS = settings({
  Payments: "https://pay-dev2.example.com",
  Shop: "https://api-shop-dev.example.com",
  Maps: "https://maps.example.com/api",
});
const DEPLOY = compose(["Payments__BaseUrl=${PAYMENTS_BASE_URL}", "Shop__BaseUrl=${SHOP_BASE_URL}"]);
// A local-dev compose overrides Maps too; only the deploy file counts.
const LOCAL = compose(["Maps__BaseUrl=http://localhost:5000"]);
const CLIENT = 'var url = Environment.GetEnvironmentVariable("CRM_URL") ?? "https://crm-dev.example.com/v1";';

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    {
      files: {
        "src/Api/appsettings.json": BASE_SETTINGS,
        "deploy/docker-compose.yml": compose(["Payments__BaseUrl=${PAYMENTS_BASE_URL}"]),
      },
      tag: "2.2.4",
    },
    {
      files: {
        "src/Api/appsettings.json": REVISION_SETTINGS,
        "deploy/docker-compose.yml": [DEPLOY.trimEnd(), "      - CRM_URL=${CRM_URL}", ""].join("\n"),
        "docker-compose.local.yml": LOCAL,
        "src/Api/Crm.cs": CLIENT,
      },
      tag: "2.3.7",
    },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-outbound-deploy-"));
  const opened = await Promise.all([
    openRefTree({ repoDir: repo.dir, ref: "2.2.4", side: "base", tempRoot }),
    openRefTree({ repoDir: repo.dir, ref: "2.3.7", side: "revision", tempRoot }),
  ]);
  if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
  base = opened[0].value;
  revision = opened[1].value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

const appsettingsUrls = {
  name: "appsettings-urls",
  files: ["src/**/appsettings.json"],
  pattern: '"BaseUrl"\\s*:\\s*"(?<host>https?://[^"/]+)',
  keyFrom: "appsettings",
  service: "api",
  composeFiles: ["deploy/docker-compose.yml"],
};

const run = (config: unknown) =>
  outboundLayer.run({
    config: outboundLayer.configSchema.parse(config),
    base,
    revision,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: process.env,
    log: () => {},
  });

describe("outbound layer with deploy overrides", () => {
  it("reports a URL the deploy overrides by its key, keeps the file host as evidence and topics it with config", async () => {
    const result = await run({ targets: [appsettingsUrls] });
    if (result.status !== "ran") throw new Error(`layer did not run: ${JSON.stringify(result)}`);
    // Payments changed only its file default, which production never calls: no finding.
    expect(result.findings.map((finding) => [finding.id, finding.subject, finding.topic])).toEqual([
      ["outbound-added", "Shop:BaseUrl", "SHOP_BASE_URL"],
      ["outbound-added", "maps.example.com", undefined],
    ]);
    const shop = result.findings[0];
    expect(shop?.class).toBe("needs-action");
    expect(shop?.message).toBe(
      "outbound call through config key Shop:BaseUrl (SHOP_BASE_URL at deploy via Shop__BaseUrl of compose service api; " +
        "file default api-shop-dev.example.com) is new in the revision; production calls the host the deploy sets, " +
        "not the file default; check that production allows that host (API enabled for the credential, key " +
        "restrictions, quotas, egress rules)",
    );
    expect(shop?.evidence).toEqual([
      { side: "revision", ref: "2.3.7", commit: revision.commit, path: "src/Api/appsettings.json", line: 4 },
      { side: "revision", ref: "2.3.7", commit: revision.commit, path: "deploy/docker-compose.yml", line: 6 },
    ]);
    expect(result.notes).toEqual([
      'target source "appsettings-urls": 1 target(s) at base, 3 at revision; 2 at revision read from a key compose service "api" sets',
    ]);
  });

  it("without a deploy service reports the file hosts, as before", async () => {
    const { keyFrom: _keyFrom, service: _service, composeFiles: _files, ...plain } = appsettingsUrls;
    const result = await run({ targets: [plain] });
    if (result.status !== "ran") throw new Error("layer did not run");
    expect(result.findings.map((finding) => [finding.id, finding.subject])).toEqual([
      ["outbound-added", "api-shop-dev.example.com"],
      ["outbound-added", "maps.example.com"],
      ["outbound-added", "pay-dev2.example.com"],
      ["outbound-removed", "pay-dev.example.com"],
    ]);
  });

  it("takes the key from a (?<key>...) group and accepts the finding by its key", async () => {
    const result = await run({
      targets: [
        appsettingsUrls,
        {
          name: "env-fallback",
          files: ["src/**/*.cs"],
          pattern:
            'GetEnvironmentVariable\\("(?<key>\\w+)"\\) \\?\\? "(?<host>https://[^"/]+)(?<path>[^"]*)"',
          service: "api",
          composeFiles: ["deploy/docker-compose.yml"],
        },
      ],
      accept: [{ target: "CRM_URL", reason: "CRM_URL set to the production CRM in the vault" }],
    });
    if (result.status !== "ran") throw new Error("layer did not run");
    const crm = result.findings.find((finding) => finding.subject === "CRM_URL");
    expect(crm?.scope).toBe("env-fallback");
    expect(crm?.topic).toBe("CRM_URL");
    expect(crm?.accepted).toEqual({ reason: "CRM_URL set to the production CRM in the vault" });
    expect(crm?.message).toContain("file default crm-dev.example.com/v1");
  });

  it("fails when the deploy service is in no compose file of the revision", async () => {
    const result = await run({ targets: [{ ...appsettingsUrls, service: "web" }] });
    expect(result).toMatchObject({
      status: "failed",
      error:
        'target source "appsettings-urls": compose service "web" is not in any file matching "deploy/docker-compose.yml" in the revision',
      findings: [],
    });
  });

  it("rejects a key without a service, a service without a key and keyFrom next to a key group", () => {
    const parsed = outboundLayer.configSchema.safeParse({
      targets: [
        { name: "a", files: ["x"], pattern: '"(?<host>[^"]+)"', keyFrom: "appsettings" },
        { name: "b", files: ["x"], pattern: '(?<key>\\w+)="(?<host>[^"]+)"' },
        { name: "c", files: ["x"], pattern: '"(?<host>[^"]+)"', service: "api" },
        {
          name: "d",
          files: ["x"],
          pattern: '(?<key>\\w+)="(?<host>[^"]+)"',
          keyFrom: "appsettings",
          service: "api",
        },
      ],
    });
    expect(parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["targets.0.service", "is required when targets carry a key (`keyFrom` or a (?<key>...) group)"],
      ["targets.1.service", "is required when targets carry a key (`keyFrom` or a (?<key>...) group)"],
      [
        "targets.2.service",
        "needs a key for each target: set `keyFrom` or add a named group (?<key>...) to `pattern`",
      ],
      ["targets.3.keyFrom", "cannot be combined with a (?<key>...) group in `pattern`; use one of them"],
    ]);
  });
});
