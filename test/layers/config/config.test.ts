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
