import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/config/config.js";
import { persistedEnumsConfigSchema } from "../../../src/layers/persisted-enums/config.js";
import { persistedEnumsLayer } from "../../../src/layers/persisted-enums/persisted-enums-layer.js";
import { LAYERS } from "../../../src/layers/registry.js";

const named = { kind: "named", name: "NotificationType", storage: "string" };
const discover = {
  kind: "discover",
  files: "src/**/*DbContext.cs",
  pattern: "ConfigureEnum<(\\w+)>",
  storage: "string",
};

function issues(config: unknown): string[] {
  const parsed = persistedEnumsConfigSchema.safeParse(config);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

describe("persisted-enums config", () => {
  it("accepts named and discover entries with an accept list", () => {
    expect(
      issues({
        sources: ["src/**/*.cs", "web/**/*.ts"],
        enums: [named, { ...named, name: "Level", storage: "int", file: "src/Level.cs" }, discover],
        accept: [
          { id: "enum-member-added", enum: "NotificationType", member: "TermsChange", reason: "reviewed" },
        ],
      }),
    ).toEqual([]);
  });

  it("accepts exposed fields on a named entry and accepts the exposed finding id", () => {
    expect(
      issues({
        sources: "src/**/*.cs",
        enums: [{ ...named, exposed: [{ api: "b2c", fields: ["NotificationDto.type", "Inbox.Item.kind"] }] }],
        accept: [{ id: "enum-member-exposed-added", enum: "NotificationType", reason: "clients ignore it" }],
      }),
    ).toEqual([]);
  });

  it("rejects exposed fields that are not Type.property, empty lists and exposure on discover entries", () => {
    expect(
      issues({ sources: "a", enums: [{ ...named, exposed: [{ api: "b2c", fields: ["type"] }] }] }),
    ).toEqual(["enums.0.exposed.0.fields.0: must be Type.property, for example NotificationDto.type"]);
    expect(
      issues({ sources: "a", enums: [{ ...named, exposed: [{ api: "b2c", fields: [] }] }] }),
    ).toHaveLength(1);
    expect(issues({ sources: "a", enums: [{ ...named, exposed: [] }] })).toHaveLength(1);
    expect(
      issues({ sources: "a", enums: [{ ...discover, exposed: [{ api: "b2c", fields: ["A.b"] }] }] }),
    ).toHaveLength(1);
  });

  it("rejects an unknown key, also inside an entry", () => {
    expect(issues({ sources: "src/**/*.cs", enums: [named], extra: true })).toEqual([
      ': Unrecognized key: "extra"',
    ]);
    expect(issues({ sources: "src/**/*.cs", enums: [{ ...named, storge: "int" }] })).toEqual([
      'enums.0: Unrecognized key: "storge"',
    ]);
  });

  it("rejects a discovery pattern without a capture group or that does not compile", () => {
    expect(issues({ sources: "x", enums: [{ ...discover, pattern: "ConfigureEnum<\\w+>" }] })).toEqual([
      "enums.0.pattern: must have a capture group for the enum name",
    ]);
    const invalid = issues({ sources: "x", enums: [{ ...discover, pattern: "ConfigureEnum<(\\w+>" }] });
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatch(/^enums\.0\.pattern: is not a valid regular expression: /);
  });

  it("accepts a named capture group without other groups", () => {
    expect(
      issues({ sources: "x", enums: [{ ...discover, pattern: "ConfigureEnum<(?<name>\\w+)>" }] }),
    ).toEqual([]);
  });

  it("rejects duplicate named entries, an empty list, an absolute file and an unknown storage", () => {
    expect(issues({ sources: "x", enums: [named, named] })).toEqual(["enums: named enums must be unique"]);
    expect(issues({ sources: "x", enums: [] })).toEqual([
      "enums: Too small: expected array to have >=1 items",
    ]);
    expect(issues({ sources: "x", enums: [{ ...named, file: "/etc/passwd" }] })).toEqual([
      "enums.0.file: must be a relative path",
    ]);
    expect(issues({ sources: "x", enums: [{ ...named, storage: "text" }] })).toEqual([
      'enums.0.storage: Invalid option: expected one of "string"|"int"',
    ]);
  });

  it("is registered in the layer list and composes into the config file schema", () => {
    expect(LAYERS.map((layer) => layer.name)).toContain("persisted-enums");
    const parsed = parseConfig(
      { layers: { "persisted-enums": { sources: "src/**/*.cs", enums: [named] } } },
      LAYERS,
      "compat.config.json",
    );
    expect(parsed.ok && parsed.value.layers.map(({ layer }) => layer)).toEqual([persistedEnumsLayer]);
  });
});
