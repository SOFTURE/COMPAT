import { describe, expect, it } from "vitest";
import {
  composeQueueParts,
  composeQueues,
  MAX_COMPOSED_QUEUES,
  type QueueNames,
} from "../../../src/layers/message-contracts/compose-queues.js";
import type { ComposedQueueSource } from "../../../src/layers/message-contracts/config.js";

const ENDPOINT = { path: "appsettings.json", line: 3 };
const BROADCAST = { path: "ConsumerGroups.cs", line: 5 };
const SYNC = { path: "ConsumerGroups.cs", line: 6 };

const source: ComposedQueueSource = {
  kind: "composed",
  name: "groups",
  template: "{endpoint}{separator}{group}",
  parts: { endpoint: "endpoint", group: "group", separator: { source: "separator", default: "." } },
};

const found = (entries: Record<string, QueueNames>) => new Map(Object.entries(entries));

describe("composeQueues", () => {
  it("builds one name per combination and falls back to the default when the part source finds nothing", () => {
    const composed = composeQueues(
      source,
      found({
        endpoint: new Map([["PETSEO.Worker.Sync", ENDPOINT]]),
        group: new Map([
          ["Broadcast", BROADCAST],
          ["Sync", SYNC],
        ]),
        separator: new Map(),
      }),
    );
    expect(composed).toEqual({
      ok: true,
      value: new Map([
        ["PETSEO.Worker.Sync.Broadcast", BROADCAST],
        ["PETSEO.Worker.Sync.Sync", SYNC],
      ]),
    });
  });

  it("uses the value the part source finds over the default", () => {
    const composed = composeQueues(
      source,
      found({
        endpoint: new Map([["PETSEO.Worker.Sync", ENDPOINT]]),
        group: new Map([["Broadcast", BROADCAST]]),
        separator: new Map([["-", { path: "appsettings.json", line: 4 }]]),
      }),
    );
    expect(composed.ok && [...composed.value.keys()]).toEqual(["PETSEO.Worker.Sync-Broadcast"]);
  });

  it("takes the site of the last part read from a source, and none when every part is a default", () => {
    const groupFirst: ComposedQueueSource = {
      ...source,
      template: "{group}{separator}{endpoint}",
      parts: {
        group: "group",
        endpoint: { source: "endpoint", default: "PETSEO" },
        separator: { default: "." },
      },
    };
    const withEndpoint = composeQueues(
      groupFirst,
      found({ group: new Map([["Broadcast", BROADCAST]]), endpoint: new Map([["Worker", ENDPOINT]]) }),
    );
    expect(withEndpoint).toEqual({ ok: true, value: new Map([["Broadcast.Worker", ENDPOINT]]) });
    const onlyDefaults = composeQueues(
      { ...groupFirst, parts: { ...groupFirst.parts, group: { source: "group", default: "All" } } },
      found({}),
    );
    expect(onlyDefaults).toEqual({ ok: true, value: new Map([["All.PETSEO", undefined]]) });
  });

  it("gives no name when a part has no value and no default", () => {
    const composed = composeQueues(
      source,
      found({ endpoint: new Map(), group: new Map([["Broadcast", BROADCAST]]) }),
    );
    expect(composed).toEqual({ ok: true, value: new Map() });
  });

  it("deduplicates names and reuses a placeholder that appears twice", () => {
    const twice: ComposedQueueSource = {
      kind: "composed",
      name: "twice",
      template: "{a}.{b}.{a}",
      parts: { a: "a", b: { default: "x" } },
    };
    const composed = composeQueues(twice, found({ a: new Map([["q", BROADCAST]]) }));
    expect(composed).toEqual({ ok: true, value: new Map([["q.x.q", BROADCAST]]) });
  });

  it(`fails above ${MAX_COMPOSED_QUEUES} combinations`, () => {
    const many = (prefix: string) =>
      new Map(Array.from({ length: 40 }, (_, index) => [`${prefix}${index}`, BROADCAST] as const));
    const composed = composeQueues(source, found({ endpoint: many("e"), group: many("g") }));
    expect(composed).toEqual({
      ok: false,
      error: `gives 1600 queue names, more than ${MAX_COMPOSED_QUEUES}; narrow the part patterns`,
    });
  });
});

describe("composeQueueParts", () => {
  it("keeps the value of every part of each name in template order", () => {
    const composed = composeQueueParts(
      source,
      found({
        endpoint: new Map([["PETSEO.Worker.Sync", ENDPOINT]]),
        group: new Map([
          ["Broadcast", BROADCAST],
          ["Sync", SYNC],
        ]),
        separator: new Map(),
      }),
    );
    expect(composed).toEqual({
      ok: true,
      value: new Map([
        [
          "PETSEO.Worker.Sync.Broadcast",
          { site: BROADCAST, parts: ["PETSEO.Worker.Sync", ".", "Broadcast"] },
        ],
        ["PETSEO.Worker.Sync.Sync", { site: SYNC, parts: ["PETSEO.Worker.Sync", ".", "Sync"] }],
      ]),
    });
  });
});
