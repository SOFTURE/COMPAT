import { describe, expect, it } from "vitest";
import { messageContractsConfigSchema } from "../../../src/layers/message-contracts/config.js";

const source = { name: "internal", language: "csharp", files: "src/**/*.cs" };

describe("message-contracts config", () => {
  it("applies defaults", () => {
    const parsed = messageContractsConfigSchema.parse({
      sources: [source],
      queues: [{ kind: "regex", name: "q", files: "**/Queues.cs", pattern: '"(PETSEO\\.[\\w.]+)"' }],
    });
    expect(parsed.sources[0]?.enumStorage).toBe("string");
    expect(parsed.queues?.[0]).toMatchObject({ flags: "", comments: "slash" });
  });

  it.each([
    ["no source", { sources: [] }],
    ["a duplicate source name", { sources: [source, source] }],
    ["an unknown language", { sources: [{ ...source, language: "java" }] }],
    ["an unknown key", { sources: [{ ...source, typo: 1 }] }],
    [
      "a queue pattern without a group",
      { sources: [source], queues: [{ kind: "regex", name: "q", files: "x", pattern: "PETSEO" }] },
    ],
    [
      "an invalid queue pattern",
      { sources: [source], queues: [{ kind: "regex", name: "q", files: "x", pattern: "(" }] },
    ],
    [
      "a global flag",
      { sources: [source], queues: [{ kind: "regex", name: "q", files: "x", pattern: "(a)", flags: "g" }] },
    ],
    [
      "an accept entry with an unknown id",
      { sources: [source], accept: [{ id: "nope", subject: "x", reason: "y" }] },
    ],
  ])("rejects %s", (_, config) => {
    expect(messageContractsConfigSchema.safeParse(config).success).toBe(false);
  });

  it("accepts persisted-enums ids in accept entries", () => {
    const config = {
      sources: [source],
      accept: [{ id: "enum-member-added", subject: "N.Status.New", reason: "r" }],
    };
    expect(messageContractsConfigSchema.safeParse(config).success).toBe(true);
  });
});
