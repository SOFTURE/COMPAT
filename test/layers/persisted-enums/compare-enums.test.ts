import { describe, expect, it } from "vitest";
import { compareEnums, type EnumStorage } from "../../../src/layers/persisted-enums/compare-enums.js";
import { type EnumDeclaration, parseEnums } from "../../../src/layers/persisted-enums/parse-enums.js";

function declaration(text: string, language: "csharp" | "typescript" = "csharp"): EnumDeclaration {
  const result = parseEnums(text, language);
  const [first] = result.declarations;
  if (first === undefined || result.failures.length > 0) throw new Error(`cannot parse ${text}`);
  return first;
}

function compare(base: string, revision: string, storage: EnumStorage, language?: "csharp" | "typescript") {
  return compareEnums({
    enumName: "E",
    storage,
    base: declaration(base, language),
    revision: declaration(revision, language),
  }).map((change) => [change.id, change.class, change.subject]);
}

describe("compareEnums with string storage", () => {
  it("reports nothing for identical enums and for reordered members", () => {
    expect(compare("enum E { A, B, C }", "enum E { A, B, C }", "string")).toEqual([]);
    expect(compare("enum E { A, B, C }", "enum E { C, A, B }", "string")).toEqual([]);
  });

  it("marks an added member as rollback-risk (research F7)", () => {
    expect(compare("enum E { A, B }", "enum E { A, B, C }", "string")).toEqual([
      ["enum-member-added", "rollback-risk", "E.C"],
    ]);
  });

  it("marks a removed member as breaking", () => {
    expect(compare("enum E { A, B, C }", "enum E { A, C = 2 }", "string")).toEqual([
      ["enum-member-removed", "breaking", "E.B"],
    ]);
  });

  it("pairs a removed and an added member with the same number into one breaking rename", () => {
    expect(compare("enum E { A, B }", "enum E { A, Bee }", "string")).toEqual([
      ["enum-member-renamed", "breaking", "E.B -> E.Bee"],
    ]);
  });

  it("treats a change of letter case as a rename", () => {
    expect(compare("enum E { A, B }", "enum E { A, b }", "string")).toEqual([
      ["enum-member-renamed", "breaking", "E.B -> E.b"],
    ]);
  });

  it("compares TypeScript string enums by value and pairs a changed value by member name", () => {
    expect(
      compare(
        'enum E { Cat = "cat", Dog = "dog" }',
        'enum E { Dog = "dog", Cat = "kitty" }',
        "string",
        "typescript",
      ),
    ).toEqual([["enum-member-renamed", "breaking", 'E.Cat ("cat" -> "kitty")']]);
    expect(
      compare('enum E { Cat = "cat" }', 'enum E { Kitty = "cat", Dog = "dog" }', "string", "typescript"),
    ).toEqual([["enum-member-added", "rollback-risk", "E.Dog"]]);
  });

  it("reports removed and added separately when nothing pairs them", () => {
    expect(compare("enum E { A = 1, B = 2 }", "enum E { A = 1, C = 3 }", "string")).toEqual([
      ["enum-member-removed", "breaking", "E.B"],
      ["enum-member-added", "rollback-risk", "E.C"],
    ]);
  });
});

describe("compareEnums with int storage", () => {
  it("reports nothing for identical values even when members move", () => {
    expect(compare("enum E { A = 1, B = 2 }", "enum E { B = 2, A = 1 }", "int")).toEqual([]);
  });

  it("marks an added value as rollback-risk", () => {
    expect(compare("enum E { A, B }", "enum E { A, B, C }", "int")).toEqual([
      ["enum-member-added", "rollback-risk", "E.C"],
    ]);
  });

  it("marks a removed value as breaking", () => {
    expect(compare("enum E { A, B, C }", "enum E { A, B }", "int")).toEqual([
      ["enum-member-removed", "breaking", "E.C"],
    ]);
  });

  it("marks a renumbered member as breaking once, without a removal or addition for the same cause", () => {
    expect(compare("enum E { A, B, C }", "enum E { A, C, B }", "int")).toEqual([
      ["enum-member-renumbered", "breaking", "E.C"],
      ["enum-member-renumbered", "breaking", "E.B"],
    ]);
    expect(compare("enum E { A = 1, B = 2 }", "enum E { A = 1, B = 7 }", "int")).toEqual([
      ["enum-member-renumbered", "breaking", "E.B"],
    ]);
  });

  it("marks an inserted member that shifts the implicit numbers as renumbering", () => {
    expect(compare("enum E { A, B }", "enum E { A, New, B }", "int")).toEqual([
      ["enum-member-renumbered", "breaking", "E.B"],
    ]);
  });

  it("reports a member removed when its value is taken over by a renumbered member", () => {
    expect(compare("enum E { A = 0, B = 1 }", "enum E { A = 1 }", "int")).toEqual([
      ["enum-member-renumbered", "breaking", "E.A"],
      ["enum-member-removed", "breaking", "E.B"],
    ]);
  });

  it("marks a value kept under a new name as needs-action", () => {
    expect(compare("enum E { A, B }", "enum E { A, Bee }", "int")).toEqual([
      ["enum-member-renamed", "needs-action", "E.B -> E.Bee"],
    ]);
  });

  it("stays silent when an alias is added to an existing value", () => {
    expect(compare("enum E { A = 1 }", "enum E { A = 1, Legacy = A }", "int")).toEqual([]);
  });

  it("marks members with uncomputable values as needs-action only when their declaration changed", () => {
    expect(compare("enum E { A = Other.X, B }", "enum E { A = Other.X, B }", "int")).toEqual([]);
    expect(compare("enum E { A = Other.X, B }", "enum E { A = Other.Y, B }", "int")).toEqual([
      ["enum-member-unresolved", "needs-action", "E.A"],
      ["enum-member-unresolved", "needs-action", "E.B"],
    ]);
    expect(compare("enum E { A = Other.X, B }", "enum E { A = Other.X, N, B }", "int")).toEqual([
      ["enum-member-unresolved", "needs-action", "E.N"],
      ["enum-member-unresolved", "needs-action", "E.B"],
    ]);
  });

  it("carries the members of both sides for evidence", () => {
    const [change] = compareEnums({
      enumName: "E",
      storage: "int",
      base: declaration("enum E {\n A,\n B\n}"),
      revision: declaration("enum E {\n A,\n\n Bee\n}"),
    });
    expect(change?.base?.line).toBe(3);
    expect(change?.revision?.line).toBe(4);
    expect(change?.members).toEqual(["B", "Bee"]);
  });
});

describe("compareEnums with int storage and a value that becomes uncomputable", () => {
  it("reports the member once, as unresolved, not also as removed or added", () => {
    expect(compare("enum E { A = 1 }", "enum E { A = Other.X }", "int")).toEqual([
      ["enum-member-unresolved", "needs-action", "E.A"],
    ]);
    expect(compare("enum E { A = Other.X }", "enum E { A = 1 }", "int")).toEqual([
      ["enum-member-unresolved", "needs-action", "E.A"],
    ]);
  });
});

describe("compareEnums edge cases from the plan review", () => {
  it("reports a swap of two int values as two renumberings and nothing else", () => {
    expect(compare("enum E { A = 1, B = 2 }", "enum E { A = 2, B = 1 }", "int")).toEqual([
      ["enum-member-renumbered", "breaking", "E.A"],
      ["enum-member-renumbered", "breaking", "E.B"],
    ]);
  });

  it("reports a member inserted in the middle of implicit numbering as renumberings only", () => {
    expect(compare("enum E { A, B, C }", "enum E { A, X, B, C }", "int")).toEqual([
      ["enum-member-renumbered", "breaking", "E.B"],
      ["enum-member-renumbered", "breaking", "E.C"],
    ]);
  });

  it("reports an implicit member after a value that became uncomputable as unresolved, not removed", () => {
    expect(compare("enum E { A = 1, B }", "enum E { A = Consts.One, B }", "int")).toEqual([
      ["enum-member-unresolved", "needs-action", "E.A"],
      ["enum-member-unresolved", "needs-action", "E.B"],
    ]);
  });

  it("treats a TypeScript string member under int storage as unresolved", () => {
    expect(compare("enum E { A = 1 }", 'enum E { A = 1, B = "b" }', "int", "typescript")).toEqual([
      ["enum-member-unresolved", "needs-action", "E.B"],
    ]);
  });

  it("pairs string-storage renames one to one in declaration order", () => {
    expect(compare("enum E { A, B, C }", "enum E { A, Bee, Cee }", "string")).toEqual([
      ["enum-member-renamed", "breaking", "E.B -> E.Bee"],
      ["enum-member-renamed", "breaking", "E.C -> E.Cee"],
    ]);
    expect(compare("enum E { A = 1, B = 1 }", "enum E { X = 1, Y = 1, Z = 1 }", "string")).toEqual([
      ["enum-member-renamed", "breaking", "E.A -> E.X"],
      ["enum-member-renamed", "breaking", "E.B -> E.Y"],
      ["enum-member-added", "rollback-risk", "E.Z"],
    ]);
  });
});
