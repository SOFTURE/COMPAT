import { describe, expect, it } from "vitest";
import { parseOtaOutput } from "../../src/resolve/ota-updates.js";

const sha = (char: string) => char.repeat(40);

describe("parseOtaOutput", () => {
  it("keeps each commit once, at its first label", () => {
    const output = `${sha("a")}\tg1\n\n${sha("b")}\tg2\n${sha("a")}\tg3\n`;
    expect(parseOtaOutput(output)).toEqual({
      ok: true,
      value: {
        refs: [
          { ref: "ota:g1", commit: sha("a") },
          { ref: "ota:g2", commit: sha("b") },
        ],
        notes: [],
      },
    });
  });

  it("notes an update published from a dirty working tree", () => {
    expect(parseOtaOutput(`abcdef1\tg1\tdirty\r\n${sha("b")}\tg2\tfalse\n`)).toEqual({
      ok: true,
      value: {
        refs: [
          { ref: "ota:g1", commit: "abcdef1" },
          { ref: "ota:g2", commit: sha("b") },
        ],
        notes: [
          "ota:g1 was published from a dirty working tree; commit abcdef1 only approximates its bundle",
        ],
      },
    });
  });

  it("finds nothing on empty output, without failing (issue #98)", () => {
    expect(parseOtaOutput("\n")).toEqual({
      ok: true,
      value: { nothingFound: "the command exited 0 and printed no update" },
    });
  });

  it.each([["not-a-commit\tg1"], [`${sha("a")}`], [`${sha("a")}\t`]])("fails on the line %j", (line) => {
    expect(parseOtaOutput(line)).toEqual({ ok: false, error: `line 1 is not "commit<TAB>label": ${line}` });
  });
});
