import { describe, expect, it } from "vitest";
import type { RefTree } from "../../../src/git/ref-tree.js";
import {
  addDeclarations,
  applyAccept,
  classifyKeys,
  getFileId,
  type KeyDeclaration,
  type KeyIndex,
} from "../../../src/layers/config/classify.js";
import type { Finding } from "../../../src/model/finding.js";

const tree = (side: "base" | "revision"): RefTree => ({
  side,
  ref: side === "base" ? "v1" : "v2",
  commit: side === "base" ? "a".repeat(40) : "b".repeat(40),
  listFiles: async () => ({ ok: true, value: [] }),
  readFile: async () => ({ ok: true, value: null }),
  materialize: async () => ({ ok: false, error: "not used" }),
});
const baseTree = tree("base");
const revisionTree = tree("revision");

type Entry = { source?: string; path?: string } & KeyDeclaration;

function index(...entries: Entry[]): KeyIndex {
  const result: KeyIndex = new Map();
  for (const { source = "compose", path = "docker-compose.yml", ...declaration } of entries) {
    addDeclarations(result, [declaration], { source, path });
  }
  return result;
}

const classify = (base: KeyIndex, revision: KeyIndex, pairedFiles: ReadonlySet<string> = new Set()) =>
  classifyKeys({ base, revision, baseTree, revisionTree, pairedFiles });
const summary = (findings: Finding[]) => findings.map((f) => `${f.subject} ${f.id} ${f.class}`);

describe("classifyKeys", () => {
  it("reports a new key without a default as needs-action with revision evidence", () => {
    const findings = classify(index(), index({ key: "Shop__ApiKey", line: 7, default: null }));
    expect(findings).toEqual([
      {
        layer: "config",
        scope: "compose",
        id: "config-key-added-required",
        subject: "Shop__ApiKey",
        class: "needs-action",
        message: "new key without a default; the value must exist in production before the deploy",
        evidence: [
          { side: "revision", ref: "v2", commit: "b".repeat(40), path: "docker-compose.yml", line: 7 },
        ],
      },
    ]);
  });

  it("reports a new key that has a default everywhere as safe", () => {
    const findings = classify(index(), index({ key: "Timeout", line: 3, default: "30" }));
    expect(summary(findings)).toEqual(["Timeout config-key-added-optional safe"]);
  });

  it("reports only the most severe verdict when sources disagree on a new key", () => {
    const findings = classify(
      index(),
      index(
        { key: "Url", line: 3, default: "http://x" },
        { key: "Url", line: 9, default: null, source: "ansible", path: "roles/app/tasks/main.yml" },
      ),
    );
    expect(summary(findings)).toEqual(["Url config-key-added-required needs-action"]);
    expect(findings[0]?.scope).toBe("ansible");
    expect(findings[0]?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual(["roles/app/tasks/main.yml:9"]);
  });

  it("joins sources that reach the same verdict into one finding", () => {
    const findings = classify(
      index(),
      index(
        { key: "Url", line: 3, default: null },
        { key: "Url", line: 9, default: null, source: "ansible", path: "roles/app/tasks/main.yml" },
      ),
    );
    expect(summary(findings)).toEqual(["Url config-key-added-required needs-action"]);
    expect(findings[0]?.scope).toBe("ansible, compose");
    expect(findings[0]?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual([
      "docker-compose.yml:3",
      "roles/app/tasks/main.yml:9",
    ]);
  });

  it("reports a removed default even when another source requires the key at both refs", () => {
    const documented = {
      key: "Logging__Level",
      line: 2,
      default: null,
      source: "dotenv",
      path: ".env.example",
    };
    const findings = classify(
      index({ key: "Logging__Level", line: 4, default: "Information" }, documented),
      index({ key: "Logging__Level", line: 5, default: null }, documented),
    );
    expect(summary(findings)).toEqual(["Logging__Level config-key-default-removed needs-action"]);
    expect(findings[0]?.scope).toBe("compose");
  });

  it("reports a removed default as needs-action with evidence from both refs", () => {
    const findings = classify(
      index({ key: "Logging__Level", line: 4, default: "Information" }),
      index({ key: "Logging__Level", line: 5, default: null }),
    );
    expect(summary(findings)).toEqual(["Logging__Level config-key-default-removed needs-action"]);
    expect(findings[0]?.evidence.map((e) => `${e.side}:${e.line}`)).toEqual(["base:4", "revision:5"]);
  });

  it("reports a changed default as safe", () => {
    const findings = classify(
      index({ key: "Timeout", line: 1, default: "30" }),
      index({ key: "Timeout", line: 1, default: "60" }),
    );
    expect(summary(findings)).toEqual(["Timeout config-key-default-changed safe"]);
  });

  it("reports a removed key as safe with base evidence", () => {
    const findings = classify(index({ key: "Old", line: 2, default: null }), index());
    expect(summary(findings)).toEqual(["Old config-key-removed safe"]);
    expect(findings[0]?.evidence[0]?.side).toBe("base");
  });

  it("reports nothing for unchanged keys, an added default or moved lines", () => {
    const findings = classify(
      index(
        { key: "Required", line: 1, default: null },
        { key: "Optional", line: 2, default: "x" },
        { key: "GainsDefault", line: 3, default: null },
      ),
      index(
        { key: "Required", line: 10, default: null },
        { key: "Optional", line: 20, default: "x" },
        { key: "GainsDefault", line: 30, default: "y" },
      ),
    );
    expect(findings).toEqual([]);
  });

  it("compares files present at both refs one by one, so a test file cannot hide a new production secret", () => {
    const testFile = { key: "DB_PASSWORD", line: 3, default: null, path: "tests/docker-compose.yml" };
    const paired = new Set([
      getFileId("compose", "tests/docker-compose.yml"),
      getFileId("compose", "deploy/prod.yml"),
    ]);
    const findings = classify(
      index(testFile),
      index(testFile, { key: "DB_PASSWORD", line: 9, default: null, path: "deploy/prod.yml" }),
      paired,
    );
    expect(summary(findings)).toEqual(["DB_PASSWORD config-key-added-required needs-action"]);
    expect(findings[0]?.evidence.map((e) => `${e.path}:${e.line}`)).toEqual(["deploy/prod.yml:9"]);
  });

  it("reports a default removed in one file while another file requires the key", () => {
    const dev = { key: "LOG", line: 1, default: null, path: "docker-compose.dev.yml" };
    const paired = new Set([
      getFileId("compose", "docker-compose.yml"),
      getFileId("compose", "docker-compose.dev.yml"),
    ]);
    const findings = classify(
      index({ key: "LOG", line: 2, default: "info" }, dev),
      index({ key: "LOG", line: 2, default: null }, dev),
      paired,
    );
    expect(summary(findings)).toEqual(["LOG config-key-default-removed needs-action"]);
  });

  it("compares files present at one ref only at source level, so a renamed file adds nothing", () => {
    const findings = classify(
      index({ key: "A", line: 1, default: null, path: "old.yml" }),
      index({ key: "A", line: 1, default: null, path: "new.yml" }),
    );
    expect(findings).toEqual([]);
  });

  it("reports nothing for two empty indexes", () => {
    expect(classify(index(), index())).toEqual([]);
  });

  it("caps evidence at five locations per side and drops duplicates", () => {
    const declarations = [1, 1, 2, 3, 4, 5, 6, 7].map((line) => ({ key: "K", line, default: null }));
    const findings = classify(index(), index(...declarations));
    expect(findings[0]?.evidence.map((e) => e.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("sorts findings by key", () => {
    const findings = classify(
      index(),
      index({ key: "b", line: 1, default: null }, { key: "a", line: 1, default: null }),
    );
    expect(findings.map((f) => f.subject)).toEqual(["a", "b"]);
  });

  it("never puts a default value into a message", () => {
    const secret = "s3cr3t-default";
    const findings = classify(
      index({ key: "Changed", line: 1, default: secret }, { key: "Dropped", line: 2, default: secret }),
      index(
        { key: "Changed", line: 1, default: `${secret}-2` },
        { key: "Dropped", line: 2, default: null },
        { key: "Added", line: 3, default: secret },
      ),
    );
    expect(findings).toHaveLength(3);
    for (const finding of findings) expect(JSON.stringify(finding)).not.toContain(secret);
  });
});

describe("applyAccept", () => {
  const findings = classify(
    index({ key: "Level", line: 1, default: "Info" }),
    index(
      { key: "Level", line: 1, default: null },
      { key: "Shop__ApiKey", line: 2, default: null },
      { key: "Shop__BaseUrl", line: 3, default: null },
    ),
  );

  it("accepts a finding with the same key and id", () => {
    const { findings: result, usage } = applyAccept(findings, [
      { key: "Shop__ApiKey", id: "config-key-added-required", reason: "set in vault" },
    ]);
    expect(result.find((f) => f.subject === "Shop__ApiKey")?.accepted).toEqual({ reason: "set in vault" });
    expect(result.filter((f) => f.accepted)).toHaveLength(1);
    expect(usage[0]?.count).toBe(1);
  });

  it("accepts by key and id, and keeps a finding whose id differs", () => {
    const { findings: result, usage } = applyAccept(findings, [
      { key: "Level", id: "config-key-default-removed", reason: "set in production" },
      { key: "Shop__BaseUrl", id: "config-key-added-optional", reason: "wrong id" },
    ]);
    expect(result.find((f) => f.subject === "Level")?.accepted).toEqual({ reason: "set in production" });
    expect(result.find((f) => f.subject === "Shop__BaseUrl")?.accepted).toBeUndefined();
    expect(usage.map((u) => u.count)).toEqual([1, 0]);
  });

  it("reports an entry that matched nothing", () => {
    const entry = { key: "Gone", id: "config-key-removed", reason: "old" } as const;
    expect(applyAccept(findings, [entry]).usage).toEqual([{ entry, count: 0 }]);
  });
});
