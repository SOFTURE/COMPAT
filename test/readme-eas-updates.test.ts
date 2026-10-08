import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRefList } from "../src/resolve/ref-list.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** The `run` command of the README `easUpdates` example. */
function getReadmeEasCommand(): string {
  const block = /```json\n("refs": \[[\s\S]*?"easUpdates"[\s\S]*?\n\])\n```/.exec(readme)?.[1];
  if (block === undefined) throw new Error("README has no easUpdates example");
  const refs = JSON.parse(`{${block}}`).refs as { easUpdates?: { run: string } }[];
  const command = refs.find((entry) => entry.easUpdates !== undefined)?.easUpdates?.run;
  if (command === undefined) throw new Error("README easUpdates example has no run command");
  return command;
}

const sha = (char: string) => char.repeat(40);

// The shape `eas branch:list --json` prints (eas-cli 20.x, issue #97), trimmed to the fields that matter.
const BRANCHES = [
  { name: "development", updates: [{ gitCommitHash: sha("d"), isGitWorkingTreeDirty: false }] },
  {
    name: "production",
    updates: [
      { gitCommitHash: sha("a"), isGitWorkingTreeDirty: true, platform: "ios", runtimeVersion: "2.2.4" },
      { gitCommitHash: sha("a"), isGitWorkingTreeDirty: true, platform: "android", runtimeVersion: "2.2.4" },
    ],
  },
];

function hasJq(): boolean {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Runs the README command in a repository whose `apps/mobile` has a fake `eas` with the given body. */
function runReadmeCommand(easScript: string) {
  dir = mkdtempSync(join(tmpdir(), "compat-readme-eas-"));
  const bin = join(dir, "bin");
  const repoDir = join(dir, "repo");
  mkdirSync(bin);
  mkdirSync(join(repoDir, "apps", "mobile"), { recursive: true });
  writeFileSync(join(bin, "eas"), `#!/bin/sh\n${easScript}\n`);
  chmodSync(join(bin, "eas"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  return resolveRefList({ easUpdates: { run: getReadmeEasCommand() }, optional: true }, { repoDir, env });
}

describe.skipIf(!hasJq())("README easUpdates example (issue #97)", () => {
  it("resolves an update on the production branch to one ota ref", async () => {
    const result = await runReadmeCommand(`cat <<'JSON'\n${JSON.stringify(BRANCHES)}\nJSON`);
    expect(result).toEqual({
      ok: true,
      value: {
        refs: [{ ref: "ota:2.2.4-ios", commit: sha("a"), resolver: "easUpdates" }],
        notes: [
          `ota:2.2.4-ios was published from a dirty working tree; commit ${sha("a").slice(0, 12)} only approximates its bundle`,
        ],
      },
    });
  });

  it("fails when eas fails, even though the entry is optional", async () => {
    const result = await runReadmeCommand("echo 'not logged in' >&2; exit 1");
    expect(result).toEqual({
      ok: false,
      error: "cannot resolve easUpdates: easUpdates command exited 1: not logged in",
    });
  });
});
