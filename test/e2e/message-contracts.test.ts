import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const MESSAGES = "APP/WEB/BACKEND/API/SHARED/PETSEO.Contract.Internal.Messages";
const CONSUMER_GROUPS = "APP/WEB/BACKEND/WORKER/PETSEO.Worker/ConsumerGroups.cs";

const notificationSent = [
  "namespace PETSEO.Contract.Internal.Messages.Notifications;",
  "",
  "public sealed record NotificationSent(Guid NotificationId, NotificationChannel Channel)",
  "{",
  "    public DateTimeOffset SentAt { get; init; }",
  "}",
  "",
  "public enum NotificationChannel { Email, Push }",
].join("\n");

const consumerGroups = (...extra: string[]) =>
  [
    "namespace PETSEO.Worker;",
    "",
    "public static class ConsumerGroups",
    "{",
    '    public const string Notifications = "PETSEO.Worker.Notifications";',
    '    // public const string Legacy = "PETSEO.Worker.Legacy";',
    ...extra,
    "}",
  ].join("\n");

const broadcast = (name: string, body: string) =>
  [
    "namespace PETSEO.Contract.Internal.Messages.NotificationBroadcasts;",
    "",
    `public sealed record ${name}(${body});`,
  ].join("\n");

const LAYER = {
  sources: [{ name: "internal", language: "csharp", files: `${MESSAGES}/**/*.cs` }],
  queues: [
    {
      kind: "regex",
      name: "consumer-groups",
      files: "**/ConsumerGroups.cs",
      pattern: '"(?<queue>PETSEO\\.[\\w.]+)"',
    },
  ],
};

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        [`${MESSAGES}/Notifications/NotificationSent.cs`]: notificationSent,
        [CONSUMER_GROUPS]: consumerGroups(),
      },
      tag: "2.2.4",
    },
    {
      files: {
        [`${MESSAGES}/NotificationBroadcasts/BroadcastCreated.cs`]: broadcast(
          "BroadcastCreated",
          "Guid BroadcastId, string Title",
        ),
        [`${MESSAGES}/NotificationBroadcasts/BroadcastScheduled.cs`]: broadcast(
          "BroadcastScheduled",
          "Guid BroadcastId, DateTimeOffset At",
        ),
        [`${MESSAGES}/NotificationBroadcasts/BroadcastDelivered.cs`]: broadcast(
          "BroadcastDelivered",
          "Guid BroadcastId, int Recipients",
        ),
        [CONSUMER_GROUPS]: consumerGroups(
          '    public const string Broadcast = "PETSEO.Worker.Sync.Broadcast";',
        ),
      },
      tag: "2.3.4",
    },
    {
      // A later release that moves a message to another namespace.
      files: {
        [`${MESSAGES}/Notifications/NotificationSent.cs`]: notificationSent.replace(
          "Messages.Notifications;",
          "Messages.Delivery;",
        ),
      },
      tag: "2.4.0",
    },
    {
      // A release whose contract the parser cannot read.
      files: {
        [`${MESSAGES}/Notifications/NotificationSent.cs`]: notificationSent
          .replace("Messages.Notifications;", "Messages.Delivery;")
          .replace(
            "{\n    public",
            "{\n#if LEGACY\n    public int Legacy { get; init; }\n#endif\n    public",
          ),
      },
      tag: "2.5.0",
    },
  ]);
  writeRepoFile(repo, "compat.json", JSON.stringify({ layers: { "message-contracts": LAYER } }));
  writeRepoFile(
    repo,
    "missing.json",
    JSON.stringify({
      layers: {
        "message-contracts": {
          sources: [{ name: "internal", language: "csharp", files: "Contracts/**/*.cs" }],
        },
      },
    }),
  );
});
afterAll(() => repo.cleanup());

const check = (base: string, revision: string, config = "compat.json") => [
  "check",
  "--base",
  base,
  "--revision",
  revision,
  "--config",
  config,
  "--format",
  "json",
];

async function runCheck(base: string, revision: string, config?: string) {
  const run = createIo(repo.dir);
  const exitCode = await main(check(base, revision, config), run.io);
  const [layer] = JSON.parse(run.stdout()).layers;
  return { exitCode, layer, run };
}

describe("message-contracts layer (research F8)", () => {
  it("reports the three new broadcast messages and the new queue as safe, and nothing else", async () => {
    const { exitCode, layer } = await runCheck("2.2.4", "2.3.4");
    expect(exitCode).toBe(0);
    expect(layer.status).toBe("ran");
    expect(
      layer.findings.map((finding: { id: string; class: string; subject: string }) => [
        finding.id,
        finding.class,
        finding.subject,
      ]),
    ).toEqual([
      ["message-added", "safe", "PETSEO.Contract.Internal.Messages.NotificationBroadcasts.BroadcastCreated"],
      [
        "message-added",
        "safe",
        "PETSEO.Contract.Internal.Messages.NotificationBroadcasts.BroadcastDelivered",
      ],
      [
        "message-added",
        "safe",
        "PETSEO.Contract.Internal.Messages.NotificationBroadcasts.BroadcastScheduled",
      ],
      ["queue-added", "safe", "PETSEO.Worker.Sync.Broadcast"],
    ]);
    const queue = layer.findings.at(-1);
    expect(queue.scope).toBe("consumer-groups");
    expect(queue.evidence).toEqual([
      expect.objectContaining({ side: "revision", ref: "2.3.4", path: CONSUMER_GROUPS, line: 7 }),
    ]);
    expect(layer.notes).toEqual([
      'source "internal": 1 type(s) and 1 enum(s) in 1 file(s) at the base, 4 type(s) and 1 enum(s) in 4 file(s) in the revision',
      'queue source "consumer-groups": 1 queue(s) at the base, 2 in the revision',
    ]);
  });

  it("reports a message moved to another namespace as message-renamed and fails the default gate", async () => {
    const { exitCode, layer } = await runCheck("2.3.4", "2.4.0");
    expect(exitCode).toBe(1);
    expect(
      layer.findings.map((finding: { id: string; class: string; subject: string }) => [
        finding.id,
        finding.class,
        finding.subject,
      ]),
    ).toEqual([
      [
        "message-renamed",
        "breaking",
        "PETSEO.Contract.Internal.Messages.Notifications.NotificationSent -> PETSEO.Contract.Internal.Messages.Delivery.NotificationSent",
      ],
      ["enum-removed", "needs-action", "PETSEO.Contract.Internal.Messages.Notifications.NotificationChannel"],
      ["enum-added", "safe", "PETSEO.Contract.Internal.Messages.Delivery.NotificationChannel"],
    ]);
    expect(layer.findings[0].evidence).toEqual([
      expect.objectContaining({ side: "base", ref: "2.3.4", line: 3 }),
      expect.objectContaining({ side: "revision", ref: "2.4.0", line: 3 }),
    ]);
  });

  it("fails the layer on a contract it cannot read instead of reporting it as removed", async () => {
    const { exitCode, layer } = await runCheck("2.4.0", "2.5.0");
    expect(exitCode).toBe(1);
    expect(layer.status).toBe("failed");
    expect(layer.error).toContain("NotificationSent");
    expect(layer.error).toContain("#if");
    expect(layer.findings).toEqual([]);
  });

  it("fails the layer when a source matches no file", async () => {
    const { exitCode, layer } = await runCheck("2.2.4", "2.3.4", "missing.json");
    expect(exitCode).toBe(1);
    expect(layer.status).toBe("failed");
    expect(layer.error).toBe('source "internal" matches no .cs file at either ref');
  });
});
