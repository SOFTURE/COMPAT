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

// The shapes `eas branch:list --json` and `eas channel:view --json` print (eas-cli 20.x, issues #97 and #110),
// trimmed to the fields that matter. The production channel serves the branch "production-2.3", not "production".
const BRANCHES = [
  {
    id: "branch-dev",
    name: "development",
    updates: [{ gitCommitHash: sha("d"), isGitWorkingTreeDirty: false }],
  },
  {
    id: "branch-prod",
    name: "production",
    updates: [
      { gitCommitHash: sha("c"), isGitWorkingTreeDirty: false, platform: "ios", runtimeVersion: "2.1.0" },
    ],
  },
  {
    id: "branch-prod-23",
    name: "production-2.3",
    updates: [
      { gitCommitHash: sha("a"), isGitWorkingTreeDirty: true, platform: "ios", runtimeVersion: "2.2.4" },
      { gitCommitHash: sha("a"), isGitWorkingTreeDirty: true, platform: "android", runtimeVersion: "2.2.4" },
    ],
  },
  { id: "branch-empty", name: "staging", updates: [] },
];

function getChannel(branchIds: string[]) {
  const mapping = {
    data: branchIds.map((branchId) => ({ branchId, branchMappingLogic: "true" })),
    version: 0,
  };
  return { currentPage: { name: "production", branchMapping: JSON.stringify(mapping) } };
}

/** A fake `eas` body that answers `channel:view` with the channel mapped to the given branch ids. */
function getEasScript(branchIds: string[]): string {
  return [
    'case "$1" in',
    `  channel:view) cat <<'JSON'\n${JSON.stringify(getChannel(branchIds))}\nJSON\n  ;;`,
    `  branch:list) cat <<'JSON'\n${JSON.stringify(BRANCHES)}\nJSON\n  ;;`,
    "esac",
  ].join("\n");
}

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

describe.skipIf(!hasJq())("README easUpdates example (issues #97, #110)", () => {
  it("resolves the updates of the branch the channel maps, whatever its name", async () => {
    const result = await runReadmeCommand(getEasScript(["branch-prod-23"]));
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

  it("resolves the updates of every branch in a rollout", async () => {
    const result = await runReadmeCommand(getEasScript(["branch-prod", "branch-prod-23"]));
    expect(result.ok && "refs" in result.value ? result.value.refs.map((ref) => ref.ref) : result).toEqual([
      "ota:2.1.0-ios",
      "ota:2.2.4-ios",
    ]);
  });

  it("notes a channel that maps no branch", async () => {
    const result = await runReadmeCommand(getEasScript([]));
    // The example entry stands alone here, so the list fails; next to builds it is a note.
    expect(result).toEqual({
      ok: false,
      error:
        "no entry of refs resolved to a ref (optional entry easUpdates resolved to nothing: the command exited 0 and printed no update: channel production maps no branch)",
    });
  });

  it("notes a mapped branch with no update", async () => {
    const result = await runReadmeCommand(getEasScript(["branch-empty"]));
    // The example entry stands alone here, so the list fails; next to builds it is a note.
    expect(result).toEqual({
      ok: false,
      error:
        "no entry of refs resolved to a ref (optional entry easUpdates resolved to nothing: the command exited 0 and printed no update: the branches of channel production have no update)",
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
