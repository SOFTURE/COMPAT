import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (path: string) =>
  readFileSync(new URL(`../fixtures/dependencies/f9/${path}`, import.meta.url), "utf8");
const files = (side: "base" | "revision") => ({
  "APP/Directory.Packages.props": fixture(`${side}/Directory.Packages.props`),
  "APP/src/Petseo.Api/Petseo.Api.csproj": fixture("Petseo.Api.csproj"),
});

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: files("base"), tag: "2.2.4" },
    { files: files("revision"), tag: "2.3.4" },
  ]);
  writeRepoFile(repo, "plain.json", JSON.stringify({ layers: { dependencies: {} } }));
  writeRepoFile(
    repo,
    "configured.json",
    JSON.stringify({
      layers: {
        dependencies: {
          sources: [{ kind: "nuget" }],
          watch: [{ name: "SOFTURE.*", releaseNotes: "https://github.com/SOFTURE/MessageBroker/releases" }],
          ignore: ["xunit*"],
          accept: [
            {
              id: "dependency-upgraded",
              name: "SOFTURE.MessageBroker.Rabbit",
              reason: "retry policy reviewed",
            },
          ],
        },
      },
    }),
  );
  writeRepoFile(
    repo,
    "npm-only.json",
    JSON.stringify({ layers: { dependencies: { sources: [{ kind: "npm" }] } } }),
  );
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
  "--format",
  "json",
  ...extra,
];

type JsonLayer = {
  status: string;
  error?: string;
  notes?: string[];
  findings: {
    subject: string;
    id: string;
    class: string;
    message: string;
    accepted?: unknown;
    evidence: { path: string; line: number }[];
  }[];
};

async function runJson(...args: string[]) {
  const run = createIo(repo.dir);
  const code = await main(args, run.io);
  const report = JSON.parse(run.stdout()) as { layers: JsonLayer[] };
  return { code, layer: report.layers[0] as JsonLayer };
}

describe("dependencies layer end to end (research F9)", () => {
  it("reports the 0.x → 1.x broker upgrade as needs-action and a minor upgrade as safe", async () => {
    const { code, layer } = await runJson(...check("plain.json", "--fail-on", "needs-action"));
    expect(code).toBe(1);
    expect(layer.status).toBe("ran");
    expect(layer.findings.map((f) => `${f.subject} ${f.id} ${f.class}`)).toEqual([
      "Npgsql dependency-upgraded safe",
      "SOFTURE.MessageBroker.Rabbit dependency-upgraded needs-action",
      "xunit dependency-upgraded safe",
    ]);
    const rabbit = layer.findings[1];
    expect(rabbit?.message).toBe("0.4.0 → 1.2.0: major upgrade");
    expect(rabbit?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "APP/Directory.Packages.props:7",
      "APP/Directory.Packages.props:7",
    ]);
  });

  it("drops ignored test packages, prints release notes and honours accept", async () => {
    const { code, layer } = await runJson(...check("configured.json", "--fail-on", "needs-action"));
    expect(code).toBe(0);
    expect(layer.findings.map((f) => f.subject)).toEqual(["Npgsql", "SOFTURE.MessageBroker.Rabbit"]);
    expect(layer.findings[1]?.message).toContain(
      "release notes: https://github.com/SOFTURE/MessageBroker/releases",
    );
    expect(layer.findings[1]?.accepted).toEqual({ reason: "retry policy reviewed" });
    expect(layer.notes).toContain('1 changed or declared package(s) skipped by "ignore"');
  });

  it("fails when no dependency file matches at either ref", async () => {
    const { code, layer } = await runJson(...check("npm-only.json"));
    expect(code).toBe(1);
    expect(layer.status).toBe("failed");
    expect(layer.error).toContain("no dependency file matched");
  });
});

describe("dependencies layer with MSBuild properties (CMP-9)", () => {
  const csproj = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <ItemGroup>",
    '    <PackageReference Include="MassTransit" Version="$(MassTransitVersion)" />',
    '    <PackageReference Include="Polly" Version="$(PollyVersion)" />',
    '    <PackageReference Include="Serilog" Version="$(SerilogVersion)" />',
    "  </ItemGroup>",
    "</Project>",
  ].join("\n");
  const buildProps = (massTransit: string, serilogImport: string) =>
    [
      "<Project>",
      '  <Import Project="$(MSBuildThisFileDirectory)eng/Versions.props" />',
      `  <Import Project="${serilogImport}" />`,
      `  <PropertyGroup><MassTransitVersion>${massTransit}</MassTransitVersion></PropertyGroup>`,
      "</Project>",
    ].join("\n");
  const versions = (polly: string) =>
    `<Project><PropertyGroup><PollyVersion>${polly}</PollyVersion></PropertyGroup></Project>`;
  const serilog = "<Project><PropertyGroup><SerilogVersion>4.0.0</SerilogVersion></PropertyGroup></Project>";

  let propertyRepo: TestRepo;

  beforeAll(() => {
    propertyRepo = createRepo([
      {
        files: {
          "Directory.Build.props": buildProps("8.1.0", "eng/Serilog.props"),
          "eng/Versions.props": versions("7.2.4"),
          "eng/Serilog.props": serilog,
          "src/Api/Api.csproj": csproj,
        },
        tag: "1.0.0",
      },
      {
        files: {
          "Directory.Build.props": buildProps("8.2.0", "$(RepoRoot)eng/Serilog.props"),
          "eng/Versions.props": versions("8.0.0"),
        },
        tag: "1.1.0",
      },
    ]);
    writeRepoFile(
      propertyRepo,
      "nuget.json",
      JSON.stringify({ layers: { dependencies: { sources: [{ kind: "nuget" }] } } }),
    );
  });
  afterAll(() => propertyRepo.cleanup());

  it("compares versions held in Directory.Build.props and its imports, and explains an unresolved one", async () => {
    const run = createIo(propertyRepo.dir);
    const args = [
      "check",
      "--base",
      "1.0.0",
      "--revision",
      "1.1.0",
      "--config",
      "nuget.json",
      "--format",
      "json",
    ];
    await main(args, run.io);
    const layer = (JSON.parse(run.stdout()) as { layers: JsonLayer[] }).layers[0] as JsonLayer;
    expect(layer.status).toBe("ran");
    expect(layer.findings.map((f) => `${f.subject} ${f.id} ${f.class}: ${f.message}`)).toEqual([
      "MassTransit dependency-upgraded safe: 8.1.0 → 8.2.0: minor upgrade",
      "Polly dependency-upgraded needs-action: 7.2.4 → 8.0.0: major upgrade",
      "Serilog dependency-changed needs-action: 4.0.0 → $(SerilogVersion): $(SerilogVersion) is not defined in " +
        "src/Api/Api.csproj, its Directory.Build.props, Directory.Packages.props, Directory.Build.targets or " +
        "in-repository imports; imports not followed: Directory.Build.props: $(RepoRoot)eng/Serilog.props " +
        "(a property in the path); compare by hand",
    ]);
    expect(layer.findings[0]?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "src/Api/Api.csproj:3",
      "src/Api/Api.csproj:3",
    ]);
    expect(layer.notes).toContain(
      "1 NuGet version(s) keep an undefined MSBuild property at the revision: " +
        "Serilog $(SerilogVersion) (src/Api/Api.csproj:5)",
    );
  });
});
