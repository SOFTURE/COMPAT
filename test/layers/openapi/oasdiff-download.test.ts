import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractTarGzFile,
  type FetchLike,
  getAssetSuffix,
  getCacheDir,
  isDownloadTurnedOff,
  type OasdiffRelease,
  PINNED_OASDIFF,
  provideOasdiff,
} from "../../../src/layers/openapi/oasdiff-download.js";
import { createTarGz } from "../../helpers/tar.js";

const BINARY = "#!/bin/sh\necho 'oasdiff version 9.9.9'\n";
const ARCHIVE = createTarGz({ LICENSE: "license text", oasdiff: BINARY });
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const BINARY_SHA = createHash("sha256").update(BINARY).digest("hex");

const release: OasdiffRelease = {
  version: "9.9.9",
  urlTemplate: "https://example.test/download/{asset}",
  sha256: { linux_amd64: ARCHIVE_SHA },
  binarySha256: { linux_amd64: BINARY_SHA },
};

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "compat-oasdiff-cache-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function serve(body: Buffer, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return new Response(new Uint8Array(body), { status });
    },
  };
}

const offline: FetchLike = async () => {
  throw new Error("network access in a cached run");
};

function provide(
  fetch: FetchLike,
  overrides: { platform?: NodeJS.Platform; arch?: string; isDownloadAllowed?: boolean } = {},
) {
  return provideOasdiff({
    env: { SOFTURE_COMPAT_CACHE_DIR: cacheDir },
    isDownloadAllowed: overrides.isDownloadAllowed,
    platform: overrides.platform ?? "linux",
    arch: overrides.arch ?? "x64",
    release,
    fetch,
  });
}

const cachedBinary = () => join(cacheDir, "oasdiff", "9.9.9", "linux_amd64", "oasdiff");

describe("getAssetSuffix", () => {
  it.each([
    ["darwin", "arm64", "darwin_all"],
    ["darwin", "x64", "darwin_all"],
    ["linux", "x64", "linux_amd64"],
    ["linux", "arm64", "linux_arm64"],
    ["win32", "x64", "windows_amd64"],
    ["win32", "arm64", "windows_arm64"],
    ["linux", "ia32", undefined],
    ["freebsd", "x64", undefined],
  ] as const)("maps %s/%s to %s", (platform, arch, expected) => {
    expect(getAssetSuffix(platform, arch)).toBe(expected);
  });

  it("has a pinned checksum for every asset the issue lists", () => {
    expect(Object.keys(PINNED_OASDIFF.sha256).sort()).toEqual([
      "darwin_all",
      "linux_amd64",
      "linux_arm64",
      "windows_amd64",
      "windows_arm64",
    ]);
    for (const sha of Object.values(PINNED_OASDIFF.sha256)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has a pinned binary checksum for every archive", () => {
    expect(Object.keys(PINNED_OASDIFF.binarySha256).sort()).toEqual(
      Object.keys(PINNED_OASDIFF.sha256).sort(),
    );
    for (const sha of Object.values(PINNED_OASDIFF.binarySha256)) expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("getCacheDir", () => {
  it("prefers SOFTURE_COMPAT_CACHE_DIR", () => {
    expect(getCacheDir({ SOFTURE_COMPAT_CACHE_DIR: "/c", XDG_CACHE_HOME: "/x" }, "linux")).toBe("/c");
  });

  it("uses XDG_CACHE_HOME, then ~/.cache", () => {
    expect(getCacheDir({ XDG_CACHE_HOME: "/x", HOME: "/h" }, "linux")).toBe(join("/x", "softure-compat"));
    expect(getCacheDir({ HOME: "/h" }, "darwin")).toBe(join("/h", ".cache", "softure-compat"));
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(getCacheDir({ LOCALAPPDATA: "/l", HOME: "/h" }, "win32")).toBe(join("/l", "softure-compat"));
  });
});

describe("isDownloadTurnedOff", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["1", true],
    ["true", true],
  ])("reads %j as %s", (value, expected) => {
    expect(isDownloadTurnedOff({ SOFTURE_COMPAT_NO_DOWNLOAD: value })).toBe(expected);
  });
});

describe("extractTarGzFile", () => {
  it("returns the named file from the archive root", () => {
    const extracted = extractTarGzFile(ARCHIVE, "oasdiff");
    expect(extracted).toEqual({ ok: true, value: Buffer.from(BINARY) });
  });

  it("finds a file stored with a ./ prefix", () => {
    const extracted = extractTarGzFile(createTarGz({ "./oasdiff.exe": "exe" }), "oasdiff.exe");
    expect(extracted).toEqual({ ok: true, value: Buffer.from("exe") });
  });

  it("reports a missing file", () => {
    expect(extractTarGzFile(ARCHIVE, "oasdiff.exe")).toEqual({ ok: false, error: "has no oasdiff.exe" });
  });

  it("reports data that is not gzip", () => {
    expect(extractTarGzFile(Buffer.from("plain"), "oasdiff")).toEqual({
      ok: false,
      error: "is not a gzip file",
    });
  });

  it("reports a truncated archive", () => {
    const tar = gunzipSync(createTarGz({ oasdiff: "x".repeat(2000) }));
    const truncated = gzipSync(tar.subarray(0, 1024));
    expect(extractTarGzFile(truncated, "oasdiff")).toEqual({ ok: false, error: "is truncated" });
  });
});

describe("provideOasdiff", () => {
  it("downloads the archive for the platform, verifies it and caches the binary", async () => {
    const server = serve(ARCHIVE);
    const result = await provide(server.fetch);
    expect(result).toEqual({
      ok: true,
      value: { status: "provided", oasdiff: { path: cachedBinary(), source: "download" } },
    });
    expect(server.urls).toEqual(["https://example.test/download/oasdiff_9.9.9_linux_amd64.tar.gz"]);
    expect(readFileSync(cachedBinary(), "utf8")).toBe(BINARY);
  });

  it("uses the cache on the second run without network access", async () => {
    await provide(serve(ARCHIVE).fetch);
    const result = await provide(offline);
    expect(result).toEqual({
      ok: true,
      value: { status: "provided", oasdiff: { path: cachedBinary(), source: "cache" } },
    });
  });

  it("uses the verified cache without network access when downloads are off", async () => {
    await provide(serve(ARCHIVE).fetch);
    expect(await provide(offline, { isDownloadAllowed: false })).toEqual({
      ok: true,
      value: { status: "provided", oasdiff: { path: cachedBinary(), source: "cache" } },
    });
  });

  it("reports not-cached when downloads are off and the cache is empty", async () => {
    expect(await provide(offline, { isDownloadAllowed: false })).toEqual({
      ok: true,
      value: { status: "not-cached" },
    });
  });

  it("ignores a cached binary whose checksum does not match when downloads are off", async () => {
    await mkdir(dirname(cachedBinary()), { recursive: true });
    await writeFile(cachedBinary(), "#!/bin/sh\necho evil\n");
    expect(await provide(offline, { isDownloadAllowed: false })).toEqual({
      ok: true,
      value: { status: "not-cached" },
    });
  });

  it("replaces a cached binary whose checksum does not match by downloading", async () => {
    await mkdir(dirname(cachedBinary()), { recursive: true });
    await writeFile(cachedBinary(), "#!/bin/sh\necho evil\n");
    expect(await provide(serve(ARCHIVE).fetch)).toEqual({
      ok: true,
      value: { status: "provided", oasdiff: { path: cachedBinary(), source: "download" } },
    });
    expect(readFileSync(cachedBinary(), "utf8")).toBe(BINARY);
  });

  it("rejects a verified archive whose binary does not match its checksum", async () => {
    const result = await provideOasdiff({
      env: { SOFTURE_COMPAT_CACHE_DIR: cacheDir },
      platform: "linux",
      arch: "x64",
      release: { ...release, binarySha256: { linux_amd64: "0".repeat(64) } },
      fetch: serve(ARCHIVE).fetch,
    });
    expect(result).toEqual({
      ok: false,
      error: `oasdiff binary in oasdiff_9.9.9_linux_amd64.tar.gz failed the checksum check (expected sha256 ${"0".repeat(64)}, got ${BINARY_SHA})`,
    });
    expect(existsSync(cachedBinary())).toBe(false);
  });

  it("rejects a tampered archive and caches nothing", async () => {
    const tampered = createTarGz({ LICENSE: "license text", oasdiff: "#!/bin/sh\necho evil\n" });
    const tamperedSha = createHash("sha256").update(tampered).digest("hex");
    const result = await provide(serve(tampered).fetch);
    expect(result).toEqual({
      ok: false,
      error: `oasdiff archive oasdiff_9.9.9_linux_amd64.tar.gz failed the checksum check (expected sha256 ${ARCHIVE_SHA}, got ${tamperedSha})`,
    });
    expect(existsSync(join(cacheDir, "oasdiff"))).toBe(false);
  });

  it("names the platform when no release asset exists for it", async () => {
    expect(await provide(offline, { platform: "freebsd" })).toEqual({
      ok: true,
      value: { status: "unsupported", platform: "freebsd/x64" },
    });
    expect(await provide(offline, { platform: "darwin" })).toEqual({
      ok: true,
      value: { status: "unsupported", platform: "darwin/x64" },
    });
  });

  it("fails on an HTTP error", async () => {
    expect(await provide(serve(Buffer.from("not found"), 404).fetch)).toEqual({
      ok: false,
      error:
        "oasdiff download from https://example.test/download/oasdiff_9.9.9_linux_amd64.tar.gz returned HTTP 404",
    });
  });

  it("fails when the network is unreachable", async () => {
    expect(await provide(offline)).toEqual({
      ok: false,
      error:
        "oasdiff download from https://example.test/download/oasdiff_9.9.9_linux_amd64.tar.gz failed (network access in a cached run)",
    });
  });

  it("fails when a verified archive has no binary", async () => {
    const empty = createTarGz({ LICENSE: "license text" });
    const result = await provideOasdiff({
      env: { SOFTURE_COMPAT_CACHE_DIR: cacheDir },
      platform: "linux",
      arch: "x64",
      release: { ...release, sha256: { linux_amd64: createHash("sha256").update(empty).digest("hex") } },
      fetch: serve(empty).fetch,
    });
    expect(result).toEqual({
      ok: false,
      error: "oasdiff archive oasdiff_9.9.9_linux_amd64.tar.gz: has no oasdiff",
    });
    expect(existsSync(join(cacheDir, "oasdiff")) ? readdirSync(join(cacheDir, "oasdiff")) : []).toEqual([]);
  });
});
