import type { RefTree } from "../../git/ref-tree.js";
import { describeProcessError, getTailLines, runProcess } from "../../process/run-process.js";
import { err, ok, type Result } from "../../result.js";

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;

export type RunTreeCommandOptions = {
  /** Shell command line. */
  run: string;
  tree: RefTree;
  /** The materialized tree of `tree`; the working directory of the command. */
  root: string;
  timeoutSeconds?: number;
  env: NodeJS.ProcessEnv;
  /** Names the command in errors, for example `export command`. */
  label: string;
};

/**
 * Runs a consumer command through the shell inside a materialized ref, with `COMPAT_SIDE`,
 * `COMPAT_REF` and `COMPAT_COMMIT` set. A failure names the command, side and ref, and carries
 * the tail of stderr.
 */
export async function runTreeCommand(options: RunTreeCommandOptions): Promise<Result<void>> {
  const { tree } = options;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
  const result = await runProcess({
    command: options.run,
    shell: true,
    cwd: options.root,
    env: { ...options.env, COMPAT_SIDE: tree.side, COMPAT_REF: tree.ref, COMPAT_COMMIT: tree.commit },
    timeoutMs: timeoutSeconds * 1000,
  });
  const label = `${options.label} at ${tree.side} (${tree.ref})`;
  if (!result.ok) return err(describeProcessError(label, result.error));
  if (result.value.exitCode !== 0) {
    const tail = getTailLines(result.value.stderr, 20);
    return err(`${label} exited ${result.value.exitCode}${tail ? `: ${tail}` : ""}`);
  }
  return ok(undefined);
}
