import { spawn } from "node:child_process";
import { err, ok, type Result } from "../result.js";

export type RunProcessOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Runs `command` through the system shell; `args` must then be empty. */
  shell?: boolean;
};

export type ProcessOutput = { exitCode: number; stdout: string; stderr: string };

export type ProcessError =
  | { kind: "spawn-failed"; code: string; message: string }
  | { kind: "timed-out"; timeoutMs: number; stdout: string; stderr: string };

/**
 * How long output may keep arriving after the process exited. A background process that
 * inherited the pipes (a build server, `cmd &`) would otherwise keep the call open forever.
 */
const DRAIN_GRACE_MS = 1_000;

const isWindows = process.platform === "win32";

/** Process groups started by `runProcess` that have not finished yet. */
const liveGroups = new Set<number>();

/** Kills every process group still running; used when the CLI is interrupted. */
export function killAllProcessGroups(): void {
  for (const pid of liveGroups) killGroup(pid);
  liveGroups.clear();
}

function killGroup(pid: number): void {
  try {
    process.kill(isWindows ? pid : -pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export function runProcess(options: RunProcessOptions): Promise<Result<ProcessOutput, ProcessError>> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout also stops grandchildren (a shell's `sleep`, a build server).
      detached: !isWindows,
    });
    const pid = child.pid;
    if (pid !== undefined) liveGroups.add(pid);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let isTimedOut = false;
    let isSettled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    const settle = (result: Result<ProcessOutput, ProcessError>): void => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      if (pid !== undefined) {
        // Stop whatever the process left behind in its group, then forget it.
        if (!isWindows) killGroup(pid);
        liveGroups.delete(pid);
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    const finish = (code: number | null): void => {
      const out = Buffer.concat(stdout).toString("utf8");
      const errOut = Buffer.concat(stderr).toString("utf8");
      if (isTimedOut) {
        settle(err({ kind: "timed-out", timeoutMs: options.timeoutMs ?? 0, stdout: out, stderr: errOut }));
        return;
      }
      settle(ok({ exitCode: code ?? 1, stdout: out, stderr: errOut }));
    };

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            isTimedOut = true;
            if (pid === undefined) child.kill("SIGKILL");
            else killGroup(pid);
          }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(err({ kind: "spawn-failed", code: error.code ?? "UNKNOWN", message: error.message }));
    });
    child.on("exit", (code) => {
      drainTimer = setTimeout(() => finish(code), DRAIN_GRACE_MS);
    });
    child.on("close", (code) => finish(code));
  });
}

export function describeProcessError(command: string, error: ProcessError): string {
  if (error.kind === "spawn-failed") return `${command} could not start (${error.code})`;
  return `${command} timed out after ${Math.round(error.timeoutMs / 1000)} s`;
}

export function getTailLines(text: string, count: number): string {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}
