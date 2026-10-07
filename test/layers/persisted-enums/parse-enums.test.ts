import { describe, expect, it } from "vitest";
import { type EnumDeclaration, parseEnums } from "../../../src/layers/persisted-enums/parse-enums.js";

function parse(text: string, language: "csharp" | "typescript"): EnumDeclaration[] {
  const result = parseEnums(text, language);
  if (result.failures.length > 0) throw new Error(JSON.stringify(result.failures));
  return result.declarations;
}

const summary = (declaration: EnumDeclaration | undefined) =>
  declaration?.members.map((member) => [member.name, member.value === null ? null : String(member.value)]);

describe("parseEnums for C#", () => {
  it("parses attributes, comments, a base type, explicit values and implicit numbering", () => {
    const text = [
      "namespace Petseo.Domain;", // 1
      "", // 2
      "/// <summary>Kinds of notifications.</summary>", // 3
      '[Flags, Description("a, {b}")]', // 4
      "public enum NotificationType : byte", // 5
      "{", // 6
      "    // first", // 7
      '    [Display(Name = "News, weekly")] Newsletter = 1,', // 8
      "    /* block, with comma */ Reminder,", // 9
      "    @Event = 0x10,", // 10
      "    Mixed = Newsletter | Event,", // 11
      "    Shifted = 1 << 6,", // 12
      "    Big = 0b1000_0000,", // 13
      "}", // 14
    ].join("\n");
    const [declaration] = parse(text, "csharp");
    expect(declaration?.name).toBe("NotificationType");
    expect(declaration?.line).toBe(5);
    expect(summary(declaration)).toEqual([
      ["Newsletter", "1"],
      ["Reminder", "2"],
      ["Event", "16"],
      ["Mixed", "17"],
      ["Shifted", "64"],
      ["Big", "128"],
    ]);
    expect(declaration?.members.map((member) => member.line)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(declaration?.members[0]?.valueText).toBe("1");
    expect(declaration?.members[1]?.valueText).toBeNull();
  });

  it("resolves aliases, forward references, negative values and suffixes", () => {
    const [declaration] = parse(
      "enum Level : long { Low = -2, Mid, Alias = High, High = 5L, Top = (High + 1) * 2, Max = 0xFFu }",
      "csharp",
    );
    expect(summary(declaration)).toEqual([
      ["Low", "-2"],
      ["Mid", "-1"],
      ["Alias", "5"],
      ["High", "5"],
      ["Top", "12"],
      ["Max", "255"],
    ]);
  });

  it("leaves cycles and outside references unknown, and numbers after them unknown", () => {
    const [declaration] = parse(
      "enum E { A = B, B = A, C = Other.Value, D, F = 3, G = E.F + 1, H = (int)Other }",
      "csharp",
    );
    expect(summary(declaration)).toEqual([
      ["A", null],
      ["B", null],
      ["C", null],
      ["D", null],
      ["F", "3"],
      ["G", "4"],
      ["H", null],
    ]);
  });

  it("finds several enums, nested ones, and ignores the word enum in strings and comments", () => {
    const text = `
      // enum Fake { X }
      class Outer {
        const string S = "enum AlsoFake { Y }";
        public enum Inner { One, Two }
      }
      internal enum Second
      {
      }
      enum Third { Only, }`;
    const declarations = parse(text, "csharp");
    expect(declarations.map((declaration) => declaration.name)).toEqual(["Inner", "Second", "Third"]);
    expect(summary(declarations[0])).toEqual([
      ["One", "0"],
      ["Two", "1"],
    ]);
    expect(declarations[1]?.members).toEqual([]);
    expect(summary(declarations[2])).toEqual([["Only", "0"]]);
  });

  it("reads verbatim, raw and char literals inside attributes as single tokens", () => {
    const text = [
      'enum Quoted { [A(@"x "" } , y")] One, [B("""raw } , text""")] Two, [C(\'}\')] Three }',
    ].join("\n");
    const [declaration] = parse(text, "csharp");
    expect(summary(declaration)).toEqual([
      ["One", "0"],
      ["Two", "1"],
      ["Three", "2"],
    ]);
  });

  it("fails on an enum body that is not closed", () => {
    const result = parseEnums("namespace X;\nenum Fine { A }\npublic enum Broken {\n  A,\n  B\n", "csharp");
    expect(result.declarations.map((declaration) => declaration.name)).toEqual(["Fine"]);
    expect(result.failures).toEqual([
      { name: "Broken", line: 3, error: 'enum "Broken" at line 3 has no closing brace' },
    ]);
  });
});

describe("parseEnums for TypeScript", () => {
  it("parses export const enum, declare enum, string and mixed enums", () => {
    const text = `
      export const enum Status { Draft, Published = 5, Archived }
      declare enum Ambient { A = 1 }
      export enum Kind { Cat = "cat", 'Big Dog' = 'big-dog', Tpl = \`tpl\` }
      enum Mixed { No = 0, Yes = "YES", After }
    `;
    const declarations = parse(text, "typescript");
    expect(declarations.map((declaration) => declaration.name)).toEqual([
      "Status",
      "Ambient",
      "Kind",
      "Mixed",
    ]);
    expect(summary(declarations[0])).toEqual([
      ["Draft", "0"],
      ["Published", "5"],
      ["Archived", "6"],
    ]);
    expect(declarations[2]?.members.map((member) => [member.name, member.stringValue])).toEqual([
      ["Cat", "cat"],
      ["Big Dog", "big-dog"],
      ["Tpl", "tpl"],
    ]);
    expect(declarations[3]?.members.map((member) => [member.name, member.value, member.stringValue])).toEqual(
      [
        ["No", 0n, null],
        ["Yes", null, "YES"],
        ["After", null, null],
      ],
    );
  });

  it("supports octal literals and comments between members", () => {
    const [declaration] = parse(
      "enum Perm { /* none */ None = 0o0, Read = 0o4, // r\n Write = 2 }",
      "typescript",
    );
    expect(summary(declaration)).toEqual([
      ["None", "0"],
      ["Read", "4"],
      ["Write", "2"],
    ]);
  });

  it("does not treat a property named enum as a declaration", () => {
    const declarations = parse(
      "const x = { enum: 1 }; type T = typeof x.enum; enum Real { A }",
      "typescript",
    );
    expect(declarations.map((declaration) => declaration.name)).toEqual(["Real"]);
  });
});

describe("parseEnums robustness", () => {
  it("drops #region and #pragma lines inside a C# enum", () => {
    const text = [
      "enum E",
      "{",
      "    #region Legacy",
      "    A = 1,",
      "    #endregion",
      "#pragma warning disable CS0618",
      "    B,",
      "}",
    ].join("\n");
    expect(summary(parse(text, "csharp")[0])).toEqual([
      ["A", "1"],
      ["B", "2"],
    ]);
  });

  it("fails an enum with conditional members instead of guessing a branch", () => {
    const text = ["enum E", "{", "    A,", "#if DEBUG", "    B,", "#endif", "    C,", "}"].join("\n");
    expect(parseEnums(`${text}\nenum After { X }`, "csharp")).toEqual({
      declarations: [expect.objectContaining({ name: "After" })],
      failures: [
        {
          name: "E",
          line: 1,
          error: 'enum "E" at line 1 has a #if at line 4; conditional members cannot be compared',
        },
      ],
    });
  });

  it("fails a member it cannot read instead of skipping it", () => {
    const errors = (text: string, language: "csharp" | "typescript") =>
      parseEnums(text, language).failures.map((failure) => failure.error);
    expect(errors("enum E {\n A,\n = 3,\n B }", "csharp")).toEqual([
      'enum "E" at line 1 has an unreadable member 2 at line 3',
    ]);
    expect(errors("enum E { A =, B }", "csharp")).toEqual([
      'enum "E" at line 1 has an unreadable member 1 at line 1',
    ]);
    expect(errors("enum E { A,, B }", "typescript")).toEqual([
      'enum "E" at line 1 has an unreadable member 2 at line 1',
    ]);
  });

  it("treats a shift or a product beyond 64 bits as unknown instead of throwing", () => {
    const [declaration] = parse(
      "enum E { A = 1 << 10000000000, B = 1 << 63, C = 0x7FFFFFFFFFFFFFFF * 4 }",
      "csharp",
    );
    expect(summary(declaration)).toEqual([
      ["A", null],
      ["B", "9223372036854775808"],
      ["C", null],
    ]);
  });
});

describe("parseEnums with literals that hide comment or string openers (impl review F1, F3)", () => {
  it("reads C# interpolated raw strings and multi-line verbatim strings as one token", () => {
    const text = [
      'var sql = $"""',
      "    SELECT * /* not a comment */ FROM t",
      '    """;',
      'var glob = @"',
      '    files/*.cs";',
      'var plain = $$"""{{x}} " """;',
      "enum After { A, B }",
    ].join("\n");
    expect(summary(parse(text, "csharp")[0])).toEqual([
      ["A", "0"],
      ["B", "1"],
    ]);
  });

  it("skips TypeScript regular expression literals that contain comment openers or quotes", () => {
    const text = [
      'const trimmed = p.replace(/\\/*$/, "");',
      "const any = /[/*]/.test(p);",
      'const quote = /"/g;',
      "const ratio = total / 2 / 3;",
      "enum After { A, B }",
    ].join("\n");
    expect(summary(parse(text, "typescript")[0])).toEqual([
      ["A", "0"],
      ["B", "1"],
    ]);
  });

  it("evaluates C# char initializers to their code unit and never as a string value", () => {
    const [declaration] = parse(
      "enum Gender { Male = 'M', Female = 'F', Tab = '\\t', Quote = '\\'' }",
      "csharp",
    );
    expect(declaration?.members.map((member) => [member.name, member.value, member.stringValue])).toEqual([
      ["Male", 77n, null],
      ["Female", 70n, null],
      ["Tab", 9n, null],
      ["Quote", 39n, null],
    ]);
  });

  it("treats a string initializer in C# as unknown", () => {
    expect(summary(parse('enum E { A = "a" }', "csharp")[0])).toEqual([["A", null]]);
  });
});
