import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const MESSAGES = "Contracts/Messages.cs";
const CONSUMERS = "Worker/Consumers";

const contracts = (...extra: string[]) =>
  [
    "namespace PETSEO.Contract.Internal.Messages;",
    "",
    "public sealed record OrderPlaced(Guid OrderId);",
    "public sealed record OrderShipped(Guid OrderId);",
    "public sealed record InvoiceIssued(Guid InvoiceId);",
    "public sealed record OrderCancelled(Guid OrderId);",
    ...extra,
  ].join("\n");

const consumer = (message: string) =>
  [
    "namespace PETSEO.Worker.Sync.Consumers;",
    "",
    `public sealed class ${message}Consumer : IConsumer<${message}>`,
    "{",
    `    public Task Consume(ConsumeContext<${message}> context) => Task.CompletedTask;`,
    "}",
  ].join("\n");

const LAYER = {
  sources: [{ name: "internal", language: "csharp", files: "Contracts/**/*.cs" }],
  consumers: [
    {
      kind: "regex",
      name: "broadcast-group",
      files: `${CONSUMERS}/Broadcast/*.cs`,
      pattern: "IConsumer<(?<message>[\\w.]+)>",
      queue: "PETSEO.Worker.Sync.Broadcast",
    },
    {
      kind: "regex",
      name: "default",
      files: `${CONSUMERS}/**/*.cs`,
      pattern: "IConsumer<(?<message>[\\w.]+)>",
      queue: "PETSEO.Worker.Sync",
      exclude: ["broadcast-group"],
    },
  ],
};

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        [MESSAGES]: contracts(),
        [`${CONSUMERS}/Orders/OrderPlacedConsumer.cs`]: consumer("OrderPlaced"),
        [`${CONSUMERS}/Orders/OrderShippedConsumer.cs`]: consumer("OrderShipped"),
        [`${CONSUMERS}/Invoices/InvoiceIssuedConsumer.cs`]: consumer("InvoiceIssued"),
        [`${CONSUMERS}/Orders/OrderCancelledConsumer.cs`]: consumer("OrderCancelled"),
      },
      tag: "2.2.4",
    },
    {
      // A new message consumed from a new consumer group; every existing consumer stays where it was.
      files: {
        [MESSAGES]: contracts("public sealed record TermsChange(Guid TermsId);"),
        [`${CONSUMERS}/Broadcast/TermsChangeConsumer.cs`]: consumer("TermsChange"),
      },
      tag: "2.3.7",
    },
    {
      // One existing consumer moves into the group's folder, another is deleted, a third is commented out.
      files: {
        [`${CONSUMERS}/Orders/OrderShippedConsumer.cs`]: null,
        [`${CONSUMERS}/Broadcast/OrderShippedConsumer.cs`]: consumer("OrderShipped"),
        [`${CONSUMERS}/Invoices/InvoiceIssuedConsumer.cs`]: null,
        [`${CONSUMERS}/Orders/OrderPlacedConsumer.cs`]: `// ${consumer("OrderPlaced").replaceAll("\n", "\n// ")}`,
      },
      tag: "2.4.0",
    },
    {
      // The consumer group's folder is gone.
      files: {
        [`${CONSUMERS}/Broadcast/TermsChangeConsumer.cs`]: null,
        [`${CONSUMERS}/Broadcast/OrderShippedConsumer.cs`]: null,
      },
      tag: "2.5.0",
    },
  ]);
  writeRepoFile(repo, "compat.json", JSON.stringify({ layers: { "message-contracts": LAYER } }));
});
afterAll(() => repo.cleanup());

async function runCheck(base: string, revision: string) {
  const run = createIo(repo.dir);
  const args = [
    "check",
    "--base",
    base,
    "--revision",
    revision,
    "--config",
    "compat.json",
    "--format",
    "json",
  ];
  const exitCode = await main(args, run.io);
  const [layer] = JSON.parse(run.stdout()).layers;
  return { exitCode, layer };
}

type Finding = { id: string; subject: string; scope: string; class: string; message: string };

describe("message-contracts consumers", () => {
  it("reports no consumer change when only a new message gets a new consumer group", async () => {
    const { layer } = await runCheck("2.2.4", "2.3.7");
    expect(layer.status).toBe("ran");
    expect(layer.findings.filter((finding: Finding) => finding.id.startsWith("message-consumer"))).toEqual(
      [],
    );
    expect(layer.notes).toEqual(
      expect.arrayContaining([
        'consumer source "broadcast-group" (PETSEO.Worker.Sync.Broadcast): 0 consumed message(s) at the base, 1 in the revision',
        'consumer source "default" (PETSEO.Worker.Sync): 4 consumed message(s) at the base, 4 in the revision',
      ]),
    );
  });

  it("reports a consumer moved to another queue and consumers no longer there as needs-action", async () => {
    const { exitCode, layer } = await runCheck("2.3.7", "2.4.0");
    expect(exitCode).toBe(0);
    expect(layer.status).toBe("ran");
    const consumers = layer.findings
      .filter((finding: Finding) => finding.id.startsWith("message-consumer"))
      .map((finding: Finding) => [
        finding.id,
        finding.class,
        finding.scope,
        finding.subject,
        finding.message,
      ]);
    expect(consumers).toEqual([
      [
        "message-consumer-removed",
        "needs-action",
        "default",
        "InvoiceIssued",
        "consumed from PETSEO.Worker.Sync at the base, not in the revision (no consumer left): messages already in PETSEO.Worker.Sync get no consumer; drain it before the deploy, or keep its consumer for one release",
      ],
      [
        "message-consumer-removed",
        "needs-action",
        "default",
        "OrderPlaced",
        "consumed from PETSEO.Worker.Sync at the base, not in the revision (no consumer left): messages already in PETSEO.Worker.Sync get no consumer; drain it before the deploy, or keep its consumer for one release",
      ],
      [
        "message-consumer-moved",
        "needs-action",
        "broadcast-group",
        "OrderShipped",
        "consumed from PETSEO.Worker.Sync at the base and from PETSEO.Worker.Sync.Broadcast in the revision: messages already in PETSEO.Worker.Sync get no consumer after the deploy, and after a rollback the base build does not consume PETSEO.Worker.Sync.Broadcast; drain PETSEO.Worker.Sync first, or keep the old endpoint for one release",
      ],
    ]);
    const moved = layer.findings.find((finding: Finding) => finding.id === "message-consumer-moved");
    expect(moved.evidence).toEqual([
      expect.objectContaining({
        side: "base",
        ref: "2.3.7",
        path: `${CONSUMERS}/Orders/OrderShippedConsumer.cs`,
        line: 3,
      }),
      expect.objectContaining({
        side: "revision",
        ref: "2.4.0",
        path: `${CONSUMERS}/Broadcast/OrderShippedConsumer.cs`,
        line: 3,
      }),
    ]);
  });

  it("fails without consumer findings when a consumer source matches no file in the revision", async () => {
    const { exitCode, layer } = await runCheck("2.4.0", "2.5.0");
    expect(exitCode).toBe(1);
    expect(layer.status).toBe("failed");
    expect(layer.error).toBe('consumer source "broadcast-group" matches no file in the revision (2.5.0)');
    expect(layer.findings.filter((finding: Finding) => finding.id.startsWith("message-consumer"))).toEqual(
      [],
    );
  });
});
