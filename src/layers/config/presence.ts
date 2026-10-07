import { z } from "zod";
import type { Finding } from "../../model/finding.js";
import { describeProcessError, runProcess } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";
import type { ConfigFindingId } from "./classify.js";
import type { KeyIdentity } from "./keys.js";

export const DEFAULT_PRESENCE_TIMEOUT_SECONDS = 60;

/** A command that prints the key names available in the target environment, one per line. */
export const presenceSchema = z.strictObject({
  run: z.string().min(1),
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
});

export type PresenceSettings = z.infer<typeof presenceSchema>;

/** Findings that say "the value must exist in production"; the presence command answers them. */
const RESOLVABLE_IDS: ReadonlySet<string> = new Set<ConfigFindingId>([
  "config-key-added-required",
  "config-key-default-removed",
]);

const PRESENT_MESSAGE = "present in the target environment (presence command)";

const MISSING_MESSAGE = "missing in the target environment (presence command)";

export function hasResolvableFindings(findings: Finding[]): boolean {
  return findings.some((finding) => RESOLVABLE_IDS.has(finding.id));
}

/**
 * Reads key names from the output of a presence command. A line `KEY=value` keeps only `KEY`, so
 * a value never leaves this function; blank lines and `#` comments are skipped, and an `export `
 * prefix is dropped.
 */
export function parsePresenceOutput(output: string, identify: KeyIdentity): Set<string> {
  const keys = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const name = line
      .split("=", 1)[0]
      ?.trim()
      .replace(/^export\s+/, "");
    if (name === undefined || name === "" || name.startsWith("#")) continue;
    keys.add(identify(name));
  }
  return keys;
}

type ReadPresentKeysOptions = {
  presence: PresenceSettings;
  cwd: string;
  env: NodeJS.ProcessEnv;
  identify: KeyIdentity;
};

/**
 * Runs the presence command in the consumer's working directory and returns the key identities it
 * lists. Errors never quote the command's output: it may carry values.
 */
export async function readPresentKeys({
  presence,
  cwd,
  env,
  identify,
}: ReadPresentKeysOptions): Promise<Result<Set<string>>> {
  const timeoutSeconds = presence.timeoutSeconds ?? DEFAULT_PRESENCE_TIMEOUT_SECONDS;
  const result = await runProcess({
    command: presence.run,
    shell: true,
    cwd,
    env,
    timeoutMs: timeoutSeconds * 1000,
  });
  const label = "presence command";
  if (!result.ok) return err(describeProcessError(label, result.error));
  if (result.value.exitCode !== 0) return err(`${label} exited ${result.value.exitCode}`);
  return ok(parsePresenceOutput(result.value.stdout, identify));
}

/**
 * Resolves findings that need a value in production: a key the target environment lists becomes
 * `safe`, one it does not list stays as it was and says it is missing.
 */
export function applyPresence(findings: Finding[], present: ReadonlySet<string>): Finding[] {
  return findings.map((finding) => {
    if (!RESOLVABLE_IDS.has(finding.id)) return finding;
    if (present.has(finding.subject)) {
      return { ...finding, class: "safe", message: `${finding.message}; ${PRESENT_MESSAGE}` };
    }
    return { ...finding, message: `${finding.message}; ${MISSING_MESSAGE}` };
  });
}
