import { describe, expect, it } from "vitest";
import { maskYamlComments } from "../../../src/layers/config/yaml-text.js";

function mask(lines: string[]): { text: string[]; scalarLines: number[] } {
  const masked = maskYamlComments(lines.join("\n"));
  return {
    text: masked.text.split("\n").map((line) => line.trimEnd()),
    scalarLines: [...masked.scalarLines],
  };
}

describe("maskYamlComments", () => {
  it("blanks full-line and trailing comments and keeps offsets", () => {
    const text = "# head\na: 1 # note\n  #b: 2\nc: x#y";
    const masked = maskYamlComments(text);
    expect(masked.text).toBe("      \na: 1       \n       \nc: x#y");
    expect([...masked.scalarLines]).toEqual([]);
  });

  it("keeps a hash inside quoted scalars", () => {
    expect(mask(['a: "x # y" # z', "b: 'p # q' # r"]).text).toEqual(['a: "x # y"', "b: 'p # q'"]);
  });

  it("reads an apostrophe inside a plain scalar as text", () => {
    expect(mask(["command: echo it's done # drop me", "next: ok"]).text).toEqual([
      "command: echo it's done",
      "next: ok",
    ]);
  });

  it("keeps block scalar content, including a hash after whitespace", () => {
    const result = mask([
      "command: | # header note",
      "  echo a # kept",
      "",
      "  # kept too",
      "other: x # dropped",
    ]);
    expect(result.text).toEqual(["command: |", "  echo a # kept", "", "  # kept too", "other: x"]);
    expect(result.scalarLines).toEqual([1, 2, 3]);
  });

  it("ends a block scalar at the owning node's indent", () => {
    const result = mask([
      "services:",
      "  app:",
      "    entrypoint: >-",
      "      run # kept",
      "    image: x # dropped",
      "    command:",
      "    - |",
      "      sh # kept",
      "    - b # dropped",
      "    - key: |",
      "        v # kept",
      "      other: 1 # dropped",
    ]);
    expect(result.text).toEqual([
      "services:",
      "  app:",
      "    entrypoint: >-",
      "      run # kept",
      "    image: x",
      "    command:",
      "    - |",
      "      sh # kept",
      "    - b",
      "    - key: |",
      "        v # kept",
      "      other: 1",
    ]);
    expect(result.scalarLines).toEqual([3, 7, 10]);
  });

  it("does not read a pipe inside a plain scalar as a block header", () => {
    expect(mask(["a: x | y # dropped", "b: 1"]).text).toEqual(["a: x | y", "b: 1"]);
  });

  it("carries double-quoted scalars across lines with escapes", () => {
    const result = mask(['a: "one \\" two', "  # still text", '  end" # dropped', "b: 1"]);
    expect(result.text).toEqual(['a: "one \\" two', "  # still text", '  end"', "b: 1"]);
    expect(result.scalarLines).toEqual([1, 2]);
  });

  it("carries single-quoted scalars across lines with doubled quotes", () => {
    const result = mask(["a: 'it''s", "  # text'", "b: 1 # dropped"]);
    expect(result.text).toEqual(["a: 'it''s", "  # text'", "b: 1"]);
    expect(result.scalarLines).toEqual([1]);
  });

  it("opens quotes at token starts in flow collections, quoted keys and after tags", () => {
    expect(
      mask(["x: [a, \"b # c\", 'd'] # e", '"k # 1": v # f', "t: !!str 'g # h' # i", "u: &anc 'j # k' # l"])
        .text,
    ).toEqual(["x: [a, \"b # c\", 'd']", '"k # 1": v', "t: !!str 'g # h'", "u: &anc 'j # k'"]);
  });

  it("keeps carriage returns", () => {
    expect(maskYamlComments("a: 1 # x\r\nb: 2\r\n").text).toBe("a: 1    \r\nb: 2\r\n");
  });
});
