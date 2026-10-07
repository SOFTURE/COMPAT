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

export function runProcess(options: RunProcessOptions): Promise<Result<ProcessOutput, ProcessError>> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let isTimedOut = false;
    let isSettled = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            isTimedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);
      resolve(err({ kind: "spawn-failed", code: error.code ?? "UNKNOWN", message: error.message }));
    });
    child.on("close", (code) => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const errOut = Buffer.concat(stderr).toString("utf8");
      if (isTimedOut) {
        resolve(err({ kind: "timed-out", timeoutMs: options.timeoutMs ?? 0, stdout: out, stderr: errOut }));
        return;
      }
      resolve(ok({ exitCode: code ?? 1, stdout: out, stderr: errOut }));
    });
  });
}

export function describeProcessError(command: string, error: ProcessError): string {
  if (error.kind === "spawn-failed") return `${command} could not start (${error.code})`;
  return `${command} timed out after ${Math.round(error.timeoutMs / 1000)} s`;
}

export function getTailLines(text: string, count: number): string {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}
