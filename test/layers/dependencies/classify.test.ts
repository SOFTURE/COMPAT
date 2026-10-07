import { describe, expect, it } from "vitest";
import type { RefTree } from "../../../src/git/ref-tree.js";
import {
  addDeclarations,
  applyAccept,
  classifyPackages,
  type PackageIndex,
} from "../../../src/layers/dependencies/classify.js";
import type { WatchEntry } from "../../../src/layers/dependencies/config.js";
import type { Declaration, Ecosystem } from "../../../src/layers/dependencies/declaration.js";
import type { Finding } from "../../../src/model/finding.js";

const tree = (side: "base" | "revision"): RefTree => ({
  side,
  ref: side === "base" ? "v1" : "v2",
  commit: side === "base" ? "a".repeat(40) : "b".repeat(40),
  listFiles: async () => ({ ok: true, value: [] }),
  readFile: async () => ({ ok: true, value: null }),
  materialize: async () => ({ ok: false, error: "not used" }),
});

type Entry = [name: string, version: string, path?: string, ecosystem?: Ecosystem];

function index(...entries: Entry[]): PackageIndex {
  const result: PackageIndex = new Map();
  const declarations: Declaration[] = entries.map(
    ([name, version, path = "Directory.Packages.props", ecosystem = "nuget"], line) => ({
      ecosystem,
      name,
      version,
      path,
      line: line + 1,
    }),
  );
  addDeclarations(result, declarations);
  return result;
}

type Options = { watch?: WatchEntry[]; ignore?: string[] };

const classify = (base: PackageIndex, revision: PackageIndex, options: Options = {}) =>
  classifyPackages({
    base,
    revision,
    baseTree: tree("base"),
    revisionTree: tree("revision"),
    watch: options.watch ?? [],
    ignore: options.ignore ?? [],
  });
const summary = (findings: Finding[]) => findings.map((f) => `${f.subject} ${f.id} ${f.class}`);

describe("classifyPackages", () => {
  it("classifies upgrades by semver and leaves unchanged packages out", () => {
    const { findings } = classify(
      index(
        ["SOFTURE.MessageBroker.Rabbit", "0.4.0"],
        ["Npgsql", "3.1.0"],
        ["Dapper", "2.1.0"],
        ["Polly", "0.4.0"],
      ),
      index(
        ["SOFTURE.MessageBroker.Rabbit", "1.2.0"],
        ["Npgsql", "3.2.0"],
        ["Dapper", "2.1.0"],
        ["Polly", "0.5.0"],
      ),
    );
    expect(summary(findings)).toEqual([
      "Npgsql dependency-upgraded safe",
      "Polly dependency-upgraded needs-action",
      "SOFTURE.MessageBroker.Rabbit dependency-upgraded needs-action",
    ]);
    const rabbit = findings[2] as Finding;
    expect(rabbit.message).toBe("0.4.0 → 1.2.0: major upgrade");
    expect(rabbit.scope).toBe("nuget");
    expect(rabbit.evidence).toEqual([
      { side: "base", ref: "v1", commit: "a".repeat(40), path: "Directory.Packages.props", line: 1 },
      { side: "revision", ref: "v2", commit: "b".repeat(40), path: "Directory.Packages.props", line: 1 },
    ]);
    expect((findings[1] as Finding).message).toBe(
      "0.4.0 → 0.5.0: minor below 1.0, breaking under semver upgrade",
    );
  });

  it("reports added, removed, downgraded and unparseable changes", () => {
    const { findings } = classify(
      index(["Old", "1.0.0"], ["Serilog", "4.1.0"], ["Floating", "1.0.0"]),
      index(["New", "2.0.0"], ["Serilog", "4.0.0"], ["Floating", "$(Missing)"]),
    );
    expect(summary(findings)).toEqual([
      "Floating dependency-changed needs-action",
      "New dependency-added safe",
      "Old dependency-removed safe",
      "Serilog dependency-downgraded needs-action",
    ]);
  });

  it("names the undefined property of an unresolved version in dependency-changed", () => {
    const revision = index(["MassTransit", "$(MassTransitVersion)", "Api.csproj"]);
    const declaration = revision.get("nuget:masstransit")?.declarations[0] as Declaration;
    declaration.unresolved = "$(MassTransitVersion) is not defined in Api.csproj";
    const { findings } = classify(index(["MassTransit", "8.1.0", "Api.csproj"]), revision);
    expect(findings.map((f) => f.message)).toEqual([
      "8.1.0 → $(MassTransitVersion): $(MassTransitVersion) is not defined in Api.csproj; compare by hand",
    ]);
  });

  it("matches NuGet names case-insensitively and npm names exactly", () => {
    expect(summary(classify(index(["npgsql", "3.1.0"]), index(["Npgsql", "3.1.0"])).findings)).toEqual([]);
    const npm = classify(
      index(["React", "18.0.0", "package.json", "npm"]),
      index(["react", "18.0.0", "package.json", "npm"]),
    );
    expect(summary(npm.findings)).toEqual(["React dependency-removed safe", "react dependency-added safe"]);
  });

  it("treats a version that went down in one project as a downgrade", () => {
    const base = index(["Polly", "8.4.0", "A.csproj"], ["Polly", "8.4.0", "B.csproj"]);
    const lowered = index(["Polly", "8.4.0", "A.csproj"], ["Polly", "7.0.0", "B.csproj"]);
    expect(summary(classify(base, lowered).findings)).toEqual(["Polly dependency-downgraded needs-action"]);
    const aligned = classify(
      index(["Polly", "7.2.0", "A.csproj"], ["Polly", "8.4.0", "B.csproj"]),
      index(["Polly", "8.4.0", "A.csproj"], ["Polly", "8.4.0", "B.csproj"]),
    );
    expect(summary(aligned.findings)).toEqual(["Polly dependency-upgraded needs-action"]);
    expect(aligned.findings[0]?.message).toBe("7.2.0, 8.4.0 → 8.4.0: major upgrade");
  });

  it("ignores the same version written differently", () => {
    expect(classify(index(["Polly", "8.4"]), index(["Polly", "8.4.0"])).findings).toEqual([]);
  });

  it("raises watched packages, never lowers them, and prints release notes", () => {
    const { findings } = classify(
      index(["SOFTURE.Auth", "1.0.0"], ["SOFTURE.Mail", "0.1.0"]),
      index(["SOFTURE.Auth", "1.0.1"], ["SOFTURE.Mail", "1.0.0"]),
      {
        watch: [
          {
            name: "softure.*",
            class: "needs-action",
            releaseNotes: "https://github.com/SOFTURE/Auth/releases",
          },
          { name: "SOFTURE.Mail", class: "safe" },
        ],
      },
    );
    expect(findings.map((f) => [f.subject, f.class, f.message])).toEqual([
      [
        "SOFTURE.Auth",
        "needs-action",
        "1.0.0 → 1.0.1: patch upgrade; watched package (softure.*); release notes: https://github.com/SOFTURE/Auth/releases",
      ],
      [
        "SOFTURE.Mail",
        "needs-action",
        "0.1.0 → 1.0.0: major upgrade; release notes: https://github.com/SOFTURE/Auth/releases",
      ],
    ]);
  });

  it("skips ignored packages and counts them", () => {
    const result = classify(
      index(["xunit", "2.9.0"], ["Microsoft.CodeAnalysis.CSharp", "4.0.0"], ["Npgsql", "3.1.0"]),
      index(["xunit", "3.0.0"], ["Microsoft.CodeAnalysis.CSharp", "5.0.0"], ["Npgsql", "3.1.0"]),
      { ignore: ["xunit*", "Microsoft.CodeAnalysis.*"] },
    );
    expect(result.findings).toEqual([]);
    expect(result.ignoredCount).toBe(2);
  });
});

describe("applyAccept", () => {
  it("accepts by id and name and reports usage", () => {
    const { findings } = classify(
      index(["Npgsql", "3.1.0"]),
      index(["Npgsql", "4.0.0"], ["Dapper", "2.1.0"]),
    );
    const result = applyAccept(findings, [
      { id: "dependency-upgraded", name: "npgsql", reason: "reviewed" },
      { id: "dependency-removed", name: "Dapper", reason: "stale" },
    ]);
    expect(result.findings.map((f) => [f.subject, f.accepted?.reason])).toEqual([
      ["Dapper", undefined],
      ["Npgsql", "reviewed"],
    ]);
    expect(result.usage.map((u) => u.count)).toEqual([1, 0]);
  });
});
