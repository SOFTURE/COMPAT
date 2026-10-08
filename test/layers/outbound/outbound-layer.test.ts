import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { outboundLayer } from "../../../src/layers/outbound/outbound-layer.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

const PLACES = [
  "public class GooglePlacesClient {",
  '  public Task<string> Find(string q) => _http.GetStringAsync($"place/findplacefromtext/json?input={q}");',
  "}",
].join("\n");

const GEOCODE = [
  "public class GoogleGeoLocationResolver {",
  "  public async Task<Location> Resolve(string address) {",
  '    var json = await _http.GetStringAsync($"geocode/json?address={address}&key={_key}");',
  "  }",
  "}",
].join("\n");

const LEGACY = 'var response = await http.PostAsync("https://legacy.example.com/v1/sync", body);';

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    { files: { "src/Places.cs": PLACES, "src/Legacy.cs": LEGACY }, tag: "2.2.4" },
    {
      files: { "src/Places.cs": null, "src/Geo.cs": GEOCODE, "src/Legacy.cs": LEGACY.replace("v1", "v2") },
      tag: "2.3.7",
    },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-outbound-layer-"));
  const opened = await Promise.all([
    openRefTree({ repoDir: repo.dir, ref: "2.2.4", side: "base", tempRoot }),
    openRefTree({ repoDir: repo.dir, ref: "2.3.7", side: "revision", tempRoot }),
  ]);
  if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
  base = opened[0].value;
  revision = opened[1].value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

const targets = [
  {
    name: "google-maps",
    files: ["src/**/*.cs"],
    pattern: 'GetStringAsync\\(\\$?"(?<path>[^"]*)"',
    host: "https://maps.googleapis.com/maps/api/",
  },
  { name: "absolute", files: ["src/**/*.cs"], pattern: '"(?<host>https://[\\w.-]+)(?<path>/[^"?{]*)' },
];

const run = (config: unknown) =>
  outboundLayer.run({
    config: outboundLayer.configSchema.parse(config),
    base,
    revision,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: process.env,
    log: () => {},
  });

describe("outbound layer", () => {
  it("reports targets new in the revision as needs-action and dropped ones as safe", async () => {
    const result = await run({ targets });
    if (result.status !== "ran") throw new Error(`layer did not run: ${JSON.stringify(result)}`);
    expect(
      result.findings.map((finding) => [finding.id, finding.class, finding.scope, finding.subject]),
    ).toEqual([
      ["outbound-added", "needs-action", "absolute", "legacy.example.com/v2/sync"],
      ["outbound-added", "needs-action", "google-maps", "maps.googleapis.com/maps/api/geocode/json"],
      ["outbound-removed", "safe", "absolute", "legacy.example.com/v1/sync"],
      [
        "outbound-removed",
        "safe",
        "google-maps",
        "maps.googleapis.com/maps/api/place/findplacefromtext/json",
      ],
    ]);
    expect(result.findings[1]?.message).toBe(
      "outbound call to maps.googleapis.com/maps/api/geocode/json is new in the revision; check that production allows it (API enabled for the credential, key restrictions, quotas, egress rules)",
    );
    expect(result.findings[1]?.evidence).toEqual([
      { side: "revision", ref: "2.3.7", commit: revision.commit, path: "src/Geo.cs", line: 3 },
    ]);
    expect(result.notes).toEqual([
      'target source "google-maps": 1 target(s) at base, 1 at revision',
      'target source "absolute": 1 target(s) at base, 1 at revision',
    ]);
  });

  it("accepts added targets by glob and notes unused entries", async () => {
    const result = await run({
      targets,
      accept: [
        {
          target: "maps.googleapis.com/maps/api/geocode/**",
          reason: "Geocoding API enabled on the prod key",
        },
        { target: "*.stripe.com/**", reason: "old" },
      ],
    });
    if (result.status !== "ran") throw new Error("layer did not run");
    expect(result.findings.map((finding) => finding.accepted?.reason)).toEqual([
      undefined,
      "Geocoding API enabled on the prod key",
      undefined,
      undefined,
    ]);
    expect(result.notes.slice(2)).toEqual([
      "accept entry maps.googleapis.com/maps/api/geocode/** accepted 1 finding(s)",
      "accept entry *.stripe.com/** matched nothing; remove it once the release that needed it is live",
    ]);
  });

  it("fails without findings when a source matches no file or captures nothing at the revision", async () => {
    const result = await run({
      targets: [
        ...targets,
        { name: "missing", files: ["lib/**/*.cs"], pattern: '"(?<path>/api/[^"]*)"' },
        { name: "empty", files: ["src/**/*.cs"], pattern: 'Unused\\("(?<path>[^"]*)"' },
      ],
    });
    expect(result).toEqual({
      layer: "outbound",
      status: "failed",
      error:
        'target source "missing": no file matches lib/**/*.cs at revision 2.3.7; target source "empty": pattern captured no target in 2 file(s) at revision 2.3.7',
      findings: [],
      notes: [
        'target source "google-maps": 1 target(s) at base, 1 at revision',
        'target source "absolute": 1 target(s) at base, 1 at revision',
      ],
    });
  });

  it("fails the source whose relative path climbs above its host", async () => {
    const result = await run({
      targets: [{ ...targets[0], name: "climbing", host: "maps.googleapis.com/.." }],
    });
    expect(result).toEqual({
      layer: "outbound",
      status: "failed",
      error:
        'target source "climbing": src/Places.cs at 2.2.4: line 2: target "maps.googleapis.com/../place/findplacefromtext/json?input={q}" climbs above its host maps.googleapis.com',
      findings: [],
      notes: [],
    });
  });

  it("rejects a config whose pattern has no host or path group and duplicate source names", () => {
    const parsed = outboundLayer.configSchema.safeParse({
      targets: [
        { name: "a", files: ["src/**"], pattern: '"(?<url>[^"]+)"' },
        { name: "a", files: ["src/**"], pattern: '"(?<path>[^"]+)"' },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["targets.0.pattern", "must contain a named group (?<host>...) or (?<path>...)"],
      ["targets", "target source names must be unique"],
    ]);
  });
});
