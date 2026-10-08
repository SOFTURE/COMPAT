import { z } from "zod";
import { describeProcessError, getTailLines, runProcess } from "../process/run-process.js";
import { err, ok, type Result } from "../result.js";
import type { NothingFound, ResolvedRef } from "./resolve-ref.js";

export const DEFAULT_OTA_TIMEOUT_SECONDS = 120;

/** Prefix of the ref name of an over-the-air update: `ota:<label>`. */
export const OTA_REF_PREFIX = "ota:";

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

const DIRTY_MARKERS: ReadonlySet<string> = new Set(["dirty", "true"]);

/** A command that prints the live over-the-air updates, one `commit<TAB>label[<TAB>dirty]` line each. */
export const otaUpdatesSchema = z.strictObject({
  run: z.string().min(1),
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
});

export type OtaUpdatesSettings = z.infer<typeof otaUpdatesSchema>;

export type OtaUpdates = { refs: ResolvedRef[]; notes: string[] };

/**
 * Reads the output of an OTA command. Each distinct commit becomes one ref labelled `ota:<label>`
 * (its first line wins); a third column `dirty` (or `true`) adds a note, since the commit only
 * approximates a bundle published from a dirty working tree. Blank lines are skipped; an output with
 * no line is nothing found (no update published yet), a malformed line is an error.
 */
export function parseOtaOutput(output: string): Result<OtaUpdates | NothingFound> {
  const refs: ResolvedRef[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const [commit = "", label = "", dirty = ""] = line.split("\t").map((column) => column.trim());
    if (!COMMIT_PATTERN.test(commit) || label === "") {
      return err(`line ${index + 1} is not "commit<TAB>label": ${line.slice(0, 80)}`);
    }
    const key = commit.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = `${OTA_REF_PREFIX}${label}`;
    refs.push({ ref, commit });
    if (DIRTY_MARKERS.has(dirty.toLowerCase())) {
      notes.push(
        `${ref} was published from a dirty working tree; commit ${commit.slice(0, 12)} only approximates its bundle`,
      );
    }
  }
  if (refs.length === 0) return ok({ nothingFound: "the command exited 0 and printed no update" });
  return ok({ refs, notes });
}

type ReadOtaUpdatesOptions = { settings: OtaUpdatesSettings; cwd: string; env: NodeJS.ProcessEnv };

/**
 * Runs the OTA command in the consumer's repository and reads the updates it prints. A command that
 * cannot run, times out or exits non-zero is an error. When it prints no update, the last stderr line
 * (if any) is the reason, e.g. "channel production maps no branch".
 */
export async function readOtaUpdates({
  settings,
  cwd,
  env,
}: ReadOtaUpdatesOptions): Promise<Result<OtaUpdates | NothingFound>> {
  const timeoutSeconds = settings.timeoutSeconds ?? DEFAULT_OTA_TIMEOUT_SECONDS;
  const result = await runProcess({
    command: settings.run,
    shell: true,
    cwd,
    env,
    timeoutMs: timeoutSeconds * 1000,
  });
  const label = "easUpdates command";
  if (!result.ok) return err(describeProcessError(label, result.error));
  if (result.value.exitCode !== 0) {
    return err(`${label} exited ${result.value.exitCode}: ${getTailLines(result.value.stderr, 5)}`);
  }
  const updates = parseOtaOutput(result.value.stdout);
  const reason = getTailLines(result.value.stderr, 1).trim();
  if (updates.ok && "nothingFound" in updates.value && reason !== "") {
    return ok({ nothingFound: `${updates.value.nothingFound}: ${reason}` });
  }
  return updates;
}
