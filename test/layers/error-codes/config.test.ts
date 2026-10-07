import { describe, expect, it } from "vitest";
import { compileCodePattern, errorCodesConfigSchema } from "../../../src/layers/error-codes/config.js";

const client = { name: "mobile", refs: ["v1"], files: ["app/api.ts"], pattern: '"(?<code>[\\w.]+)":' };
const source = { name: "api", files: ["src/**/*.cs"], pattern: 'Error\\("(?<code>[\\w.]+)"' };

const getIssues = (config: unknown) => {
  const parsed = errorCodesConfigSchema.safeParse(config);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("error-codes config", () => {
  it("accepts codes, clients with a ref selector and accept entries", () => {
    const parsed = errorCodesConfigSchema.parse({
      codes: [source],
      clients: [{ ...client, refs: { tags: "mobile-*", since: "2.0.1" }, flags: "i" }],
      accept: [{ code: "Shop.Cart.NotFound", client: "mobile", reason: "web only" }],
    });
    expect(parsed.codes[0]).toMatchObject({ flags: "" });
    expect(parsed.clients[0]?.flags).toBe("i");
  });

  it("rejects a pattern without the code group, an invalid regex and bad flags", () => {
    expect(getIssues({ codes: [{ ...source, pattern: '"([\\w.]+)"' }], clients: [client] })).toEqual([
      "codes.0.pattern: must contain a named group (?<code>...)",
    ]);
    expect(getIssues({ codes: [source], clients: [{ ...client, pattern: "(?<code>[" }] })[0]).toMatch(
      /^clients\.0\.pattern: is not a valid regular expression/,
    );
    expect(getIssues({ codes: [{ ...source, flags: "gg" }], clients: [client] })).toEqual([
      "codes.0.flags: use only the flags i, m, s and u",
      "codes.0.flags: must not repeat a flag",
    ]);
  });

  it("rejects duplicate names, unknown keys and an empty client list", () => {
    expect(getIssues({ codes: [source, source], clients: [client] })).toEqual([
      "codes: code source names must be unique",
    ]);
    expect(getIssues({ codes: [source], clients: [client, client] })).toEqual([
      "clients: client names must be unique",
    ]);
    expect(getIssues({ codes: [source], clients: [{ ...client, map: "x" }] })).toEqual([
      'clients.0: Unrecognized key: "map"',
    ]);
    expect(getIssues({ codes: [source], clients: [] })).toEqual([
      "clients: Too small: expected array to have >=1 items",
    ]);
  });

  it("defaults a code source to kind regex with report true", () => {
    const parsed = errorCodesConfigSchema.parse({ codes: [source], clients: [client] });
    expect(parsed.codes[0]).toMatchObject({ kind: "regex", report: true });
  });

  it("accepts a composed source and rejects parts that do not match a regex source or the template", () => {
    const entities = { ...source, name: "entities", report: false };
    const composed = {
      kind: "composed",
      name: "not-found",
      template: "{entity}.NotFound",
      parts: { entity: "entities" },
    };
    expect(getIssues({ codes: [entities, composed], clients: [client] })).toEqual([]);
    expect(
      getIssues({ codes: [entities, { ...composed, parts: { entity: "missing" } }], clients: [client] }),
    ).toEqual(['codes.1.parts.entity: names "missing", which is not a code source']);
    expect(
      getIssues({
        codes: [entities, composed, { ...composed, name: "nested", parts: { entity: "not-found" } }],
        clients: [client],
      }),
    ).toEqual(['codes.2.parts.entity: names "not-found", a composed source; parts read regex sources only']);
    expect(
      getIssues({
        codes: [entities, { ...composed, template: "{kind}.NotFound", parts: { entity: "entities" } }],
        clients: [client],
      }),
    ).toEqual([
      "codes.1.parts: placeholder {kind} has no part",
      "codes.1.parts.entity: is not used in the template",
    ]);
  });

  it("compiles a pattern with the g and d flags", () => {
    const regex = compileCodePattern("(?<code>x)", "i");
    expect(regex instanceof RegExp && regex.flags).toBe("dgi");
  });
});
