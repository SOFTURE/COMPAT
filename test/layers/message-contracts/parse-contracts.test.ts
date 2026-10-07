import { describe, expect, it } from "vitest";
import {
  type ContractType,
  type ParsedContracts,
  parseContracts,
} from "../../../src/layers/message-contracts/parse-contracts.js";

function parseClean(text: string): ParsedContracts {
  const result = parseContracts(text);
  if (result.failures.length > 0) throw new Error(JSON.stringify(result.failures));
  return result;
}

const byName = (result: ParsedContracts, fullName: string): ContractType | undefined =>
  result.types.find((type) => type.fullName === fullName);

const shape = (type: ContractType | undefined) =>
  type?.properties.map((property) => [
    property.wireName,
    property.type,
    property.hasDefault,
    property.isRequired,
  ]);

describe("parseContracts", () => {
  it("reads a record with positional parameters and body properties under a file-scoped namespace", () => {
    const text = [
      "using System;", // 1
      '[assembly: InternalsVisibleTo("Tests")]', // 2
      "namespace PETSEO.Contract.Messages;", // 3
      "", // 4
      "/// <summary>Sent when a broadcast starts.</summary>", // 5
      "public sealed record BroadcastStarted(", // 6
      "    Guid BroadcastId,", // 7
      '    [property: JsonPropertyName("n")] string Name,', // 8
      "    int Count = 0) : IBroadcastMessage", // 9
      "{", // 10
      "    public required string Title { get; init; }", // 11
      "    public string? Note { get; set; } = null!;", // 12
      "    public List<Dictionary<string, List<int>>> Items { get; set; } = new();", // 13
      "}", // 14
    ].join("\n");
    const result = parseClean(text);
    const type = byName(result, "PETSEO.Contract.Messages.BroadcastStarted");
    expect(type).toMatchObject({
      kind: "record",
      line: 6,
      simpleName: "BroadcastStarted",
      baseTypes: ["IBroadcastMessage"],
    });
    expect(shape(type)).toEqual([
      ["BroadcastId", "Guid", false, false],
      ["n", "string", false, false],
      ["Count", "int", true, false],
      ["Title", "string", false, true],
      ["Note", "string?", false, false],
      ["Items", "List<Dictionary<string, List<int>>>", true, false],
    ]);
    expect(type?.properties.map((property) => property.line)).toEqual([7, 8, 9, 11, 12, 13]);
  });

  it("skips members that never travel and non-public or static types", () => {
    const text = [
      "namespace N {",
      "  public class Order",
      "  {",
      '    public const string Topic = "orders";',
      "    public static int Counter { get; set; }",
      "    public int Field;",
      "    public readonly int Other = 1, Third = 2;",
      "    private int Hidden { get; set; }",
      "    internal int AlsoHidden { get; set; }",
      "    public int Computed => Field * 2;",
      "    public int WriteOnly { set { } }",
      "    [JsonIgnore] public int Ignored { get; set; }",
      "    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Kept { get; set; }",
      "    public Order() : this(1) { }",
      "    public Order(int id) { Field = id; }",
      "    ~Order() { }",
      "    public int this[int index] => index;",
      "    public event EventHandler? Changed;",
      "    public static implicit operator int(Order order) => order.Field;",
      "    public static Order operator +(Order a, Order b) => a;",
      "    public T Get<T>() where T : new() => new T();",
      "    public void Do() { if (Field > 0) { Field--; } }",
      "    int IComparable.CompareTo(object? other) => 0;",
      "    public delegate void Handler(int x);",
      "    public int Value { get => Field; set { Field = value; } }",
      "  }",
      '  public static class Queues { public const string Q = "q"; }',
      "  internal record Internal(int X);",
      "  class Implicit { public int X { get; set; } }",
      "}",
    ].join("\n");
    const result = parseClean(text);
    expect(result.types.map((type) => type.fullName)).toEqual(["N.Order"]);
    expect(shape(byName(result, "N.Order"))).toEqual([
      ["Kept", "string?", false, false],
      ["Value", "int", false, false],
    ]);
  });

  it("names nested and generic types like a MassTransit URN and reads interfaces and record structs", () => {
    const text = [
      "namespace A.B",
      "{",
      "    public interface IEnvelope<T> where T : class { T Payload { get; } Guid Id { get; } void Ack(); }",
      "    public static class Messages",
      "    {",
      "        public record struct Point(int X, int Y);",
      "        public record class Moved(Point From, Point To);",
      "        public class Outer { public class Inner<TKey, TValue> { public TKey Key { get; set; } } }",
      "        private class Secret { public class NotPublic { public int X { get; set; } } }",
      "    }",
      "}",
    ].join("\n");
    const result = parseClean(text);
    const types = [...result.types].sort((a, b) => (a.fullName < b.fullName ? -1 : 1));
    expect(types.map((type) => [type.fullName, type.kind])).toEqual([
      ["A.B.IEnvelope`1", "interface"],
      ["A.B.Messages+Moved", "record"],
      ["A.B.Messages+Outer", "class"],
      ["A.B.Messages+Outer+Inner`2", "class"],
      ["A.B.Messages+Point", "record struct"],
    ]);
    expect(shape(byName(result, "A.B.IEnvelope`1"))).toEqual([
      ["Payload", "T", false, false],
      ["Id", "Guid", false, false],
    ]);
  });

  it("normalizes type text", () => {
    const text = [
      "namespace N;",
      "public class C",
      "{",
      "    public System.String A { get; set; }",
      "    public global::System.Collections.Generic.List<System.Int32> B { get; set; }",
      "    public Nullable<System.Guid> C1 { get; set; }",
      "    public (int Left, string Right) D { get; set; }",
      "    public My.Domain.Money E { get; set; }",
      "    public int[,][] F { get; set; }",
      "    public  Dictionary < string ,  int ? > G { get; set; }",
      "}",
    ].join("\n");
    expect(shape(byName(parseClean(text), "N.C"))?.map((entry) => entry[1])).toEqual([
      "string",
      "List<int>",
      "Guid?",
      "(int Left, string Right)",
      "My.Domain.Money",
      "int[,][]",
      "Dictionary<string, int?>",
    ]);
  });

  it("does not count compiler-silencing initializers as defaults and reads [JsonRequired]", () => {
    const text = [
      "namespace N;",
      "public class C",
      "{",
      "    public string A { get; set; } = null!;",
      "    public int B { get; set; } = default;",
      "    public int C1 { get; set; } = default!;",
      "    public Guid D { get; set; } = default(Guid);",
      '    public string E { get; set; } = "";',
      "    public int F { get; set; } = default + 1;",
      "    [JsonRequired] public int G { get; set; }",
      "}",
      "public record R(string X = null!, int Y = 3, [property: JsonRequired] int Z = 0);",
    ].join("\n");
    const result = parseClean(text);
    expect(shape(byName(result, "N.C"))?.map((entry) => [entry[0], entry[2], entry[3]])).toEqual([
      ["A", false, false],
      ["B", false, false],
      ["C1", false, false],
      ["D", false, false],
      ["E", true, false],
      ["F", true, false],
      ["G", false, true],
    ]);
    expect(shape(byName(result, "N.R"))?.map((entry) => [entry[0], entry[2], entry[3]])).toEqual([
      ["X", false, false],
      ["Y", true, false],
      ["Z", true, true],
    ]);
  });

  it("reads [MessageUrn], [EntityName] and partial types", () => {
    const text = [
      "namespace N;",
      '[MessageUrn("orders:placed")]',
      '[EntityName("orders-placed")]',
      "public partial record OrderPlaced(Guid Id);",
    ].join("\n");
    const [type] = parseClean(text).types;
    expect(type).toMatchObject({ urn: "orders:placed", entityName: "orders-placed", isPartial: true });
  });

  it("keeps parsing after every C# literal form", () => {
    const text = [
      "namespace N;",
      "public class Literals",
      "{",
      '    public string A { get; set; } = "a } { ; \\" b";',
      '    public string B { get; set; } = @"multi',
      '      line } with "" quotes /* not a comment";',
      '    public string C { get; set; } = $"{A} }} {{ {(B.Length > 0 ? "x" : "y")}";',
      '    public string D { get; set; } = $$"""',
      '      raw { } "" and {{A}} and } {',
      '      """;',
      "    public char E { get; set; } = '}';",
      "    public char F { get; set; } = '\\'';",
      "    public char G { get; set; } = '\"';",
      "    // public int Commented { get; set; }",
      "    /* public int Block { get; set; } */",
      '    public string H { get; set; } = @$"{A}\\";',
      "    public int I { get; set; }",
      "}",
      "public record After(int X);",
    ].join("\n");
    const result = parseClean(text);
    expect(byName(result, "N.Literals")?.properties.map((property) => property.name)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
    ]);
    expect(byName(result, "N.After")).toBeDefined();
  });

  it("returns public enums with their full names", () => {
    const text = [
      "namespace N;",
      "public enum Status { Active, Closed = 4 }",
      "internal enum Hidden { A }",
      "public class Holder { public enum Kind : byte { A, B } }",
    ].join("\n");
    const result = parseClean(text);
    expect(
      result.enums.map((entry) => [entry.fullName, entry.declaration.members.map((m) => m.name)]),
    ).toEqual([
      ["N.Status", ["Active", "Closed"]],
      ["N.Holder+Kind", ["A", "B"]],
    ]);
  });

  describe("failures", () => {
    const failuresOf = (text: string) => parseContracts(text).failures.map((failure) => failure.error);

    it("fails a type with a conditional directive in its body and keeps the others", () => {
      const result = parseContracts(
        [
          "namespace N;",
          "public class A",
          "{",
          "#if DEBUG",
          "    public int X { get; set; }",
          "#endif",
          "}",
          "public record B(int Y);",
        ].join("\n"),
      );
      expect(result.failures.map((failure) => failure.name)).toEqual(["N.A"]);
      expect(result.failures[0]?.error).toContain("#if at line 4");
      expect(result.types.map((type) => type.fullName)).toEqual(["N.B"]);
    });

    it("fails an unrecognised public member", () => {
      expect(failuresOf("namespace N; public class A { public 42 Weird; }")).toEqual([
        expect.stringContaining('"N.A" at line 1 has an unreadable member'),
      ]);
    });

    it("fails a [JsonPropertyName] or [MessageUrn] without a string literal", () => {
      expect(failuresOf("public class A { [JsonPropertyName(Names.X)] public int X { get; set; } }")).toEqual(
        [expect.stringContaining("[JsonPropertyName] without a string literal")],
      );
      expect(failuresOf("[MessageUrn(Urns.A)] public record A(int X);")).toEqual([
        expect.stringContaining("[MessageUrn] without a string literal"),
      ]);
    });

    it("fails an unclosed body and every declaration after it", () => {
      const failures = failuresOf(
        "namespace N;\npublic class A {\n public int X { get; set; }\npublic record B(int Y);\n",
      );
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.join(" ")).toMatch(/unbalanced brackets|no closing brace/);
    });

    it("fails an unreadable enum", () => {
      expect(failuresOf("public enum E\n{\n#if DEBUG\n  A,\n#endif\n}")).toEqual([
        expect.stringContaining('enum "E"'),
      ]);
    });

    it("flags a declaration line the parser did not reach", () => {
      // An unterminated raw string swallows the rest of the file.
      const result = parseContracts(
        'public class A { public string S { get; } = """ ; }\npublic record Lost(int X);\n',
      );
      expect(result.failures.map((failure) => failure.name)).toContain("Lost");
    });
  });
});
