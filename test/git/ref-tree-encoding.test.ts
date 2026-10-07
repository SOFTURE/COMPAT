import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeText, openRefTree, type RefTree } from "../../src/git/ref-tree.js";
import { createRepo, type TestRepo } from "../helpers/git-repo.js";

const TEXT = "INSERT INTO [Breeds] ([Name]) VALUES (N'Café');\r\nGO\r\n";

function utf16be(text: string): Buffer {
  const bytes = Buffer.from(text, "utf16le");
  bytes.swap16();
  return bytes;
}

let repo: TestRepo;
let tempRoot: string;
let tree: RefTree;

beforeAll(async () => {
  repo = createRepo([
    {
      files: {
        "utf8.sql": TEXT,
        "utf8-bom.sql": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, "utf8")]),
        "utf16le.sql": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, "utf16le")]),
        "utf16be.sql": Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(TEXT)]),
      },
      tag: "v1",
    },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-ref-tree-encoding-"));
  const opened = await openRefTree({ repoDir: repo.dir, ref: "v1", side: "base", tempRoot });
  if (!opened.ok) throw new Error(opened.error);
  tree = opened.value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("RefTree.readFile encodings", () => {
  it.each(["utf8.sql", "utf8-bom.sql", "utf16le.sql", "utf16be.sql"])(
    "decodes %s to the same text",
    async (path) => {
      expect(await tree.readFile(path)).toEqual({ ok: true, value: TEXT });
    },
  );
});

describe("decodeText", () => {
  it("returns an empty string for empty input", () => {
    expect(decodeText(Buffer.alloc(0))).toBe("");
  });

  it("replaces a trailing odd byte of UTF-16BE text with U+FFFD", () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be("ab"), Buffer.from([0x00])]))).toBe(
      "ab\uFFFD",
    );
  });
});
