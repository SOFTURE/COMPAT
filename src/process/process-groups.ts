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

/** Whether any process of the group led by `pid` still exists (zombies not yet reaped included). */
export function isGroupAlive(pid: number): boolean {
  if (isWindows) return false; // No process groups; the caller waits for the process itself.
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM: a member exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const GROUP_EXIT_POLL_MS = 10;

/**
 * Waits until no process of the group led by `pid` is left, or `timeoutMs` passes. SIGKILL is
 * delivered asynchronously, so killed members (e.g. an app host the shell started) can outlive
 * the leader's exit event for a moment and still hold their port.
 */
export async function waitForGroupExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, GROUP_EXIT_POLL_MS));
  }
}

/** Kills every process group still running; used when the CLI is interrupted. */
export function killAllProcessGroups(): void {
  for (const pid of liveGroups) killGroup(pid);
  liveGroups.clear();
}
