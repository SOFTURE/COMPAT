import { describe, expect, it } from "vitest";
import type { ConsumerSource } from "../../../src/layers/message-contracts/config.js";
import { resolveConsumerQueue } from "../../../src/layers/message-contracts/consumers.js";

const consumer = (extra: Partial<ConsumerSource>): ConsumerSource => ({
  kind: "regex",
  name: "broadcast-group",
  files: "Consumers/**/*.cs",
  pattern: "IConsumer<(?<message>\\w+)>",
  flags: "",
  comments: "slash",
  ...extra,
});

const QUEUES = new Map([
  ["rabbit-endpoint", new Map([["PETSEO.Worker.Sync", ["PETSEO.Worker.Sync"]]])],
  [
    "group-queues",
    new Map([
      ["PETSEO.Worker.Sync.Broadcast", ["PETSEO.Worker.Sync", ".", "Broadcast"]],
      ["PETSEO.Worker.Sync.Audit", ["PETSEO.Worker.Sync", ".", "Audit"]],
    ]),
  ],
  ["empty", new Map()],
]);

describe("resolveConsumerQueue", () => {
  it("returns a literal queue as it is", () => {
    expect(resolveConsumerQueue(consumer({ queue: "Literal" }), QUEUES, "2.4.0")).toEqual({
      ok: true,
      value: "Literal",
    });
  });

  it("returns the one name a regex source gives", () => {
    expect(resolveConsumerQueue(consumer({ queueFrom: "rabbit-endpoint" }), QUEUES, "2.4.0")).toEqual({
      ok: true,
      value: "PETSEO.Worker.Sync",
    });
  });

  it("returns the composed name with a part value equal to select", () => {
    const resolved = resolveConsumerQueue(
      consumer({ queueFrom: "group-queues", select: "Broadcast" }),
      QUEUES,
      "2.4.0",
    );
    expect(resolved).toEqual({ ok: true, value: "PETSEO.Worker.Sync.Broadcast" });
  });

  it("does not match select against a part of a value", () => {
    const resolved = resolveConsumerQueue(
      consumer({ queueFrom: "group-queues", select: "cast" }),
      QUEUES,
      "2.4.0",
    );
    expect(resolved).toEqual({
      ok: false,
      error:
        'consumer source "broadcast-group": queue source "group-queues" with select "cast" gives no queue name at 2.4.0',
    });
  });

  it("fails when the source gives several names", () => {
    expect(resolveConsumerQueue(consumer({ queueFrom: "group-queues" }), QUEUES, "2.4.0")).toEqual({
      ok: false,
      error:
        'consumer source "broadcast-group": queue source "group-queues" gives 2 queue names at 2.4.0 ' +
        "(PETSEO.Worker.Sync.Broadcast, PETSEO.Worker.Sync.Audit); set select to pick one",
    });
  });

  it("fails when the source gives no name", () => {
    expect(resolveConsumerQueue(consumer({ queueFrom: "empty" }), QUEUES, "2.4.0")).toEqual({
      ok: false,
      error: 'consumer source "broadcast-group": queue source "empty" gives no queue name at 2.4.0',
    });
  });

  it("fails when the source itself failed", () => {
    expect(resolveConsumerQueue(consumer({ queueFrom: "missing" }), QUEUES, "2.4.0")).toEqual({
      ok: false,
      error: 'consumer source "broadcast-group" is skipped: queue source "missing" failed',
    });
  });
});
