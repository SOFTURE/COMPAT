import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const packageLock = (express: string, amqplib: string) =>
  json({
    name: "web",
    lockfileVersion: 3,
    packages: {
      "": { name: "web", dependencies: { express: "^4.1.0", "amqp-wrapper": "^1.0.0" } },
      "node_modules/amqp-wrapper": { version: "1.0.0" },
      "node_modules/amqp-wrapper/node_modules/amqplib": { version: amqplib },
      "node_modules/express": { version: express },
    },
  });

const PNPM_V6 = [
  "lockfileVersion: '6.0'",
  "",
  "importers:",
  "",
  "  .: {}",
  "",
  "  apps/api:",
  "    dependencies:",
  "      zod:",
  "        specifier: ^3.22.0",
  "        version: 3.22.4",
  "",
  "packages:",
  "",
  "  /zod@3.22.4:",
  "    resolution: {integrity: sha512-a}",
  "",
].join("\n");

const pnpmV9 = (lockfileVersion: string) =>
  [
    `lockfileVersion: '${lockfileVersion}'`,
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "  apps/api:",
    "    dependencies:",
    "      zod:",
    "        specifier: ^3.22.0",
    "        version: 3.23.8",
    "",
    "packages:",
    "",
    "  zod@3.23.8:",
    "    resolution: {integrity: sha512-b}",
    "",
  ].join("\n");

const nugetLock = (npgsql: string, broker: string) =>
  json({
    version: 2,
    dependencies: {
      "net8.0": {
        Npgsql: { type: "Direct", requested: "[8.0.0, )", resolved: npgsql },
        "SOFTURE.MessageBroker": { type: "CentralTransitive", requested: "[1.0.0, )", resolved: broker },
        "Microsoft.Extensions.Logging": { type: "Transitive", resolved: "8.0.0" },
      },
    },
  });

const unchanged = {
  "web/package.json": json({ name: "web", dependencies: { express: "^4.1.0", "amqp-wrapper": "^1.0.0" } }),
  "pnpm/package.json": json({ name: "root", private: true }),
  "pnpm/apps/api/package.json": json({ name: "api", dependencies: { zod: "^3.22.0" } }),
  "api/Api.csproj":
    '<Project>\n  <ItemGroup>\n    <PackageReference Include="Npgsql" Version="8.0.0" />\n  </ItemGroup>\n</Project>\n',
};

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        ...unchanged,
        "web/package-lock.json": packageLock("4.1.0", "0.10.3"),
        "pnpm/pnpm-lock.yaml": PNPM_V6,
        "api/packages.lock.json": nugetLock("8.0.0", "1.4.0"),
      },
      tag: "1.0.0",
    },
    {
      files: {
        "web/package-lock.json": packageLock("4.9.0", "0.10.4"),
        "pnpm/pnpm-lock.yaml": pnpmV9("9.0"),
        "api/packages.lock.json": nugetLock("8.0.3", "2.0.0"),
      },
      tag: "1.1.0",
    },
    { files: { "pnpm/pnpm-lock.yaml": pnpmV9("10.0") }, tag: "1.2.0" },
  ]);
  const watch = [
    { name: "amqplib", class: "needs-action" },
    { name: "SOFTURE.*", class: "needs-action" },
  ];
  writeRepoFile(repo, "locked.json", json({ layers: { dependencies: { watch } } }));
  writeRepoFile(
    repo,
    "declared.json",
    json({
      layers: {
        dependencies: {
          sources: [
            { kind: "nuget", lockfiles: false },
            { kind: "npm", lockfiles: false },
          ],
          watch,
        },
      },
    }),
  );
});
afterAll(() => repo.cleanup());

type JsonLayer = {
  status: string;
  error?: string;
  notes?: string[];
  findings: {
    subject: string;
    id: string;
    class: string;
    message: string;
    evidence: { path: string; line: number }[];
  }[];
};

async function runJson(config: string, revision = "1.1.0") {
  const run = createIo(repo.dir);
  const args = ["check", "--base", "1.0.0", "--revision", revision, "--config", config, "--format", "json"];
  const code = await main(args, run.io);
  const report = JSON.parse(run.stdout()) as { layers: JsonLayer[] };
  return { code, layer: report.layers[0] as JsonLayer };
}

describe("dependencies layer with lockfiles end to end (CMP-10)", () => {
  it("reports lockfile-only upgrades of direct dependencies and watched transitive packages", async () => {
    const { layer } = await runJson("locked.json");
    expect(layer.status).toBe("ran");
    expect(layer.findings.map((f) => `${f.subject} ${f.class}: ${f.message}`)).toEqual([
      "amqplib needs-action: 0.10.3 → 0.10.4: patch upgrade; transitive, resolved from lockfile; watched package (amqplib)",
      "express safe: 4.1.0 → 4.9.0: minor upgrade; resolved from lockfile",
      "zod safe: 3.22.4 → 3.23.8: minor upgrade; resolved from lockfile",
      "Npgsql safe: 8.0.0 → 8.0.3: patch upgrade; resolved from lockfile",
      "SOFTURE.MessageBroker needs-action: 1.4.0 → 2.0.0: major upgrade; transitive, resolved from lockfile",
    ]);
    expect(layer.findings[1]?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "web/package-lock.json:18",
      "web/package-lock.json:18",
    ]);
    expect(layer.findings[2]?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "pnpm/pnpm-lock.yaml:11",
      "pnpm/pnpm-lock.yaml:11",
    ]);
    expect(layer.notes).toContain("npm: resolved versions from 2 lockfile(s) at the base, 2 in the revision");
    expect(layer.notes).toContain(
      "nuget: resolved versions from 1 lockfile(s) at the base, 1 in the revision",
    );
  });

  it("compares declared ranges only when lockfiles are turned off", async () => {
    const { layer } = await runJson("declared.json");
    expect(layer.status).toBe("ran");
    expect(layer.findings).toEqual([]);
  });

  it("fails naming the lockfile when its format is not supported", async () => {
    const { code, layer } = await runJson("locked.json", "1.2.0");
    expect(code).toBe(1);
    expect(layer.status).toBe("failed");
    expect(layer.error).toBe(
      "npm source: at 1.2.0: pnpm/pnpm-lock.yaml: lockfileVersion '10.0' is not supported (supported: 5.x, 6.x, 9.x)",
    );
  });
});
