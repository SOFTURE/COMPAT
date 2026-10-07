import { describe, expect, it } from "vitest";
import type { CodeDeclaration } from "../../../src/layers/error-codes/classify.js";
import { composeCodes } from "../../../src/layers/error-codes/compose-codes.js";
import { composedCodeSourceSchema } from "../../../src/layers/error-codes/config.js";

const declare = (path: string, line: number): CodeDeclaration => ({
  source: "part",
  evidence: { side: "revision", ref: "v2", commit: "abc", path, line },
});

const source = composedCodeSourceSchema.parse({
  kind: "composed",
  name: "errors",
  template: "{module}.{entity}.NotFound",
  parts: { module: "modules", entity: "entities" },
});

describe("composeCodes", () => {
  it("builds one code per combination, with evidence from the last part in the template", () => {
    const found = new Map([
      ["modules", new Map([["Shop", declare("Shop.cs", 1)]])],
      [
        "entities",
        new Map([
          ["Cart", declare("Cart.cs", 2)],
          ["Pet", declare("Pet.cs", 3)],
        ]),
      ],
    ]);
    const composed = composeCodes(source, found);
    expect(composed.ok && [...composed.value]).toEqual([
      ["Shop.Cart.NotFound", { source: "errors", evidence: declare("Cart.cs", 2).evidence }],
      ["Shop.Pet.NotFound", { source: "errors", evidence: declare("Pet.cs", 3).evidence }],
    ]);
  });

  it("builds nothing when a part has no value and fails above the code limit", () => {
    const many = new Map(Array.from({ length: 40 }, (_, index) => [`E${index}`, declare("E.cs", index)]));
    const empty = composeCodes(source, new Map([["entities", many]]));
    expect(empty.ok && empty.value.size).toBe(0);
    const tooMany = composeCodes(
      source,
      new Map([
        ["modules", many],
        ["entities", many],
      ]),
    );
    expect(!tooMany.ok && tooMany.error).toBe("gives 1600 codes, more than 1000; narrow the part patterns");
  });
});
