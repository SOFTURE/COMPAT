import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { persistedEnumsLayer } from "../../../src/layers/persisted-enums/persisted-enums-layer.js";
import type { LayerResult } from "../../../src/model/finding.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

const dbContext = (...enums: string[]) =>
  ["class AppDbContext {", ...enums.map((name) => `  void A() { ConfigureEnum<${name}>(); }`), "}"].join(
    "\n",
  );

beforeAll(async () => {
  repo = createRepo([
    {
      files: {
        "src/AppDbContext.cs": dbContext("Domain.Color", "Size?"),
        "src/Color.cs": "public enum Color { Red, Green }",
        "src/Size.cs": "public enum Size { Small = 1, Large = 2 }",
        "src/Legacy.cs": "public enum Legacy { Old }",
        "src/Dup/A.cs": "enum Twin { One }",
        "src/Dup/B.cs": "enum Twin { One }",
        "web/status.ts": 'export enum Status { Draft = "draft" }',
        "web/readme.md": "enum Fake { X }",
      },
      tag: "v1",
    },
    {
      files: {
        "src/AppDbContext.cs": dbContext("Domain.Color", "Size?", "Shape"),
        "src/Color.cs": "public enum Color {\n  Red,\n  Green,\n  Blue\n}",
        "src/Size.cs": "public enum Size { Small = 1, Large = 3 }",
        "src/Shape.cs": "public enum Shape { Circle }",
        "src/Legacy.cs": null,
        "src/Dup/B.cs": "enum Twin { One, Two }",
        "web/status.ts": 'export enum Status { Draft = "draft", Live = "live" }',
      },
      tag: "v2",
    },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-enums-layer-"));
  const opened = await Promise.all([
    openRefTree({ repoDir: repo.dir, ref: "v1", side: "base", tempRoot }),
    openRefTree({ repoDir: repo.dir, ref: "v2", side: "revision", tempRoot }),
  ]);
  if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
  base = opened[0].value;
  revision = opened[1].value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

const discover = {
  kind: "discover",
  files: "src/*DbContext.cs",
  pattern: "ConfigureEnum<([\\w.?]+)>",
  storage: "string",
};

function run(config: Record<string, unknown>): Promise<LayerResult> {
  return persistedEnumsLayer.run({
    config: { sources: ["src/**/*.cs", "web/**"], ...config },
    base,
    revision,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: process.env,
    log: () => {},
  });
}

const brief = (result: LayerResult) =>
  "findings" in result ? result.findings.map((finding) => [finding.id, finding.class, finding.subject]) : [];

describe("persisted-enums layer", () => {
  it("discovers enums from the DbContext and classifies their changes", async () => {
    const result = await run({ enums: [discover] });
    expect(result.status).toBe("ran");
    expect(brief(result)).toEqual([
      ["enum-member-added", "rollback-risk", "Color.Blue"],
      ["enum-added", "safe", "Shape"],
    ]);
    expect("notes" in result && result.notes).toEqual([
      "3 persisted enum(s) checked",
      'enum "Shape" is discovered only at the revision ref (src/AppDbContext.cs:4)',
      "1 file(s) matched by sources are neither C# nor TypeScript and were skipped",
    ]);
  });

  it("gives the member line and the discovery site as evidence", async () => {
    const result = await run({ enums: [discover] });
    const finding = "findings" in result ? result.findings[0] : undefined;
    expect(finding?.evidence).toEqual([
      { side: "revision", ref: "v2", commit: revision.commit, path: "src/Color.cs", line: 4 },
      { side: "revision", ref: "v2", commit: revision.commit, path: "src/AppDbContext.cs", line: 2 },
    ]);
  });

  it("lets a named entry override the storage of a discovered enum", async () => {
    const result = await run({ enums: [discover, { kind: "named", name: "Size", storage: "int" }] });
    expect(brief(result)).toEqual([
      ["enum-member-added", "rollback-risk", "Color.Blue"],
      ["enum-added", "safe", "Shape"],
      ["enum-member-renumbered", "breaking", "Size.Large"],
    ]);
  });

  it("compares TypeScript string enums by value", async () => {
    const result = await run({ enums: [{ kind: "named", name: "Status", storage: "string" }] });
    expect(brief(result)).toEqual([["enum-member-added", "rollback-risk", "Status.Live"]]);
  });

  it("reports an enum removed from the sources as needs-action", async () => {
    const result = await run({ enums: [{ kind: "named", name: "Legacy", storage: "int" }] });
    expect(brief(result)).toEqual([["enum-removed", "needs-action", "Legacy"]]);
  });

  it("fails an enum declared in several files, keeps the other findings, and resolves it with file", async () => {
    const twin = { kind: "named", name: "Twin", storage: "int" };
    const result = await run({ enums: [twin, { kind: "named", name: "Status", storage: "string" }] });
    expect(result).toMatchObject({
      status: "failed",
      error:
        'enum "Twin": declared more than once at v1 (src/Dup/A.cs, src/Dup/B.cs); set "file" on a named entry',
    });
    expect(brief(result)).toEqual([["enum-member-added", "rollback-risk", "Status.Live"]]);

    const pinned = await run({ enums: [{ ...twin, file: "src/Dup/B.cs" }] });
    expect(brief(pinned)).toEqual([["enum-member-added", "rollback-risk", "Twin.Two"]]);
  });

  it("fails an enum declared at neither ref", async () => {
    const result = await run({ enums: [{ kind: "named", name: "Missing", storage: "string" }] });
    expect(result).toMatchObject({
      status: "failed",
      error: 'enum "Missing": not declared in the sources at either ref',
    });
  });

  it("fails an enum discovered with two storages unless a named entry settles it", async () => {
    const conflicting = [discover, { ...discover, storage: "int" }];
    const result = await run({ enums: conflicting });
    expect(result.status).toBe("failed");
    expect("error" in result && result.error).toContain('enum "Color": discovered with conflicting storage');
    const settled = await run({
      enums: [
        ...conflicting,
        { kind: "named", name: "Color", storage: "string" },
        { kind: "named", name: "Size", storage: "string" },
        { kind: "named", name: "Shape", storage: "string" },
      ],
    });
    expect(settled.status).toBe("ran");
  });

  it("applies accept entries with and without a member and reports unused ones", async () => {
    const result = await run({
      enums: [discover],
      accept: [
        {
          id: "enum-member-added",
          enum: "Color",
          member: "Blue",
          reason: "the base build never lists colors",
        },
        { id: "enum-added", enum: "Shape", reason: "new table" },
        { id: "enum-member-removed", enum: "Color", member: "Red", reason: "stale" },
      ],
    });
    expect("findings" in result && result.findings.map((finding) => finding.accepted?.reason)).toEqual([
      "the base build never lists colors",
      "new table",
    ]);
    expect("notes" in result && result.notes.slice(-3)).toEqual([
      "accept entry enum-member-added on Color.Blue accepted 1 finding(s)",
      "accept entry enum-added on Shape accepted 1 finding(s)",
      "accept entry enum-member-removed on Color.Red matched nothing; remove it if the change is gone",
    ]);
  });

  it("does not let an accept entry without a member hide a member finding", async () => {
    const result = await run({
      enums: [discover],
      accept: [{ id: "enum-member-added", enum: "Color", reason: "too broad" }],
    });
    expect("findings" in result && result.findings[0]?.accepted).toBeUndefined();
  });
});
