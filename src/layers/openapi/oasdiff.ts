import { resolve } from "node:path";
import { z } from "zod";
import { getTailLines, runProcess } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";

export const OASDIFF_ENV_VAR = "SOFTURE_COMPAT_OASDIFF";
export const OASDIFF_INSTALL_HINT = "install it with `go install github.com/oasdiff/oasdiff@v1.33.0`";

const sourceSchema = z.looseObject({ file: z.string(), line: z.number().int().optional() });

export const oasdiffChangeSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  level: z.number().int().min(1).max(3),
  operation: z.string().optional(),
  operationId: z.string().optional(),
  path: z.string().optional(),
  section: z.string().optional(),
  baseSource: sourceSchema.optional(),
  revisionSource: sourceSchema.optional(),
});

export type OasdiffChange = z.infer<typeof oasdiffChangeSchema>;

export type OasdiffSource = "config" | "env" | "path" | "cache" | "download";

export type Oasdiff = { path: string; version: string; source: OasdiffSource };

export type LocateResult = { status: "found"; oasdiff: Oasdiff } | { status: "not-found" };

/**
 * Finds oasdiff. Only a plain `oasdiff` missing from PATH counts as not found (the caller may
 * then download it or skip the layer); a path the consumer configured that cannot run is an
 * error, so a typo never passes as an incomplete check. A relative configured path is resolved
 * against the repository root.
 */
export async function locateOasdiff(options: {
  configuredPath?: string;
  env: NodeJS.ProcessEnv;
  repoDir: string;
}): Promise<Result<LocateResult>> {
  const fromEnv = options.env[OASDIFF_ENV_VAR];
  const configured = options.configuredPath ?? fromEnv;
  const source: OasdiffSource =
    options.configuredPath !== undefined ? "config" : fromEnv !== undefined ? "env" : "path";
  const candidate =
    configured === undefined
      ? "oasdiff"
      : configured.includes("/") || configured.includes("\\")
        ? resolve(options.repoDir, configured)
        : configured;
  const probe = await probeOasdiff({ path: candidate, source, env: options.env });
  if (!probe.ok) {
    if (source === "path" && probe.error.isMissing) return ok({ status: "not-found" });
    return err(probe.error.message);
  }
  return ok({ status: "found", oasdiff: probe.value });
}

/** Runs `oasdiff --version` to prove the binary works and to read its version. */
export async function probeOasdiff(options: {
  path: string;
  source: OasdiffSource;
  env: NodeJS.ProcessEnv;
}): Promise<Result<Oasdiff, { message: string; isMissing: boolean }>> {
  const probe = await runProcess({
    command: options.path,
    args: ["--version"],
    env: options.env,
    timeoutMs: 30_000,
  });
  if (!probe.ok) {
    const isMissing = probe.error.kind === "spawn-failed" && probe.error.code === "ENOENT";
    const cause = probe.error.kind === "spawn-failed" ? probe.error.code : "timed out";
    return err({ message: `oasdiff at ${options.path} cannot run --version (${cause})`, isMissing });
  }
  if (probe.value.exitCode !== 0) {
    return err({
      message: `oasdiff at ${options.path} --version exited ${probe.value.exitCode}`,
      isMissing: false,
    });
  }
  // `oasdiff --version` prints `oasdiff version 1.33.0`; keep the version only.
  const version = probe.value.stdout.trim().replace(/^oasdiff version\s+/, "");
  return ok({ path: options.path, version, source: options.source });
}

export async function runOasdiffChangelog(options: {
  oasdiff: Oasdiff;
  baseFile: string;
  revisionFile: string;
  args?: string[];
  env: NodeJS.ProcessEnv;
}): Promise<Result<OasdiffChange[]>> {
  // User args first, so the fixed output format always wins.
  const args = [
    "changelog",
    ...(options.args ?? []),
    "--format",
    "json",
    "--",
    options.baseFile,
    options.revisionFile,
  ];
  const result = await runProcess({
    command: options.oasdiff.path,
    args,
    env: options.env,
    timeoutMs: 600_000,
  });
  if (!result.ok) return err(`oasdiff changelog could not run (${result.error.kind})`);
  if (result.value.exitCode !== 0) {
    const tail = getTailLines(result.value.stderr, 10);
    return err(`oasdiff changelog exited ${result.value.exitCode}${tail ? `: ${tail}` : ""}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.value.stdout.trim() === "" ? "[]" : result.value.stdout);
  } catch {
    return err("oasdiff changelog printed output that is not JSON");
  }
  const parsed = z.array(oasdiffChangeSchema).safeParse(raw);
  if (!parsed.success) {
    return err(
      `oasdiff changelog output has an unexpected shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return ok(parsed.data);
}
