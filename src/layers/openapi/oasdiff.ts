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

export type Oasdiff = { path: string; version: string };

export type LocateResult = { status: "found"; oasdiff: Oasdiff } | { status: "not-found"; tried: string };

export async function locateOasdiff(options: {
  configuredPath?: string;
  env: NodeJS.ProcessEnv;
}): Promise<Result<LocateResult>> {
  const candidate = options.configuredPath ?? options.env[OASDIFF_ENV_VAR] ?? "oasdiff";
  const probe = await runProcess({
    command: candidate,
    args: ["--version"],
    env: options.env,
    timeoutMs: 30_000,
  });
  if (!probe.ok) {
    if (
      probe.error.kind === "spawn-failed" &&
      (probe.error.code === "ENOENT" || probe.error.code === "EACCES")
    ) {
      return ok({ status: "not-found", tried: candidate });
    }
    return err(`oasdiff (${candidate}) did not answer --version`);
  }
  if (probe.value.exitCode !== 0) {
    return err(`oasdiff (${candidate}) --version exited ${probe.value.exitCode}`);
  }
  return ok({ status: "found", oasdiff: { path: candidate, version: probe.value.stdout.trim() } });
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
