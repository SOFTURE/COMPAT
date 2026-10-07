import { describe, expect, it } from "vitest";
import type { RefTree } from "../../../src/git/ref-tree.js";
import { applyChainAccept, checkChains, type SourceIndexes } from "../../../src/layers/config/chains.js";
import { addDeclarations, type KeyIndex } from "../../../src/layers/config/classify.js";
import { type ConfigChain, configChainSchema } from "../../../src/layers/config/config.js";
import { normalizeKey } from "../../../src/layers/config/keys.js";
import type { Finding } from "../../../src/model/finding.js";

const revisionTree: RefTree = {
  side: "revision",
  ref: "v2",
  commit: "b".repeat(40),
  listFiles: async () => ({ ok: true, value: [] }),
  readFile: async () => ({ ok: true, value: null }),
  materialize: async () => ({ ok: false, error: "not used" }),
};

/** Builds one source's index from `KEY` or `KEY=default` entries, one line each. */
function index(source: string, ...keys: string[]): KeyIndex {
  const result: KeyIndex = new Map();
  for (const [line, entry] of keys.entries()) {
    const [key = "", value] = entry.split("=");
    addDeclarations(
      result,
      [{ key, line: line + 1, default: value ?? null }],
      { source, path: `${source}.yml` },
      normalizeKey,
    );
  }
  return result;
}

function sources(entries: Record<string, [string[], string[]]>): Map<string, SourceIndexes> {
  return new Map(
    Object.entries(entries).map(([name, [base, revision]]) => [
      name,
      { base: index(name, ...base), revision: index(name, ...revision) },
    ]),
  );
}

const chain = (settings: Partial<ConfigChain> & { sources: string[] }): ConfigChain =>
  configChainSchema.parse({ name: "app-env", ...settings });

const summary = (findings: Finding[]) =>
  findings.map((f) => `${f.subject} ${f.class} ${f.scope}: ${f.message}`);

describe("checkChains", () => {
  it("reports a new key missing from one source, naming the sources that have it and the one that does not", () => {
    const { findings, notes } = checkChains({
      chains: [chain({ sources: ["compose", "deploy-dev", "deploy-prod"] })],
      sources: sources({
        compose: [["A"], ["A", "NEW"]],
        "deploy-dev": [["A"], ["A", "NEW"]],
        "deploy-prod": [["A"], ["A"]],
      }),
      revisionTree,
    });
    expect(summary(findings)).toEqual([
      "NEW needs-action chain app-env: the key is in compose, deploy-dev but missing from deploy-prod; every source of the chain must have it",
    ]);
    expect(findings[0]?.id).toBe("config-chain-missing");
    expect(findings[0]?.evidence.map((e) => `${e.side} ${e.path}:${e.line}`)).toEqual([
      "revision compose.yml:2",
      "revision deploy-dev.yml:2",
    ]);
    expect(notes).toEqual([]);
  });

  it("reports nothing when every source has the key", () => {
    const { findings } = checkChains({
      chains: [chain({ sources: ["compose", "deploy-prod"] })],
      sources: sources({ compose: [[], ["NEW"]], "deploy-prod": [[], ["NEW"]] }),
      revisionTree,
    });
    expect(findings).toEqual([]);
  });

  it("matches spellings by key identity", () => {
    const { findings } = checkChains({
      chains: [chain({ sources: ["compose", "template"] })],
      sources: sources({ compose: [[], ["SHOP_API_KEY"]], template: [[], ["Shop__ApiKey"]] }),
      revisionTree,
    });
    expect(findings).toEqual([]);
  });

  it("is breaking when a required source lacks the key", () => {
    const { findings } = checkChains({
      chains: [chain({ sources: ["compose", "template"], required: ["assert"] })],
      sources: sources({
        compose: [[], ["NEW", "OTHER"]],
        template: [[], ["NEW"]],
        assert: [[], ["OTHER"]],
      }),
      revisionTree,
    });
    expect(findings.map((f) => `${f.subject} ${f.class}`)).toEqual(["NEW breaking", "OTHER needs-action"]);
  });

  it("uses the class configured on the chain", () => {
    const { findings } = checkChains({
      chains: [chain({ sources: ["compose"], required: ["assert"], class: "safe" })],
      sources: sources({ compose: [[], ["NEW"]], assert: [[], []] }),
      revisionTree,
    });
    expect(findings.map((f) => `${f.subject} ${f.class}`)).toEqual(["NEW safe"]);
  });

  it("reports only changed keys by default and every key in scope all", () => {
    const state = sources({
      "deploy-dev": [
        ["OLD_DEV_ONLY", "REMOVED", "DEFAULTED=1"],
        ["OLD_DEV_ONLY", "DEFAULTED=2"],
      ],
      "deploy-prod": [["REMOVED", "DEFAULTED=1"], ["REMOVED"]],
    });
    const changed = checkChains({
      chains: [chain({ sources: ["deploy-dev", "deploy-prod"] })],
      sources: state,
      revisionTree,
    });
    expect(changed.findings.map((f) => f.subject)).toEqual(["DEFAULTED", "REMOVED"]);
    const all = checkChains({
      chains: [chain({ sources: ["deploy-dev", "deploy-prod"], scope: "all" })],
      sources: state,
      revisionTree,
    });
    expect(all.findings.map((f) => f.subject)).toEqual(["DEFAULTED", "OLD_DEV_ONLY", "REMOVED"]);
  });

  it("skips a chain whose source could not be scanned", () => {
    const { findings, notes } = checkChains({
      chains: [chain({ sources: ["compose", "deploy-prod"] })],
      sources: sources({ compose: [[], ["NEW"]] }),
      revisionTree,
    });
    expect(findings).toEqual([]);
    expect(notes).toEqual(['chain "app-env" skipped: source(s) deploy-prod could not be scanned']);
  });
});

describe("applyChainAccept", () => {
  it("accepts by key identity and chain name and counts the use of each entry", () => {
    const { findings } = checkChains({
      chains: [
        chain({ name: "parity", sources: ["deploy-dev", "deploy-prod"] }),
        chain({ name: "other", sources: ["deploy-dev", "compose"] }),
      ],
      sources: sources({ "deploy-dev": [[], ["DEV_ONLY"]], "deploy-prod": [[], []], compose: [[], []] }),
      revisionTree,
    });
    const accepted = applyChainAccept(
      findings,
      [
        { key: "DevOnly", chain: "parity", reason: "DEV only" },
        { key: "GONE", chain: "parity", reason: "stale" },
      ],
      normalizeKey,
    );
    expect(accepted.findings.map((f) => `${f.scope} ${f.accepted?.reason ?? "-"}`)).toEqual([
      "chain parity DEV only",
      "chain other -",
    ]);
    expect(accepted.usage.map((u) => u.count)).toEqual([1, 0]);
  });
});
