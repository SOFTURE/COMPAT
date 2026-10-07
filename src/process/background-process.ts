import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { err, ok, type Result } from "../result.js";
import {
  killGroup,
  signalGroup,
  trackProcessGroup,
  untrackProcessGroup,
  waitForGroupExit,
} from "./process-groups.js";

export type BackgroundProcessOptions = {
  /** Shell command line. */
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** How long `stop()` waits after SIGTERM before it sends SIGKILL to the whole group. */
  stopGraceMs?: number;
};

export type BackgroundExit = { code: number | null; signal: NodeJS.Signals | null };

export type BackgroundProcess = {
  pid: number;
  /** The end of stdout and stderr, interleaved as they arrived. */
  getOutput(): string;
  /** `null` while the process runs. */
  getExit(): BackgroundExit | null;
  /** Stops the process and everything in its group and resolves once they are gone; safe to call more than once. */
  stop(): Promise<void>;
};

const DEFAULT_STOP_GRACE_MS = 3_000;
/** How long `stop()` waits for the killed group to disappear; a member stuck in the kernel must not hang the CLI. */
const GROUP_EXIT_TIMEOUT_MS = 2_000;
/** Output kept per process; a chatty app must not grow the CLI's memory without bound. */
const MAX_OUTPUT_CHARS = 64_000;

const isWindows = process.platform === "win32";

/**
 * Starts a long-running shell command (an app server) in its own process group and returns at
 * once. The caller must `stop()` it; `withBackgroundProcess` does that for you.
 */
export function startBackgroundProcess(
  options: BackgroundProcessOptions,
): Promise<Result<BackgroundProcess>> {
  return new Promise((resolve) => {
    const child = spawn(options.command, [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so stop() also reaches what the shell started (`dotnet run` spawns the app host).
      detached: !isWindows,
    });
    let output = "";
    let exit: BackgroundExit | null = null;
    let stopping: Promise<void> | undefined;
    const exited = new Promise<void>((resolveExit) => {
      child.on("exit", (code, signal) => {
        exit = { code, signal };
        resolveExit();
      });
    });
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return; // Started; a later error does not change that.
      resolve(err(`${options.command} could not start (${error.code ?? "UNKNOWN"})`));
    });
    child.once("spawn", () => {
      const pid = child.pid as number; // Defined once `spawn` fired.
      trackProcessGroup(pid);
      const stop = async (): Promise<void> => {
        const graceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
        if (exit === null) {
          signalGroup(pid, "SIGTERM");
          let graceTimer: NodeJS.Timeout | undefined;
          await Promise.race([exited, new Promise((done) => (graceTimer = setTimeout(done, graceMs)))]);
          clearTimeout(graceTimer);
        }
        // Also when the leader is gone: a grandchild may still hold the port.
        killGroup(pid);
        if (exit === null) await exited;
        await waitForGroupExit(pid, GROUP_EXIT_TIMEOUT_MS);
        untrackProcessGroup(pid);
        child.stdout.destroy();
        child.stderr.destroy();
      };
      resolve(
        ok({
          pid,
          getOutput: () => output,
          getExit: () => exit,
          stop: () => {
            stopping ??= stop();
            return stopping;
          },
        }),
      );
    });
  });
}

/** Runs `use` with a started background process and always stops the process afterwards. */
export async function withBackgroundProcess<T>(
  options: BackgroundProcessOptions,
  use: (started: BackgroundProcess) => Promise<Result<T>>,
): Promise<Result<T>> {
  const started = await startBackgroundProcess(options);
  if (!started.ok) return started;
  try {
    return await use(started.value);
  } finally {
    await started.value.stop();
  }
}

/** Ports handed out in this CLI run; base and revision start in parallel and must not get the same one. */
const handedOutPorts = new Set<number>();

/** A TCP port on 127.0.0.1 that is free now and was not returned before in this run. */
export async function findFreePort(): Promise<Result<number>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await askForPort();
    if (!port.ok) return port;
    if (handedOutPorts.has(port.value)) continue;
    handedOutPorts.add(port.value);
    return port;
  }
  return err("cannot find a free TCP port on 127.0.0.1");
}

function askForPort(): Promise<Result<number>> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(err(`cannot find a free TCP port on 127.0.0.1 (${error.code ?? "UNKNOWN"})`)),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(ok(port)));
    });
  });
}
