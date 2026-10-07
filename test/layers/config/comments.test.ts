// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { describe, expect, it } from "vitest";
import { createLineLocator, stripComments } from "../../../src/layers/config/comments.js";

describe("stripComments", () => {
  it("keeps the text as is for style none", () => {
    expect(stripComments("a # b", "none")).toBe("a # b");
  });

  it("blanks a hash comment line and a comment after whitespace", () => {
    const text = "# ${A}\nkey: ${B} # ${C}\n";
    expect(stripComments(text, "hash")).toBe("      \nkey: ${B}       \n");
  });

  it("keeps a hash that is not preceded by whitespace", () => {
    expect(stripComments("url: a#b", "hash")).toBe("url: a#b");
  });

  it("keeps a hash inside quotes and resets the quote state at the line end", () => {
    expect(stripComments('a: "x # y"\nit\'s # c\n# d', "hash")).toBe('a: "x # y"\nit\'s # c\n   ');
  });

  it("does not let a backslash in single quotes or at a line end hide the next comment", () => {
    expect(stripComments("a: 'C:\\' # ${X}", "hash")).toBe("a: 'C:\\'       ");
    expect(stripComments('a: "x\\\n# ${X}', "hash")).toBe('a: "x\\\n      ');
  });

  it("honours backslash escapes in slash-style character literals", () => {
    expect(stripComments("c = '\\''; // ${X}", "slash")).toBe("c = '\\'';        ");
  });

  it("blanks slash line comments and block comments over two lines", () => {
    const text = "a(); // b\n/* c\nd */ e();";
    expect(stripComments(text, "slash")).toBe("a();     \n    \n     e();");
  });

  it("keeps // inside a string", () => {
    expect(stripComments('var url = "http://x"; // c', "slash")).toBe('var url = "http://x";     ');
  });

  it("keeps the length and every newline, including CRLF", () => {
    const text = "a # b\r\n/* x\r\ny */\r\n";
    for (const style of ["hash", "slash"] as const) {
      const stripped = stripComments(text, style);
      expect(stripped).toHaveLength(text.length);
      expect(stripped.split("\n")).toHaveLength(text.split("\n").length);
      expect(stripped.split("\r")).toHaveLength(text.split("\r").length);
    }
  });
});

describe("createLineLocator", () => {
  it("maps offsets to 1-based lines", () => {
    const getLine = createLineLocator("ab\ncd\n\nef");
    expect([0, 1, 2, 3, 5, 6, 7, 8].map(getLine)).toEqual([1, 1, 1, 2, 2, 3, 4, 4]);
  });

  it("handles an empty text", () => {
    expect(createLineLocator("")(0)).toBe(1);
  });
});
