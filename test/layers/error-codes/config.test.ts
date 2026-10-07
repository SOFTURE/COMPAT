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
    expect(parsed.codes[0]?.flags).toBe("");
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

  it("compiles a pattern with the g and d flags", () => {
    const regex = compileCodePattern("(?<code>x)", "i");
    expect(regex instanceof RegExp && regex.flags).toBe("dgi");
  });
});
