import { readFileSync } from "node:fs";

/** Whether a process exists and is not a zombie waiting to be reaped. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // The state follows the parenthesised command name: `123 (node) S ...`.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true; // No procfs: trust kill(0).
  }
}
