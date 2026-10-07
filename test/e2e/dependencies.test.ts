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
