import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../../src/config/config.js";
import { createStubLayer } from "../helpers/stub-layer.js";

const layers = [createStubLayer("stub"), createStubLayer("other")];
const dir = mkdtempSync(join(tmpdir(), "compat-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("loadConfig", () => {
  it("reports a missing file", async () => {
    const path = join(dir, "missing.json");
    expect(await loadConfig(path, layers)).toEqual({ ok: false, error: `config file not found: ${path}` });
  });

  it("reports invalid JSON with the file name", async () => {
    const path = writeConfig("broken.json", "{ layers: ");
    const result = await loadConfig(path, layers);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(new RegExp(`^config ${path} is not valid JSON: `));
  });

  it("returns enabled layers in registry order with their config", async () => {
    const path = writeConfig(
      "valid.json",
      JSON.stringify({ layers: { other: { level: "safe" }, stub: {} } }),
    );
    const result = await loadConfig(path, layers);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.layers.map(({ layer, config }) => [layer.name, config])).toEqual([
      ["stub", {}],
      ["other", { level: "safe" }],
    ]);
  });
});

describe("parseConfig", () => {
  it("skips a layer with enabled false and strips the flag", () => {
    const result = parseConfig(
      { layers: { stub: { enabled: false }, other: { enabled: true } } },
      layers,
      "c.json",
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.layers.map(({ layer, config }) => [layer.name, config])).toEqual([["other", {}]]);
  });

  it("rejects an unknown top-level key", () => {
    expect(parseConfig({ layers: {}, extra: 1 }, layers, "c.json")).toEqual({
      ok: false,
      error: 'invalid config c.json: (root): Unrecognized key: "extra"',
    });
  });

  it("rejects an unknown layer", () => {
    expect(parseConfig({ layers: { graphql: {} } }, layers, "c.json")).toEqual({
      ok: false,
      error: 'invalid config c.json: layers: Unrecognized key: "graphql"',
    });
  });

  it("rejects a typo nested inside a layer", () => {
    expect(parseConfig({ layers: { stub: { nested: { value: 1, valeu: 2 } } } }, layers, "c.json")).toEqual({
      ok: false,
      error: 'invalid config c.json: layers.stub.nested: Unrecognized key: "valeu"',
    });
  });

  it("rejects a wrong type with its path", () => {
    expect(parseConfig({ layers: { stub: { level: 3 } } }, layers, "c.json")).toEqual({
      ok: false,
      error: "invalid config c.json: layers.stub.level: Invalid input: expected string, received number",
    });
  });

  it("requires the layers object", () => {
    const result = parseConfig({}, layers, "c.json");
    expect(result.ok).toBe(false);
  });
});
