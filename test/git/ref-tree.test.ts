import { existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../src/git/ref-tree.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";

let repo: TestRepo;
let tempRoot: string;

beforeAll(async () => {
  repo = createRepo([
    {
      files: {
        "api/openapi.yaml": "v1",
        "db/migrations/0001.sql": "create",
        "README.md": "readme",
        "db/seed.sql": "\uFEFFinsert",
      },
      tag: "v1",
    },
    {
      files: {
        "api/openapi.yaml": "v2",
        "db/migrations/0002.sql": "alter",
        "ignored/spec.yaml": "kept",
        ".gitattributes": "ignored/** export-ignore\n",
        "README.md": null,
      },
      tag: "v2",
    },
  ]);
  writeRepoFile(repo, "api/openapi.yaml", "uncommitted");
  tempRoot = await mkdtemp(join(tmpdir(), "compat-ref-tree-"));
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

async function open(ref: string, side: "base" | "revision" = "base"): Promise<RefTree> {
  const tree = await openRefTree({ repoDir: repo.dir, ref, side, tempRoot });
  if (!tree.ok) throw new Error(tree.error);
  return tree.value;
}

describe("openRefTree", () => {
  it("resolves a tag to its commit", async () => {
    const tree = await open("v1");
    expect(tree.commit).toBe(repo.git("rev-parse", "v1^{commit}").trim());
    expect(tree.ref).toBe("v1");
  });

  it("returns an error naming an unknown ref", async () => {
    const tree = await openRefTree({ repoDir: repo.dir, ref: "v9", side: "base", tempRoot });
    expect(tree).toEqual({ ok: false, error: `git ref "v9" does not resolve to a commit in ${repo.dir}` });
  });

  it("does not parse a ref starting with a dash as an option", async () => {
    const tree = await openRefTree({ repoDir: repo.dir, ref: "--all", side: "base", tempRoot });
    expect(tree.ok).toBe(false);
  });

  it("reads committed content, not the working tree", async () => {
    expect(await (await open("v1")).readFile("api/openapi.yaml")).toEqual({ ok: true, value: "v1" });
    expect(await (await open("v2")).readFile("api/openapi.yaml")).toEqual({ ok: true, value: "v2" });
  });

  it("returns null for a file absent at the ref", async () => {
    expect(await (await open("v2")).readFile("README.md")).toEqual({ ok: true, value: null });
    expect(await (await open("v1")).readFile("db/migrations/0002.sql")).toEqual({ ok: true, value: null });
  });

  it("strips a UTF-8 byte order mark", async () => {
    expect(await (await open("v1")).readFile("db/seed.sql")).toEqual({ ok: true, value: "insert" });
  });

  it("uses repository-root paths when opened from a subdirectory", async () => {
    const opened = await openRefTree({ repoDir: join(repo.dir, "db"), ref: "v2", side: "base", tempRoot });
    if (!opened.ok) throw new Error(opened.error);
    expect(await opened.value.listFiles("db/migrations/*.sql")).toEqual({
      ok: true,
      value: ["db/migrations/0001.sql", "db/migrations/0002.sql"],
    });
    expect(await opened.value.readFile("api/openapi.yaml")).toEqual({ ok: true, value: "v2" });
    const materialized = await opened.value.materialize();
    if (!materialized.ok) throw new Error(materialized.error);
    expect(readFileSync(join(materialized.value, "api/openapi.yaml"), "utf8")).toBe("v2");
  });

  it("materializes under the real path when the temp root is behind a symlink", async () => {
    const linkedRoot = join(tempRoot, "linked");
    symlinkSync(tempRoot, linkedRoot);
    const opened = await openRefTree({ repoDir: repo.dir, ref: "v1", side: "base", tempRoot: linkedRoot });
    if (!opened.ok) throw new Error(opened.error);
    const materialized = await opened.value.materialize();
    if (!materialized.ok) throw new Error(materialized.error);
    expect(materialized.value).toBe(realpathSync(materialized.value));
    expect(materialized.value.startsWith(linkedRoot)).toBe(false);
  });

  it("returns an error outside a git repository", async () => {
    const result = await openRefTree({ repoDir: tempRoot, ref: "v1", side: "base", tempRoot });
    expect(result).toEqual({ ok: false, error: `${tempRoot} is not inside a git repository` });
  });

  it("lists files by path and by glob", async () => {
    const tree = await open("v2");
    expect(await tree.listFiles("db/migrations/*.sql")).toEqual({
      ok: true,
      value: ["db/migrations/0001.sql", "db/migrations/0002.sql"],
    });
    expect(await tree.listFiles(["api/openapi.yaml", "nothing/*"])).toEqual({
      ok: true,
      value: ["api/openapi.yaml"],
    });
  });

  it("materializes the commit including export-ignore paths, once", async () => {
    const tree = await open("v2", "revision");
    const first = await tree.materialize();
    const second = await tree.materialize();
    if (!first.ok) throw new Error(first.error);
    expect(second).toEqual(first);
    expect(first.value.startsWith(tempRoot)).toBe(true);
    expect(readFileSync(join(first.value, "api/openapi.yaml"), "utf8")).toBe("v2");
    expect(readFileSync(join(first.value, "ignored/spec.yaml"), "utf8")).toBe("kept");
    expect(existsSync(join(first.value, "README.md"))).toBe(false);
    expect(repo.git("status", "--porcelain").trim()).toBe("M api/openapi.yaml");
  });
});
