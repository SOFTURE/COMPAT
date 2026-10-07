import { describe, expect, it } from "vitest";
import { tokenize } from "../../../src/layers/persisted-enums/tokenize.js";

describe("tokenize TypeScript template literals", () => {
  it("keeps a template without holes as its text", () => {
    expect(tokenize("x = `/api/pets`;", "typescript")[2]).toEqual({
      kind: "string",
      text: "/api/pets",
      line: 1,
    });
  });

  it("reads holes with nested template literals, strings and braces as one token", () => {
    const tokens = tokenize(
      "const url = `/a/${encodeURIComponent(`${id}`)}/b/${f({ k: '}' /* } */ })}`;\nnext;",
      "typescript",
    );
    expect(tokens.map((token) => token.text)).toEqual([
      "const",
      "url",
      "=",
      "/a/${}/b/${}",
      ";",
      "next",
      ";",
    ]);
    expect(tokens[3]).toMatchObject({
      isInterpolated: true,
      holes: ["encodeURIComponent(`${id}`)", "f({ k: '}' /* } */ })"],
    });
    expect(tokens[5]?.line).toBe(2);
  });

  it("keeps escaped backticks and dollars as text", () => {
    expect(tokenize("`a\\`b\\${c}`", "typescript")).toEqual([{ kind: "string", text: "a`b${c}", line: 1 }]);
  });
});
