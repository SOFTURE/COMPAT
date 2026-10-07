import { describe, expect, it } from "vitest";
import {
  buildContractIndex,
  type ContractIndex,
  compareContracts,
} from "../../../src/layers/message-contracts/compare-contracts.js";
import { parseContracts } from "../../../src/layers/message-contracts/parse-contracts.js";

/** One index from `path -> C# text`, all in the source `internal`. */
function index(files: Record<string, string>, storage: "string" | "int" = "string"): ContractIndex {
  const types = [];
  const enums = [];
  for (const [path, text] of Object.entries(files)) {
    const parsed = parseContracts(text);
    if (parsed.failures.length > 0) throw new Error(JSON.stringify(parsed.failures));
    types.push(...parsed.types.map((type) => ({ source: "internal", path, type })));
    enums.push(...parsed.enums.map((contract) => ({ source: "internal", path, storage, contract })));
  }
  return buildContractIndex(types, enums);
}

const compare = (base: Record<string, string>, revision: Record<string, string>) =>
  compareContracts(index(base), index(revision)).map((change) => [change.id, change.class, change.subject]);

describe("compareContracts", () => {
  it("reports nothing for identical contracts with different trivia", () => {
    expect(
      compare(
        { "a.cs": "namespace N;\npublic record A(System.Int32 X, string? Y);" },
        { "a.cs": "namespace N;\n\n// moved\npublic record A(\n  int X,\n  String? Y);" },
      ),
    ).toEqual([]);
  });

  it("classifies added and removed types", () => {
    expect(
      compare(
        { "a.cs": "namespace N; public record Old(int X);" },
        { "a.cs": "namespace N; public record Fresh(string Y);" },
      ),
    ).toEqual([
      ["message-removed", "needs-action", "N.Old"],
      ["message-added", "safe", "N.Fresh"],
    ]);
  });

  it("reports a namespace move as message-renamed, breaking, with its property changes", () => {
    expect(
      compare(
        { "a.cs": "namespace N.Old; public record Moved(Guid Id);" },
        { "b.cs": "namespace N.New; public record Moved(Guid Id, string? Note);" },
      ),
    ).toEqual([
      ["message-renamed", "breaking", "N.Old.Moved -> N.New.Moved"],
      ["message-property-added", "safe", "N.New.Moved.Note"],
    ]);
  });

  it("pairs a renamed type by its unique wire shape, never by an empty or shared one", () => {
    expect(
      compare(
        {
          "a.cs": "namespace N; public record OrderPlaced(Guid OrderId, decimal Total); public record Ping;",
        },
        {
          "a.cs": "namespace N; public record OrderCreated(Guid OrderId, decimal Total); public record Pong;",
        },
      ),
    ).toEqual([
      ["message-renamed", "breaking", "N.OrderPlaced -> N.OrderCreated"],
      ["message-removed", "needs-action", "N.Ping"],
      ["message-added", "safe", "N.Pong"],
    ]);
    expect(
      compare(
        { "a.cs": "namespace N; public record A(Guid Id); public record B(Guid Id);" },
        { "a.cs": "namespace N; public record C(Guid Id); public record D(Guid Id);" },
      ).map(([id]) => id),
    ).toEqual(["message-removed", "message-removed", "message-added", "message-added"]);
  });

  it("keeps the identity of a type with [MessageUrn] across a rename", () => {
    expect(
      compare(
        { "a.cs": 'namespace N; [MessageUrn("orders")] public record Old(int X);' },
        { "a.cs": 'namespace M; [MessageUrn("orders")] public record New(int X);' },
      ),
    ).toEqual([]);
  });

  it("classifies added properties by nullability, default and requiredness", () => {
    const changes = compare(
      { "a.cs": "namespace N; public class C { public int A { get; set; } }" },
      {
        "a.cs": [
          "namespace N; public class C {",
          "  public int A { get; set; }",
          "  public int? Nullable { get; set; }",
          "  public int Defaulted { get; set; } = 3;",
          "  public int Plain { get; set; }",
          "  public string Text { get; set; } = null!;",
          "  public required string Must { get; init; }",
          "}",
        ].join("\n"),
      },
    );
    expect(changes).toEqual([
      ["message-property-added", "safe", "N.C.Nullable"],
      ["message-property-added", "safe", "N.C.Defaulted"],
      ["message-property-added", "rollback-risk", "N.C.Plain"],
      ["message-property-added", "rollback-risk", "N.C.Text"],
      ["message-property-added", "breaking", "N.C.Must"],
    ]);
  });

  it("reports removed, retyped and nullability-changed properties, ignoring case and JSON names", () => {
    const changes = compare(
      {
        "a.cs":
          'namespace N; public class C { public int Gone { get; set; } public int Count { get; set; } public int Score { get; set; } public string Name { get; set; } [JsonPropertyName("ext")] public string Wire { get; set; } }',
      },
      {
        "a.cs":
          'namespace N; public class C { public long Count { get; set; } public int? Score { get; set; } public string NAME { get; set; } [JsonPropertyName("ext")] public string Renamed { get; set; } }',
      },
    );
    expect(changes).toEqual([
      ["message-property-removed", "breaking", "N.C.Gone"],
      ["message-property-type-changed", "breaking", "N.C.Count"],
      ["message-property-nullability-changed", "rollback-risk", "N.C.Score"],
    ]);
  });

  it("flattens base types of the sources and compares base lists and entity names", () => {
    const changes = compare(
      {
        "a.cs": [
          "namespace N;",
          "public abstract record Event(Guid EventId);",
          "public interface IAudited { string By { get; } }",
          '[EntityName("placed")] public record Placed(int X) : Event(Guid.Empty), IAudited { public string By { get; init; } = ""; }',
        ].join("\n"),
      },
      {
        "a.cs": [
          "namespace N;",
          "public abstract record Event(Guid EventId, string? Trace);",
          "public interface IAudited { string By { get; } }",
          '[EntityName("placed-v2")] public record Placed(int X) : Event(Guid.Empty, null) { public string By { get; init; } = ""; }',
        ].join("\n"),
      },
    );
    expect(changes).toEqual([
      ["message-property-added", "safe", "N.Event.Trace"],
      ["message-entity-name-changed", "breaking", "N.Placed"],
      ["message-base-removed", "breaking", "N.Placed : IAudited"],
      ["message-property-added", "safe", "N.Placed.Trace"],
    ]);
  });

  it("merges partial declarations and rejects other duplicates", () => {
    const partial = index({
      "a.cs": "namespace N; public partial class C { public int A { get; set; } }",
      "b.cs": "namespace N; public partial class C { public int B { get; set; } }",
    });
    expect(partial.failures).toEqual([]);
    expect(partial.types.get("N.C")?.type.properties.map((property) => property.name)).toEqual(["A", "B"]);
    const duplicate = index({
      "a.cs": "namespace N; public class C { }",
      "b.cs": "namespace N; public class C { }",
    });
    expect(duplicate.failures).toEqual(['"N.C" is declared more than once without partial (a.cs:1, b.cs:1)']);
  });

  it("compares enums of the sources with the persisted-enums rules", () => {
    const changes = compareContracts(
      index({ "e.cs": "namespace N; public enum Status { Active, Closed } public enum Old { A }" }),
      index({
        "e.cs": "namespace N; public enum Status { Active, Archived, Closed } public enum Fresh { A }",
      }),
    );
    expect(changes.map((change) => [change.id, change.class, change.subject])).toEqual([
      ["enum-member-added", "rollback-risk", "N.Status.Archived"],
      ["enum-removed", "needs-action", "N.Old"],
      ["enum-added", "safe", "N.Fresh"],
    ]);
    expect(changes[0]?.message).toContain("string serialization: ");
    expect(changes[0]?.message).not.toContain("row");
  });
});
