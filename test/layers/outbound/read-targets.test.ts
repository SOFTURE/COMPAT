import { describe, expect, it } from "vitest";
import { compileTargetPattern } from "../../../src/layers/outbound/config.js";
import { normalizeTarget, readTargets } from "../../../src/layers/outbound/read-targets.js";

const compile = (pattern: string) => {
  const regex = compileTargetPattern(pattern, "");
  if (!(regex instanceof RegExp)) throw new Error(regex.error);
  return regex;
};

describe("normalizeTarget", () => {
  it("drops the scheme, query, fragment and trailing slash and lower-cases only the host", () => {
    expect(normalizeTarget("https://Maps.GoogleApis.com/maps/API/geocode/json?key=x#top")).toBe(
      "maps.googleapis.com/maps/API/geocode/json",
    );
    expect(normalizeTarget("http://api.example.com/")).toBe("api.example.com");
    expect(normalizeTarget("api.example.com//v1///items/")).toBe("api.example.com/v1/items");
  });

  it("returns an empty string for an empty target", () => {
    expect(normalizeTarget(" / ")).toBe("");
  });
});

describe("readTargets", () => {
  const text = [
    'client.BaseAddress = new Uri("https://maps.googleapis.com/maps/api/");',
    'await client.GetAsync($"geocode/json?address={address}&key={key}");',
    'await client.GetAsync("https://other.example.com/v2/items?x=1");',
    'await client.GetAsync("");',
  ].join("\n");

  it("joins the default host with relative paths and keeps absolute paths whole", () => {
    expect(
      readTargets(text, compile('GetAsync\\(\\$?"(?<path>[^"]*)"'), "maps.googleapis.com/maps/api"),
    ).toEqual([
      { target: "maps.googleapis.com/maps/api/geocode/json", line: 2 },
      { target: "other.example.com/v2/items", line: 3 },
    ]);
  });

  it("reads hosts captured on their own", () => {
    expect(readTargets(text, compile('new Uri\\("(?<host>[^"]+)"'))).toEqual([
      { target: "maps.googleapis.com/maps/api", line: 1 },
    ]);
  });

  it("prefers a captured host over the default one", () => {
    const regex = compile('"(?<host>https://[\\w.-]+)(?<path>/[^"?]*)');
    expect(readTargets('get("https://a.example.com/x?y")', regex, "b.example.com")).toEqual([
      { target: "a.example.com/x", line: 1 },
    ]);
  });
});

describe("compileTargetPattern", () => {
  it("requires a host or path group", () => {
    expect(compileTargetPattern('"(?<url>[^"]+)"', "")).toEqual({
      error: "must contain a named group (?<host>...) or (?<path>...)",
    });
  });

  it("reports an invalid regular expression", () => {
    expect(compileTargetPattern("(?<path>", "")).toEqual({
      error: expect.stringContaining("is not a valid regular expression"),
    });
  });
});
