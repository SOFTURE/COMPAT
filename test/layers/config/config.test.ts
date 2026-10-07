import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/config/config.js";
import {
  configLayerConfigSchema,
  DEFAULT_COMPOSE_FILES,
  DEFAULT_DOTENV_FILES,
} from "../../../src/layers/config/config.js";
import { configLayer } from "../../../src/layers/config/config-layer.js";

const parse = (config: unknown) => configLayerConfigSchema.safeParse(config);
const issues = (config: unknown) => {
  const result = parse(config);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};
const regexSource = {
  kind: "regex",
  name: "ansible",
  files: ["roles/**/*.yml"],
  pattern: "(?<key>\\w+) is defined",
};

describe("config layer schema", () => {
  it("applies defaults to every source kind", () => {
    const result = parse({ sources: [{ kind: "compose" }, { kind: "dotenv" }, regexSource] });
    expect(result.success && result.data.sources).toEqual([
      { kind: "compose", name: "compose", files: DEFAULT_COMPOSE_FILES },
      { kind: "dotenv", name: "dotenv", files: DEFAULT_DOTENV_FILES, valuesAreDefaults: false },
      { ...regexSource, flags: "", comments: "none" },
    ]);
  });

  it("accepts explicit options and accept entries", () => {
    const result = parse({
      sources: [
        { kind: "dotenv", name: "env", files: ["deploy/.env.prod.example"], valuesAreDefaults: true },
        { ...regexSource, flags: "im", comments: "hash" },
      ],
      accept: [
        { key: "Shop__ApiKey", id: "config-key-added-required", reason: "already in the vault" },
        { key: "Logging__Level", id: "config-key-default-removed", reason: "set in production" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind, a nested typo and an empty source list", () => {
    expect(issues({ sources: [{ kind: "yaml" }] })).toEqual([expect.stringMatching(/^sources\.0\.kind: /)]);
    expect(issues({ sources: [{ kind: "compose", file: ["x.yml"] }] })).toEqual([
      expect.stringMatching(/^sources\.0: Unrecognized key: "file"/),
    ]);
    expect(issues({ sources: [] })).toEqual([expect.stringMatching(/^sources: /)]);
  });

  it("rejects an invalid pattern, a pattern without a key group and unsupported flags", () => {
    expect(issues({ sources: [{ ...regexSource, pattern: "(?<key>" }] })).toEqual([
      expect.stringMatching(/^sources\.0\.pattern: is not a valid regular expression/),
    ]);
    expect(issues({ sources: [{ ...regexSource, pattern: "(?<name>\\w+)" }] })).toEqual([
      "sources.0.pattern: must contain a named group (?<key>...)",
    ]);
    expect(issues({ sources: [{ ...regexSource, flags: "g" }] })).toEqual([
      "sources.0.flags: use only the flags i, m, s and u",
    ]);
    expect(issues({ sources: [{ ...regexSource, flags: "ii" }] })).toEqual([
      "sources.0.flags: must not repeat a flag",
    ]);
    expect(issues({ sources: [{ ...regexSource, pattern: "(?<key>\\-)", flags: "u" }] })).toEqual([
      expect.stringMatching(/^sources\.0\.pattern: is not a valid regular expression/),
    ]);
  });

  it("defaults to normalized key matching and accepts exact", () => {
    const parsed = parse({ sources: [{ kind: "compose" }] });
    expect(parsed.success && parsed.data.keyMatching).toBe("normalized");
    expect(issues({ sources: [{ kind: "compose" }], keyMatching: "exact" })).toEqual([]);
    expect(issues({ sources: [{ kind: "compose" }], keyMatching: "loose" })).toEqual([
      expect.stringMatching(/^keyMatching: /),
    ]);
  });

  it("accepts a prefix on every source kind and a key template with an enclosing pattern", () => {
    const result = parse({
      sources: [
        { kind: "compose", prefix: "App__" },
        { kind: "dotenv", prefix: "App__" },
        {
          ...regexSource,
          pattern: "public required \\w+ (?<member>\\w+) \\{",
          enclosing: "class (?<section>\\w+?)Settings\\b",
          key: "{section}__{member}",
          prefix: "Api__",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a key template that is empty or names an unknown group, and an unused enclosing pattern", () => {
    const pattern = "(?<member>\\w+)=";
    expect(issues({ sources: [{ ...regexSource, pattern, key: "Shop" }] })).toEqual([
      "sources.0.key: must use at least one named group as {name}",
    ]);
    expect(issues({ sources: [{ ...regexSource, pattern, key: "{section}__{member}" }] })).toEqual([
      "sources.0.key: uses {section}, which is not a named group of pattern or enclosing",
    ]);
    expect(
      issues({ sources: [{ ...regexSource, pattern, key: "{member}", enclosing: "(?<section>\\w+)" }] }),
    ).toEqual(["sources.0.enclosing: is not used: the key template takes none of its named groups"]);
    expect(issues({ sources: [{ ...regexSource, enclosing: "(?<section>\\w+)" }] })).toEqual([
      'sources.0.enclosing: needs a `key` template that uses its groups, e.g. "{section}__{key}"',
    ]);
    expect(issues({ sources: [{ ...regexSource, pattern, key: "{member}", enclosing: "(" }] })).toEqual([
      expect.stringMatching(/^sources\.0\.enclosing: is not a valid regular expression/),
    ]);
    expect(issues({ sources: [{ kind: "compose", prefix: "" }] })).toEqual([
      expect.stringMatching(/^sources\.0\.prefix: /),
    ]);
  });

  it("rejects duplicate source names, including two unnamed sources of one kind", () => {
    expect(issues({ sources: [{ kind: "compose" }, { kind: "compose", files: ["x.yml"] }] })).toEqual([
      "sources: source names must be unique; name sources of the same kind with `name`",
    ]);
    expect(issues({ sources: [regexSource, { ...regexSource }] })).toHaveLength(1);
  });

  it("rejects an accept entry with an unknown or missing id, or without a reason", () => {
    expect(issues({ sources: [{ kind: "compose" }], accept: [{ key: "A", reason: "x" }] })).toEqual([
      expect.stringMatching(/^accept\.0\.id: /),
    ]);
    expect(
      issues({ sources: [{ kind: "compose" }], accept: [{ key: "A", id: "endpoint-added", reason: "x" }] }),
    ).toEqual([expect.stringMatching(/^accept\.0\.id: /)]);
    expect(
      issues({ sources: [{ kind: "compose" }], accept: [{ key: "A", id: "config-key-removed" }] }),
    ).toEqual([expect.stringMatching(/^accept\.0\.reason: /)]);
  });

  it("accepts chains with defaults and chain accept entries", () => {
    const result = parse({
      sources: [{ kind: "compose" }, { ...regexSource, name: "deploy-prod" }, regexSource],
      chains: [{ name: "app-env", sources: ["compose", "deploy-prod"], required: ["ansible"] }],
      accept: [{ key: "DEV_ONLY", chain: "app-env", reason: "DEV only" }],
    });
    expect(result.success && result.data.chains).toEqual([
      { name: "app-env", sources: ["compose", "deploy-prod"], required: ["ansible"], scope: "changed" },
    ]);
    expect(result.success && result.data.accept).toEqual([
      { key: "DEV_ONLY", chain: "app-env", reason: "DEV only" },
    ]);
  });

  it("rejects a chain with an unknown source, fewer than two sources, a repeated source or a repeated name", () => {
    const sources = [{ kind: "compose" }, regexSource];
    expect(issues({ sources, chains: [{ name: "c", sources: ["compose", "nope"] }] })).toEqual([
      'chains.0: names source "nope", which is not in `sources`',
    ]);
    expect(issues({ sources, chains: [{ name: "c", sources: ["compose"] }] })).toEqual([
      "chains.0: needs at least two sources",
    ]);
    expect(
      issues({ sources, chains: [{ name: "c", sources: ["compose", "ansible"], required: ["compose"] }] }),
    ).toEqual(["chains.0: lists a source more than once across `sources` and `required`"]);
    const chain = { name: "c", sources: ["compose", "ansible"] };
    expect(issues({ sources, chains: [chain, chain] })).toEqual(["chains.1.name: must be unique"]);
  });

  it("rejects a chain accept entry for an unknown chain or without a reason", () => {
    const sources = [{ kind: "compose" }, regexSource];
    const chains = [{ name: "c", sources: ["compose", "ansible"] }];
    expect(issues({ sources, chains, accept: [{ key: "A", chain: "nope", reason: "x" }] })).toEqual([
      'accept.0.chain: names chain "nope", which is not in `chains`',
    ]);
    expect(issues({ sources, chains, accept: [{ key: "A", chain: "c" }] })).toEqual([
      expect.stringMatching(/^accept\.0\.reason: /),
    ]);
  });

  it("plugs into compat.config.json and names the full path of an error", () => {
    const valid = parseConfig(
      { layers: { config: { sources: [{ kind: "compose" }] } } },
      [configLayer],
      "c.json",
    );
    expect(valid.ok).toBe(true);
    const invalid = parseConfig(
      { layers: { config: { sources: [{ ...regexSource, pattern: "(" }] } } },
      [configLayer],
      "c.json",
    );
    expect(invalid.ok ? "" : invalid.error).toMatch(
      /^invalid config c\.json: layers\.config\.sources\.0\.pattern: /,
    );
  });
});
