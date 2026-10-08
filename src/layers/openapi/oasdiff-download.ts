import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { err, ok, type Result } from "../../result.js";

export const CACHE_DIR_ENV_VAR = "SOFTURE_COMPAT_CACHE_DIR";
export const NO_DOWNLOAD_ENV_VAR = "SOFTURE_COMPAT_NO_DOWNLOAD";

/** True when SOFTURE_COMPAT_NO_DOWNLOAD is set to anything but empty, `0` or `false`. */
export function isDownloadTurnedOff(env: NodeJS.ProcessEnv): boolean {
  const value = env[NO_DOWNLOAD_ENV_VAR]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export type OasdiffRelease = {
  version: string;
  /** Release asset URL with `{asset}` in place of the file name. */
  urlTemplate: string;
  /** SHA-256 of every supported archive, keyed by the asset suffix (`linux_amd64`). */
  sha256: Readonly<Record<string, string>>;
  /** SHA-256 of the binary inside every archive, so a cached binary can be verified offline. */
  binarySha256: Readonly<Record<string, string>>;
};

/**
 * The oasdiff release the CLI downloads. The archive checksums are copied from the release's
 * `checksums.txt` and the binary checksums are taken from those verified archives; both ship in
 * the package, so a tampered mirror, release or cache entry cannot pass.
 */
export const PINNED_OASDIFF: OasdiffRelease = {
  version: "1.33.0",
  urlTemplate: "https://github.com/oasdiff/oasdiff/releases/download/v1.33.0/{asset}",
  sha256: {
    darwin_all: "2a479337c15afdcbf0b1e89c0b4d0cf0176472dbc11483358fed1f831d1e46c5",
    linux_amd64: "43a4e328e2d13ba1552d760aa68d2485c75c5621f309f6ff64ae895188345247",
    linux_arm64: "4ae3c362d6074d919aada2dea82d0ee84366591600384455d0bdc658ddf8f7ae",
    windows_amd64: "22f98c7247075f8a446e783595802d6d38637de1760df264f3d4b3309f766c5b",
    windows_arm64: "d51bd1ea4b05ff9b314245d1e97f84c222b22ce34a930e8e305c68c32edbe951",
  },
  binarySha256: {
    darwin_all: "14259eae1a315b73ea730e9f5ad4dc30eef4c1caaf0fe6511da913c74ec3106d",
    linux_amd64: "fa65aae43c867e9f79da9cb121d3c1a113637883afe014c0680fd5b50696f416",
    linux_arm64: "05baaaad3cf4576f95b72ebd0f40052ef3a6873c6c347fb5e5905071255e4aff",
    windows_amd64: "f450465c0f4bd35ec49ba35b436820730843c5b21b5499e618963803bd8da919",
    windows_arm64: "e6295057b3627a250fa3e05e5e60fdf26dac7e2108b3b05700d66b5f849b73ad",
  },
};

const DOWNLOAD_TIMEOUT_MS = 300_000;
/** The largest archive is about 15 MB; anything far bigger is not an oasdiff release. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export type ProvidedOasdiff = { path: string; source: "cache" | "download" };

export type ProvideResult =
  | { status: "provided"; oasdiff: ProvidedOasdiff }
  | { status: "unsupported"; platform: string }
  | { status: "not-cached" };

/** Asset suffix of the release archive for a platform, or undefined when oasdiff ships none. */
export function getAssetSuffix(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) return "darwin_all";
  const os = platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  return os && cpu ? `${os}_${cpu}` : undefined;
}

/** Root of the CLI's cache: SOFTURE_COMPAT_CACHE_DIR, else the platform's user cache directory. */
export function getCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const configured = env[CACHE_DIR_ENV_VAR];
  if (configured) return configured;
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "softure-compat");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "softure-compat");
}

/**
 * Returns a cached oasdiff of the pinned release, downloading it first when the cache has no
 * binary that matches the embedded SHA-256. The archive is checked before anything is written
 * to the cache, and the binary appears there only through an atomic rename. With downloads off
 * only the verified cache is used, and `not-cached` reports that it had nothing usable.
 */
export async function provideOasdiff(options: {
  env: NodeJS.ProcessEnv;
  isDownloadAllowed?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  release?: OasdiffRelease;
  fetch?: FetchLike;
  log?: (message: string) => void;
}): Promise<Result<ProvideResult>> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const release = options.release ?? PINNED_OASDIFF;
  const suffix = getAssetSuffix(platform, arch);
  const expectedSha = suffix === undefined ? undefined : release.sha256[suffix];
  const expectedBinarySha = suffix === undefined ? undefined : release.binarySha256[suffix];
  if (suffix === undefined || expectedSha === undefined || expectedBinarySha === undefined) {
    return ok({ status: "unsupported", platform: `${platform}/${arch}` });
  }
  const binaryName = platform === "win32" ? "oasdiff.exe" : "oasdiff";
  const targetDir = join(getCacheDir(options.env, platform), "oasdiff", release.version, suffix);
  const target = join(targetDir, binaryName);
  if ((await getFileSha256(target)) === expectedBinarySha) {
    return ok({ status: "provided", oasdiff: { path: target, source: "cache" } });
  }
  if (options.isDownloadAllowed === false) return ok({ status: "not-cached" });

  const asset = `oasdiff_${release.version}_${suffix}.tar.gz`;
  const url = release.urlTemplate.replace("{asset}", asset);
  options.log?.(`downloading oasdiff ${release.version} from ${url}`);
  const archive = await downloadBytes(url, options.fetch ?? fetch);
  if (!archive.ok) return archive;
  const actualSha = createHash("sha256").update(archive.value).digest("hex");
  if (actualSha !== expectedSha) {
    return err(
      `oasdiff archive ${asset} failed the checksum check (expected sha256 ${expectedSha}, got ${actualSha})`,
    );
  }
  const binary = extractTarGzFile(archive.value, binaryName);
  if (!binary.ok) return err(`oasdiff archive ${asset}: ${binary.error}`);
  const binarySha = createHash("sha256").update(binary.value).digest("hex");
  if (binarySha !== expectedBinarySha) {
    return err(
      `oasdiff binary in ${asset} failed the checksum check (expected sha256 ${expectedBinarySha}, got ${binarySha})`,
    );
  }

  const written = await writeAtomically(targetDir, target, binary.value);
  if (!written.ok) return written;
  return ok({ status: "provided", oasdiff: { path: target, source: "download" } });
}

async function downloadBytes(url: string, fetchFn: FetchLike): Promise<Result<Buffer>> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    return err(`oasdiff download from ${url} failed (${describeError(error)})`);
  }
  if (!response.ok) return err(`oasdiff download from ${url} returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ARCHIVE_BYTES) return err(`oasdiff download from ${url} is larger than expected`);
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ARCHIVE_BYTES) return err(`oasdiff download from ${url} is larger than expected`);
    return ok(bytes);
  } catch (error) {
    return err(`oasdiff download from ${url} was interrupted (${describeError(error)})`);
  }
}

/** Reads one regular file from a gzipped tar archive, by its name in the archive root. */
export function extractTarGzFile(archive: Buffer, fileName: string): Result<Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    return err("is not a gzip file");
  }
  const BLOCK = 512;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "");
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    if (Number.isNaN(size)) return err("has a corrupt tar header");
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) return err("is truncated");
    if (fullName === fileName && (type === "0" || type === "\0")) {
      return ok(Buffer.from(tar.subarray(dataStart, dataStart + size)));
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return err(`has no ${fileName}`);
}

function readTarString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

async function writeAtomically(dir: string, target: string, content: Buffer): Promise<Result<void>> {
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, content, { mode: 0o755 });
    await chmod(temp, 0o755);
    await rename(temp, target);
    return ok(undefined);
  } catch (error) {
    await rm(temp, { force: true });
    return err(`cannot write oasdiff to the cache at ${dir} (${describeError(error)})`);
  }
}

/** SHA-256 of a file, or undefined when it cannot be read (a missing cache entry is expected). */
async function getFileSha256(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const code = (error as NodeJS.ErrnoException).code ?? (cause as NodeJS.ErrnoException | undefined)?.code;
    return code ? `${error.message}: ${code}` : error.message;
  }
  return String(error);
}
