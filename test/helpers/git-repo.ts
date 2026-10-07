import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type Commit = {
  /** File path to content; `null` deletes the file. */
  files: Record<string, string | null>;
  tag?: string;
};

export type TestRepo = { dir: string; git(...args: string[]): string; cleanup(): void };

export function createRepo(commits: Commit[]): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "compat-test-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  for (const commit of commits) {
    for (const [path, content] of Object.entries(commit.files)) {
      const fullPath = join(dir, path);
      if (content === null) {
        git("rm", "-q", path);
        continue;
      }
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
      git("add", path);
    }
    git("commit", "-q", "--allow-empty", "-m", commit.tag ?? "commit");
    if (commit.tag) git("tag", commit.tag);
  }
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeRepoFile(repo: TestRepo, path: string, content: string): void {
  const fullPath = join(repo.dir, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}
