import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (side: "base" | "revision", name: string) =>
  readFileSync(new URL(`../fixtures/config/f10/${side}/${name}`, import.meta.url), "utf8");
const files = (side: "base" | "revision") => ({
  "deploy/docker-compose.yml": fixture(side, "docker-compose.yml"),
  ".env.example": fixture(side, ".env.example"),
  "VPS/ANSIBLE/roles/app/tasks/main.yml": fixture(side, "main.yml"),
  "src/Petseo.Api/Settings/ApiSettings.cs": fixture(side, "ApiSettings.cs"),
});
const sources = [
  { kind: "compose" },
  { kind: "dotenv", valuesAreDefaults: true },
  {
    kind: "regex",
    name: "ansible-assert",
    files: ["VPS/ANSIBLE/roles/**/*.yml"],
    pattern: "^\\s*-\\s*app_env\\.(?<key>\\w+) is defined",
    flags: "m",
    comments: "hash",
  },
  {
    kind: "regex",
    name: "dotnet-required",
    files: ["src/**/*Settings.cs"],
    pattern: "public required [\\w<>?]+ (?<key>\\w+) \\{",
    comments: "slash",
  },
];

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: files("base"), tag: "2.2.4" },
    { files: files("revision"), tag: "2.3.4" },
  ]);
  writeRepoFile(repo, "plain.json", JSON.stringify({ layers: { config: { sources } } }));
  writeRepoFile(
    repo,
    "accepted.json",
    JSON.stringify({
      layers: {
        config: {
          sources,
          accept: [
            ...["Shop__BaseUrl", "SHOP_API_KEY"].map((key) => ({
              key,
              id: "config-key-added-required",
              reason: "set in the production vault on 2026-10-06",
            })),
            {
              key: "Logging__Level",
              id: "config-key-default-removed",
              reason: "set in the Ansible inventory",
            },
          ],
        },
      },
    }),
  );
  // Not hex, so a commit hash in the JSON report can never contain it by chance.
  for (const [name, script, timeoutSeconds] of [
    ["presence.json", "printf 'SHOP_API_KEY\\n'", undefined],
    ["presence-values.json", "printf 'SHOP_API_KEY=xyzsecret\\nLogging__Level=xyzsecret\\n'", undefined],
    ["presence-failing.json", "echo SHOP_API_KEY=xyzsecret; exit 2", undefined],
  ] as const) {
    writeRepoFile(
      repo,
      name,
      JSON.stringify({ layers: { config: { sources, presence: { run: script, timeoutSeconds } } } }),
    );
  }
});
afterAll(() => repo.cleanup());

const check = (config: string, ...extra: string[]) => [
  "check",
  "--base",
  "2.2.4",
  "--revision",
  "2.3.4",
  "--config",
  config,
  ...extra,
];

type JsonFinding = {
  subject: string;
  id: string;
  class: string;
  accepted?: unknown;
  evidence: { path: string; line: number }[];
};

async function runJson(...args: string[]) {
  const run = createIo(repo.dir);
  const code = await main([...args, "--format", "json"], run.io);
  const report = JSON.parse(run.stdout()) as { layers: { status: string; findings: JsonFinding[] }[] };
  return { code, layer: report.layers[0], stderr: run.stderr() };
}

describe("config layer end to end (research F10)", () => {
  it("reports the new Shop settings as needs-action and passes the default gate", async () => {
    const { code, layer } = await runJson(...check("plain.json"));
    expect(code).toBe(0);
    expect(layer?.status).toBe("ran");
    const summary = layer?.findings.map((f) => `${f.subject} ${f.id} ${f.class}`);
    expect(summary).toEqual([
      "LOGGING_LEVEL config-key-default-removed needs-action",
      "SHOP_API_KEY config-key-added-required needs-action",
      "SHOP_BASE_URL config-key-added-required needs-action",
      "SHOP_TIMEOUT_SECONDS config-key-added-optional safe",
    ]);
    // The .NET member `ShopBaseUrl` and the `Shop__BaseUrl` of compose and Ansible are one setting.
    const baseUrl = layer?.findings.find((f) => f.subject === "SHOP_BASE_URL");
    expect(baseUrl?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "VPS/ANSIBLE/roles/app/tasks/main.yml:5",
      "deploy/docker-compose.yml:7",
      "src/Petseo.Api/Settings/ApiSettings.cs:10",
    ]);
  });

  it("ignores commented-out declarations and never prints a default value", async () => {
    for (const format of ["md", "json"]) {
      const run = createIo(repo.dir);
      await main([...check("plain.json"), "--format", format], run.io);
      const report = run.stdout();
      for (const hidden of ["Legacy", "Unused", "Information", "shop.example.com", "latest", "localhost"]) {
        expect(report).not.toContain(hidden);
      }
    }
  });

  it("fails the gate at --fail-on needs-action and names the keys in the Markdown report", async () => {
    const run = createIo(repo.dir);
    const code = await main(check("plain.json", "--fail-on", "needs-action"), run.io);
    expect(code).toBe(1);
    const report = run.stdout();
    expect(report).toContain("Shop__BaseUrl");
    expect(report).toContain("`deploy/docker-compose.yml:8` @ 2.3.4");
    expect(report).not.toContain("Legacy__Token");
  });

  it("passes at --fail-on needs-action once the settings are accepted", async () => {
    const { code, layer } = await runJson(...check("accepted.json", "--fail-on", "needs-action"));
    expect(code).toBe(0);
    const accepted = layer?.findings.filter((f) => f.accepted).map((f) => f.subject);
    expect(accepted).toEqual(["LOGGING_LEVEL", "SHOP_API_KEY", "SHOP_BASE_URL"]);
  });
});

describe("config presence end to end (issue #20)", () => {
  it("makes a key the target environment lists safe and keeps the others needs-action", async () => {
    const { layer } = await runJson(...check("presence.json"));
    const summary = layer?.findings
      .filter((f) => f.class !== "safe" || f.id !== "config-key-added-optional")
      .map((f) => `${f.subject} ${f.class}`);
    expect(summary).toEqual([
      "LOGGING_LEVEL needs-action",
      "SHOP_API_KEY safe",
      "SHOP_BASE_URL needs-action",
    ]);
  });

  it("never puts a value the presence command printed into the report", async () => {
    for (const format of ["md", "json"]) {
      const run = createIo(repo.dir);
      await main([...check("presence-values.json"), "--format", format], run.io);
      expect(run.stdout()).toContain("present in the target environment");
      expect(run.stdout()).not.toContain("xyzsecret");
      expect(run.stderr()).not.toContain("xyzsecret");
    }
  });

  it("keeps the classes and adds a note when the presence command fails", async () => {
    const run = createIo(repo.dir);
    await main([...check("presence-failing.json"), "--format", "json"], run.io);
    expect(run.stdout()).not.toContain("xyzsecret");
    const report = JSON.parse(run.stdout()) as {
      layers: { status: string; notes: string[]; findings: JsonFinding[] }[];
    };
    const layer = report.layers[0];
    expect(layer?.status).toBe("ran");
    expect(layer?.findings.find((f) => f.subject === "SHOP_API_KEY")?.class).toBe("needs-action");
    expect(layer?.notes).toContain(
      "presence command exited 2; keys that need a value in production stay unresolved",
    );
  });
});
