import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const MESSAGES = "APP/SHARED/PETSEO.Contract.Internal.Messages";
const ADMIN = "APP/ADMIN/PETSEO.Admin.Api";
const WORKER = "APP/WORKER/PETSEO.Worker.Sync";
const TESTS = "APP/TESTS/PETSEO.Integration.Tests";

const message = (name: string) =>
  ["namespace PETSEO.Contract.Internal.Messages;", "", `public sealed record ${name}(Guid Id);`].join("\n");

const csproj = '<Project Sdk="Microsoft.NET.Sdk"></Project>';

const LAYER = { sources: [{ name: "internal", language: "csharp", files: `${MESSAGES}/**/*.cs` }] };

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        [`${MESSAGES}/PETSEO.Contract.Internal.Messages.csproj`]: csproj,
        [`${MESSAGES}/NotificationSent.cs`]: message("NotificationSent"),
        [`${ADMIN}/PETSEO.Admin.Api.csproj`]: csproj,
        [`${WORKER}/PETSEO.Worker.Sync.csproj`]: csproj,
      },
      tag: "2.2.4",
    },
    {
      files: {
        [`${MESSAGES}/NotificationBroadcastRequestedMessage.cs`]: message(
          "NotificationBroadcastRequestedMessage",
        ),
        [`${MESSAGES}/BroadcastScheduled.cs`]: message("BroadcastScheduled"),
        [`${MESSAGES}/BroadcastAudited.cs`]: message("BroadcastAudited"),
        [`${MESSAGES}/BroadcastDraft.cs`]: message("BroadcastDraft"),
        [`${ADMIN}/Events/OnNotificationBroadcastRequestedEvent.cs`]: [
          "namespace PETSEO.Admin.Api.Events;",
          "",
          "public sealed class OnNotificationBroadcastRequestedEvent(IPublishEndpoint bus)",
          "{",
          "    public Task Handle(Guid id, CancellationToken ct) =>",
          "        bus.Publish(new NotificationBroadcastRequestedMessage(id), ct);",
          "}",
        ].join("\n"),
        [`${WORKER}/Consumers/BroadcastConsumer.cs`]: [
          "namespace PETSEO.Worker.Sync.Consumers;",
          "",
          "public sealed class BroadcastConsumer : IConsumer<NotificationBroadcastRequestedMessage>, IConsumer<BroadcastScheduled>",
          "{",
          "    // await context.Publish<BroadcastDraft>(new { Id = Guid.Empty });",
          "    public Task Consume(ConsumeContext<NotificationBroadcastRequestedMessage> context) =>",
          "        context.Publish<BroadcastScheduled>(new { context.Message.Id });",
          "}",
        ].join("\n"),
        [`${TESTS}/PETSEO.Integration.Tests.csproj`]: csproj,
        [`${TESTS}/BroadcastTests.cs`]: [
          "public sealed class AuditConsumer : IConsumer<BroadcastAudited> { }",
          "public sealed class BroadcastTests { void Run() => harness.Bus.Publish(new BroadcastAudited(Guid.Empty)); }",
        ].join("\n"),
      },
      tag: "2.3.7",
    },
  ]);
  writeRepoFile(repo, "compat.json", JSON.stringify({ layers: { "message-contracts": LAYER } }));
});
afterAll(() => repo.cleanup());

async function runCheck() {
  const run = createIo(repo.dir);
  const exitCode = await main(
    ["check", "--base", "2.2.4", "--revision", "2.3.7", "--config", "compat.json", "--format", "json"],
    run.io,
  );
  const [layer] = JSON.parse(run.stdout()).layers;
  return { exitCode, layer };
}

describe("message-contracts deploy order (issue #105)", () => {
  it("reports a new message published by one project and consumed by another as needs-action", async () => {
    const { exitCode, layer } = await runCheck();
    expect(exitCode).toBe(0);
    expect(layer.status).toBe("ran");
    expect(
      layer.findings.map((finding: { id: string; class: string; subject: string }) => [
        finding.id,
        finding.class,
        finding.subject,
      ]),
    ).toEqual([
      // Published and consumed only by a test project, and named only in a comment: no production publisher.
      ["message-added", "safe", "PETSEO.Contract.Internal.Messages.BroadcastAudited"],
      ["message-added", "safe", "PETSEO.Contract.Internal.Messages.BroadcastDraft"],
      // Published and consumed by the same project, which deploys as one.
      ["message-added", "safe", "PETSEO.Contract.Internal.Messages.BroadcastScheduled"],
      [
        "message-added",
        "needs-action",
        "PETSEO.Contract.Internal.Messages.NotificationBroadcastRequestedMessage",
      ],
    ]);
    expect(layer.findings.at(-1).message).toBe(
      "the type is new in the revision, published by PETSEO.Admin.Api " +
        `(${ADMIN}/Events/OnNotificationBroadcastRequestedEvent.cs:6) and consumed by PETSEO.Worker.Sync ` +
        `(${WORKER}/Consumers/BroadcastConsumer.cs:3): deploy the consumer (or declare its topology) before the ` +
        "publisher, or messages published in between are dropped; after a rollback, drain or delete its queue",
    );
    expect(layer.notes).toContain(
      "deploy order: 1 of 4 new message(s) published and consumed in different projects",
    );
  });
});
