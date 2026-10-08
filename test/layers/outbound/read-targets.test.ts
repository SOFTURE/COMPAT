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
    expect(normalizeTarget("https://Maps.GoogleApis.com/maps/API/geocode/json?key=x#top")).toEqual({
      ok: true,
      value: "maps.googleapis.com/maps/API/geocode/json",
    });
    expect(normalizeTarget("http://api.example.com/")).toEqual({ ok: true, value: "api.example.com" });
    expect(normalizeTarget("api.example.com//v1///items/")).toEqual({
      ok: true,
      value: "api.example.com/v1/items",
    });
  });

  it("resolves . and .. segments", () => {
    expect(normalizeTarget("maps.googleapis.com/maps/api/place/../geocode/./json")).toEqual({
      ok: true,
      value: "maps.googleapis.com/maps/api/geocode/json",
    });
    expect(normalizeTarget("https://api.example.com/v1/..")).toEqual({ ok: true, value: "api.example.com" });
  });

  it("fails a target whose .. segments climb above its host", () => {
    expect(normalizeTarget("api.example.com/v1/../../other")).toEqual({
      ok: false,
      error: 'target "api.example.com/v1/../../other" climbs above its host api.example.com',
    });
    expect(normalizeTarget("../geocode/json")).toEqual({
      ok: false,
      error: 'target "../geocode/json" has no host',
    });
  });

  it("returns an empty string for an empty target", () => {
    expect(normalizeTarget(" / ")).toEqual({ ok: true, value: "" });
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
    ).toEqual({
      ok: true,
      value: [
        { target: "maps.googleapis.com/maps/api/geocode/json", line: 2 },
        { target: "other.example.com/v2/items", line: 3 },
      ],
    });
  });

  it("resolves a relative path against the host as a base with a trailing slash", () => {
    const geocode =
      'private readonly Uri _geocodeUrl = new(new Uri(settings.Value.BaseUrl), "../geocode/json");';
    const regex = compile('new Uri\\(settings\\.Value\\.BaseUrl\\), "(?<path>[^"]+)"');
    expect(readTargets(geocode, regex, "maps.googleapis.com/maps/api/place")).toEqual({
      ok: true,
      value: [{ target: "maps.googleapis.com/maps/api/geocode/json", line: 1 }],
    });
  });

  it("fails when a relative path climbs above the host", () => {
    const regex = compile('GetAsync\\("(?<path>[^"]*)"');
    expect(readTargets('\nGetAsync("../../x")', regex, "api.example.com/v1")).toEqual({
      ok: false,
      error: 'line 2: target "api.example.com/v1/../../x" climbs above its host api.example.com',
    });
  });

  it("reads hosts captured on their own", () => {
    expect(readTargets(text, compile('new Uri\\("(?<host>[^"]+)"'))).toEqual({
      ok: true,
      value: [{ target: "maps.googleapis.com/maps/api", line: 1 }],
    });
  });

  it("prefers a captured host over the default one", () => {
    const regex = compile('"(?<host>https://[\\w.-]+)(?<path>/[^"?]*)');
    expect(readTargets('get("https://a.example.com/x?y")', regex, "b.example.com")).toEqual({
      ok: true,
      value: [{ target: "a.example.com/x", line: 1 }],
    });
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
