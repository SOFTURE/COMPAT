import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const MESSAGES = "APP/WEB/BACKEND/API/SHARED/PETSEO.Contract.Internal.Messages";
const WORKER = "APP/WEB/BACKEND/WORKER/PETSEO.Worker.Sync";
const CONSUMER_GROUPS = `${WORKER}/ConsumerGroups.cs`;
const APPSETTINGS = `${WORKER}/appsettings.json`;

const appsettings = (rabbit: Record<string, string>) =>
  JSON.stringify({ Rabbit: { Host: "rabbit", ...rabbit } }, null, 2);

const consumerGroups = (...groups: string[]) =>
  [
    "namespace PETSEO.Worker.Sync;",
    "",
    "public static class ConsumerGroups",
    "{",
    ...groups.map((group) => `    public const string ${group} = "${group}";`),
    "}",
  ].join("\n");

const LAYER = {
  sources: [{ name: "internal", language: "csharp", files: `${MESSAGES}/**/*.cs` }],
  queues: [
    {
      kind: "regex",
      name: "rabbit-endpoint",
      files: "**/appsettings.json",
      pattern: '"Name":\\s*"(?<queue>[^"]+)"',
      report: false,
    },
    {
      kind: "regex",
      name: "group-separator",
      files: "**/appsettings.json",
      pattern: '"GroupSeparator":\\s*"(?<queue>[^"]+)"',
      report: false,
    },
    {
      kind: "regex",
      name: "consumer-groups",
      files: "**/ConsumerGroups.cs",
      pattern: 'const string \\w+ = "(?<queue>\\w+)"',
      report: false,
    },
    {
      kind: "composed",
      name: "group-queues",
      template: "{endpoint}{separator}{group}",
      parts: {
        endpoint: "rabbit-endpoint",
        group: "consumer-groups",
        separator: { source: "group-separator", default: "." },
      },
    },
  ],
};

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        [`${MESSAGES}/NotificationSent.cs`]:
          "namespace PETSEO.Contract.Internal.Messages;\n\npublic sealed record NotificationSent(Guid Id);",
        [APPSETTINGS]: appsettings({ Name: "PETSEO.Worker.Sync", GroupSeparator: "-" }),
        [CONSUMER_GROUPS]: consumerGroups("Notifications"),
      },
      tag: "2.2.4",
    },
    {
      // The library upgrade drops the separator setting and its default becomes "."; a group is added.
      files: {
        [APPSETTINGS]: appsettings({ Name: "PETSEO.Worker.Sync" }),
        [CONSUMER_GROUPS]: consumerGroups("Notifications", "Broadcast"),
      },
      tag: "2.3.5",
    },
    {
      files: { [CONSUMER_GROUPS]: consumerGroups("Notifications", "Broadcast", "Digest") },
      tag: "2.3.6",
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

const summarize = (findings: { id: string; class: string; scope: string; subject: string }[]) =>
  findings.map((finding) => [finding.id, finding.class, finding.scope, finding.subject]);

describe("message-contracts composed queues (issue #47)", () => {
  it("reports the composed name of a new group and nothing for the raw parts", async () => {
    const { layer } = await runCheck("2.3.5", "2.3.6");
    expect(layer.status).toBe("ran");
    expect(summarize(layer.findings)).toEqual([
      ["queue-added", "rollback-risk", "group-queues", "PETSEO.Worker.Sync.Digest"],
    ]);
    expect(layer.findings[0].evidence).toEqual([
      expect.objectContaining({ side: "revision", ref: "2.3.6", path: CONSUMER_GROUPS, line: 7 }),
    ]);
    expect(layer.notes).toEqual([
      'source "internal": 1 type(s) and 0 enum(s) in 1 file(s) at the base, 1 type(s) and 0 enum(s) in 1 file(s) in the revision',
      'queue source "rabbit-endpoint": 1 queue(s) at the base, 1 in the revision (a part, not reported)',
      'queue source "group-separator": 0 queue(s) at the base, 0 in the revision (a part, not reported)',
      'queue source "consumer-groups": 2 queue(s) at the base, 3 in the revision (a part, not reported)',
      'queue source "group-queues": 2 queue(s) at the base, 3 in the revision',
    ]);
  });

  it("reports a separator change as every group queue removed and added under its new name", async () => {
    const { layer } = await runCheck("2.2.4", "2.3.5");
    expect(summarize(layer.findings)).toEqual([
      ["queue-removed", "needs-action", "group-queues", "PETSEO.Worker.Sync-Notifications"],
      ["queue-added", "rollback-risk", "group-queues", "PETSEO.Worker.Sync.Notifications"],
      ["queue-added", "rollback-risk", "group-queues", "PETSEO.Worker.Sync.Broadcast"],
    ]);
    expect(layer.findings[0].evidence).toEqual([
      expect.objectContaining({ side: "base", ref: "2.2.4", path: CONSUMER_GROUPS, line: 5 }),
    ]);
  });
});
