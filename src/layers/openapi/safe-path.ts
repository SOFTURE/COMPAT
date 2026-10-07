import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { err, ok, type Result } from "../../result.js";

export type ResolvedPath = { status: "found"; path: string } | { status: "absent" };

/**
 * Resolves a repository-relative path inside a materialized tree and refuses anything that
 * leaves it, including through a symlink.
 */
export async function resolveInsideTree(root: string, path: string): Promise<Result<ResolvedPath>> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    return err(`path "${path}" must stay inside the repository`);
  }
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(join(root, path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok({ status: "absent" });
    return err(`cannot resolve "${path}" (${(error as NodeJS.ErrnoException).code})`);
  }
  const fromRoot = relative(realRoot, realTarget);
  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    return err(`path "${path}" resolves outside the repository`);
  }
  return ok({ status: "found", path: realTarget });
}

/** A URL safe to print in a report: no user info and no query or fragment, which may carry tokens. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hasSecrets =
      parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${hasSecrets ? " (redacted)" : ""}`;
  } catch {
    return "(invalid URL)";
  }
}
