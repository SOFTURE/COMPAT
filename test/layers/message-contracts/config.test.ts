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
    expect(parsed.queues?.[0]).toMatchObject({ flags: "", comments: "slash", report: true });
  });

  const endpoint = { kind: "regex", name: "endpoint", files: "x", pattern: '"Name": "(.+)"', report: false };
  const group = { kind: "regex", name: "group", files: "y", pattern: '"(\\w+)"', report: false };
  const composed = (extra: object) => ({
    kind: "composed",
    name: "groups",
    template: "{endpoint}{separator}{group}",
    parts: { endpoint: "endpoint", group: "group", separator: { default: "." } },
    ...extra,
  });

  it("accepts a composed queue source over regex sources", () => {
    const parsed = messageContractsConfigSchema.parse({
      sources: [source],
      queues: [composed({}), endpoint, group],
    });
    expect(parsed.queues?.[0]).toEqual(composed({}));
    expect(parsed.queues?.[1]).toMatchObject({ report: false });
  });

  it.each([
    ["a part naming an unknown source", { parts: { endpoint: "nope", group: "group", separator: "group" } }],
    [
      "a part naming a composed source",
      { parts: { endpoint: "groups", group: "group", separator: { default: "." } } },
    ],
    ["a placeholder without a part", { parts: { endpoint: "endpoint", group: "group" } }],
    [
      "a part missing from the template",
      { template: "{endpoint}.{group}", parts: { endpoint: "endpoint", group: "group", separator: "group" } },
    ],
    ["a template without placeholders", { template: "PETSEO", parts: {} }],
    [
      "a part with neither source nor default",
      { parts: { endpoint: "endpoint", group: "group", separator: {} } },
    ],
    ["only constant parts", { template: "{a}.{b}", parts: { a: { default: "x" }, b: { default: "y" } } }],
  ])("rejects %s", (_, extra) => {
    const config = { sources: [source], queues: [endpoint, group, composed(extra)] };
    expect(messageContractsConfigSchema.safeParse(config).success).toBe(false);
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

  describe("consumers", () => {
    const consumer = (extra: object) => ({
      kind: "regex",
      name: "default",
      files: "Consumers/**/*.cs",
      pattern: "IConsumer<(?<message>\\w+)>",
      queue: "PETSEO.Worker.Sync",
      ...extra,
    });

    it("applies defaults", () => {
      const parsed = messageContractsConfigSchema.parse({ sources: [source], consumers: [consumer({})] });
      expect(parsed.consumers?.[0]).toEqual({ ...consumer({}), flags: "", comments: "slash" });
    });

    it("rejects a pattern without a message group and an exclude naming no other source", () => {
      const parsed = messageContractsConfigSchema.safeParse({
        sources: [source],
        consumers: [
          consumer({ pattern: "IConsumer<(\\w+)>" }),
          consumer({ name: "group", exclude: ["group", "missing"] }),
        ],
      });
      expect(parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        ["consumers.0.pattern", "must contain a named group (?<message>...)"],
        ["consumers.1.exclude.0", "must not name the source itself"],
        ["consumers.1.exclude.1", 'names "missing", which is not a consumer source'],
      ]);
    });

    it("accepts queueFrom with select in place of a literal queue", () => {
      const parsed = messageContractsConfigSchema.safeParse({
        sources: [source],
        queues: [endpoint, group, composed({})],
        consumers: [
          consumer({ queue: undefined, queueFrom: "endpoint" }),
          consumer({ name: "broadcast", queue: undefined, queueFrom: "groups", select: "Broadcast" }),
        ],
      });
      expect(parsed.error).toBeUndefined();
    });

    it("requires exactly one of queue and queueFrom, select only with queueFrom, and an existing queue source", () => {
      const parsed = messageContractsConfigSchema.safeParse({
        sources: [source],
        queues: [endpoint],
        consumers: [
          consumer({ name: "both", queueFrom: "endpoint" }),
          consumer({ name: "neither", queue: undefined }),
          consumer({ name: "literal-select", select: "Broadcast" }),
          consumer({ name: "missing", queue: undefined, queueFrom: "groups" }),
        ],
      });
      expect(parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        ["consumers.0.queue", "set exactly one of queue and queueFrom"],
        ["consumers.1.queue", "set exactly one of queue and queueFrom"],
        ["consumers.2.select", "needs queueFrom"],
        ["consumers.3.queueFrom", 'names "groups", which is not a queue source'],
      ]);
    });

    it("rejects queueFrom when no queue sources are declared", () => {
      const parsed = messageContractsConfigSchema.safeParse({
        sources: [source],
        consumers: [consumer({ queue: undefined, queueFrom: "endpoint" })],
      });
      expect(parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        ["consumers.0.queueFrom", 'names "endpoint", which is not a queue source'],
      ]);
    });
  });
});
