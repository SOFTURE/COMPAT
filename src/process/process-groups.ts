const isWindows = process.platform === "win32";

/** Process groups started by this CLI that have not been stopped yet. */
const liveGroups = new Set<number>();

export function trackProcessGroup(pid: number): void {
  liveGroups.add(pid);
}

export function untrackProcessGroup(pid: number): void {
  liveGroups.delete(pid);
}

/** Sends `signal` to the whole process group led by `pid` (to the process itself on Windows). */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(isWindows ? pid : -pid, signal);
  } catch {
    // Already gone.
  }
}

export function killGroup(pid: number): void {
  signalGroup(pid, "SIGKILL");
}

/** Kills every process group still running; used when the CLI is interrupted. */
export function killAllProcessGroups(): void {
  for (const pid of liveGroups) killGroup(pid);
  liveGroups.clear();
}
