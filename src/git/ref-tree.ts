import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Side } from "../model/finding.js";
import { getTailLines, runProcess } from "../process/run-process.js";
import { err, ok, type Result } from "../result.js";
import { globToRegExp } from "./glob.js";

export type RefTree = {
  side: Side;
  ref: string;
  commit: string;
  /** Repository-relative paths of files at this commit matching any of the globs, sorted. */
  listFiles(globs: string | string[]): Promise<Result<string[]>>;
  /** File content at this commit, or `null` when the file does not exist there. */
  readFile(path: string): Promise<Result<string | null>>;
  /** A directory holding every tracked file of this commit; created once per run. */
  materialize(): Promise<Result<string>>;
};

export type OpenRefTreeOptions = { repoDir: string; ref: string; side: Side; tempRoot: string };

async function runGit(repoDir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Result<string>> {
  const result = await runProcess({ command: "git", args, cwd: repoDir, env: env ?? process.env });
  if (!result.ok) {
    return err(
      result.error.kind === "spawn-failed" ? `git could not start (${result.error.code})` : "git timed out",
    );
  }
  if (result.value.exitCode !== 0) {
    return err(getTailLines(result.value.stderr, 5) || `git ${args[0]} exited ${result.value.exitCode}`);
  }
  return ok(result.value.stdout);
}

export async function resolveCommit(repoDir: string, ref: string): Promise<Result<string>> {
  const result = await runGit(repoDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (!result.ok || result.value.trim() === "") {
    return err(`git ref "${ref}" does not resolve to a commit in ${repoDir}`);
  }
  return ok(result.value.trim());
}

export async function openRefTree(options: OpenRefTreeOptions): Promise<Result<RefTree>> {
  const commit = await resolveCommit(options.repoDir, options.ref);
  if (!commit.ok) return commit;
  const { repoDir, side, ref, tempRoot } = options;
  let allFiles: Promise<Result<string[]>> | undefined;
  let materialized: Promise<Result<string>> | undefined;

  const listAllFiles = (): Promise<Result<string[]>> => {
    allFiles ??= runGit(repoDir, ["ls-tree", "-r", "-z", "--name-only", commit.value]).then((result) =>
      result.ok
        ? ok(result.value.split("\0").filter((path) => path !== ""))
        : err(`git ls-tree failed: ${result.error}`),
    );
    return allFiles;
  };

  const tree: RefTree = {
    side,
    ref,
    commit: commit.value,
    async listFiles(globs) {
      const files = await listAllFiles();
      if (!files.ok) return files;
      const patterns = (Array.isArray(globs) ? globs : [globs]).map(globToRegExp);
      return ok(files.value.filter((path) => patterns.some((pattern) => pattern.test(path))).sort());
    },
    async readFile(path) {
      const files = await listAllFiles();
      if (!files.ok) return files;
      if (!files.value.includes(path)) return ok(null);
      const content = await runGit(repoDir, ["cat-file", "blob", `${commit.value}:${path}`]);
      if (!content.ok) return err(`cannot read ${path} at ${ref}: ${content.error}`);
      return ok(content.value);
    },
    materialize() {
      materialized ??= materializeTree(repoDir, commit.value, side, tempRoot);
      return materialized;
    },
  };
  return ok(tree);
}

async function materializeTree(
  repoDir: string,
  commit: string,
  side: Side,
  tempRoot: string,
): Promise<Result<string>> {
  // A temporary index keeps the consumer's index and working tree untouched, and unlike
  // `git archive` it ignores `export-ignore` attributes.
  const workDir = await mkdtemp(join(tempRoot, `${side}-`));
  const treeDir = join(workDir, "tree");
  await mkdir(treeDir);
  const env = { ...process.env, GIT_INDEX_FILE: join(workDir, "index") };
  const readTree = await runGit(repoDir, ["read-tree", commit], env);
  if (!readTree.ok) return err(`cannot materialize ${commit}: ${readTree.error}`);
  const checkout = await runGit(repoDir, ["checkout-index", "-a", "-f", `--prefix=${treeDir}/`], env);
  if (!checkout.ok) return err(`cannot materialize ${commit}: ${checkout.error}`);
  await rm(join(workDir, "index"), { force: true });
  return ok(treeDir);
}
