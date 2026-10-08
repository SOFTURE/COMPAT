import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const MESSAGES = "Contracts/Messages.cs";
const WORKER = "src/PETSEO.Worker.Sync";
const CONSUMERS = `${WORKER}/Consumers`;
const APPSETTINGS = `${WORKER}/appsettings.json`;
const GROUPS = `${WORKER}/ConsumerGroups.cs`;

const contracts = [
  "namespace PETSEO.Contract.Internal.Messages;",
  "",
  "public sealed record OrderPlaced(Guid OrderId);",
  "public sealed record TermsChange(Guid TermsId);",
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

const appsettings = (endpoint: string) =>
  JSON.stringify({ Rabbit: { Name: endpoint, Host: "localhost" } }, null, 2);

const consumerGroups = (...groups: string[]) =>
  [
    "namespace PETSEO.Worker.Sync;",
    "",
    "public static class ConsumerGroups",
    "{",
    ...groups.map((group) => `    public const string ${group} = "${group}";`),
    "}",
  ].join("\n");

const QUEUES = [
  {
    kind: "regex",
    name: "rabbit-endpoint",
    files: APPSETTINGS,
    pattern: '"Name": "(?<queue>[\\w.]+)"',
  },
  {
    kind: "regex",
    name: "consumer-groups",
    files: GROUPS,
    pattern: 'const string \\w+ = "(?<queue>\\w+)"',
    report: false,
  },
  {
    kind: "composed",
    name: "group-queues",
    template: "{endpoint}{separator}{group}",
    parts: { endpoint: "rabbit-endpoint", group: "consumer-groups", separator: { default: "." } },
  },
];

const consumerSource = (extra: object) => ({
  kind: "regex",
  pattern: "IConsumer<(?<message>[\\w.]+)>",
  ...extra,
});

const layer = (consumers: object[]) => ({
  sources: [{ name: "internal", language: "csharp", files: "Contracts/**/*.cs" }],
  queues: QUEUES,
  consumers,
});

const BROADCAST = consumerSource({
  name: "broadcast-group",
  files: `${CONSUMERS}/TermsChange/*.cs`,
  queueFrom: "group-queues",
  select: "Broadcast",
});

const DEFAULT = consumerSource({
  name: "default-endpoint",
  files: `${CONSUMERS}/**/*.cs`,
  queueFrom: "rabbit-endpoint",
  exclude: ["broadcast-group"],
});

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        [MESSAGES]: contracts,
        [APPSETTINGS]: appsettings("PETSEO.Worker.Sync"),
        [GROUPS]: consumerGroups("Broadcast"),
        [`${CONSUMERS}/Orders/OrderPlacedConsumer.cs`]: consumer("OrderPlaced"),
        [`${CONSUMERS}/TermsChange/TermsChangeConsumer.cs`]: consumer("TermsChange"),
      },
      tag: "3.0.0",
    },
    {
      // The release renames the receive endpoint; every consumer stays in its folder.
      files: { [APPSETTINGS]: appsettings("PETSEO.Worker.Synchronizer") },
      tag: "3.1.0",
    },
    {
      // A second consumer group; the endpoint and the consumers stay.
      files: { [GROUPS]: consumerGroups("Broadcast", "Audit") },
      tag: "3.2.0",
    },
    {
      // The endpoint name leaves appsettings.json.
      files: { [APPSETTINGS]: JSON.stringify({ Rabbit: { Host: "localhost" } }, null, 2) },
      tag: "3.3.0",
    },
  ]);
  writeRepoFile(
    repo,
    "compat.json",
    JSON.stringify({ layers: { "message-contracts": layer([BROADCAST, DEFAULT]) } }),
  );
  const literal = layer([
    consumerSource({
      name: "broadcast-group",
      files: `${CONSUMERS}/TermsChange/*.cs`,
      queue: "PETSEO.Worker.Sync.Broadcast",
    }),
    consumerSource({
      name: "default-endpoint",
      files: `${CONSUMERS}/**/*.cs`,
      queue: "PETSEO.Worker.Sync",
      exclude: ["broadcast-group"],
    }),
  ]);
  writeRepoFile(repo, "literal.json", JSON.stringify({ layers: { "message-contracts": literal } }));
  const unselected = layer([{ ...BROADCAST, select: undefined }, DEFAULT]);
  writeRepoFile(repo, "unselected.json", JSON.stringify({ layers: { "message-contracts": unselected } }));
});
afterAll(() => repo.cleanup());

async function runCheck(base: string, revision: string, config = "compat.json") {
  const run = createIo(repo.dir);
  const args = ["check", "--base", base, "--revision", revision, "--config", config, "--format", "json"];
  const exitCode = await main(args, run.io);
  const [result] = JSON.parse(run.stdout()).layers;
  return { exitCode, layer: result };
}

type Finding = { id: string; subject: string; scope: string; message: string };

const getConsumerFindings = (findings: Finding[]) =>
  findings
    .filter((finding) => finding.id.startsWith("message-consumer"))
    .map((finding) => [finding.id, finding.scope, finding.subject]);

describe("message-contracts consumers with queueFrom", () => {
  it("reports every consumer as moved when the release renames the endpoint", async () => {
    const { layer: result } = await runCheck("3.0.0", "3.1.0");
    expect(result.status).toBe("ran");
    expect(getConsumerFindings(result.findings)).toEqual([
      ["message-consumer-moved", "broadcast-group", "TermsChange"],
      ["message-consumer-moved", "default-endpoint", "OrderPlaced"],
    ]);
    const moved = result.findings.find((finding: Finding) => finding.subject === "TermsChange");
    expect(moved.message).toContain(
      "consumed from PETSEO.Worker.Sync.Broadcast at the base and from PETSEO.Worker.Synchronizer.Broadcast in the revision",
    );
    expect(result.notes).toEqual(
      expect.arrayContaining([
        'consumer source "broadcast-group" (PETSEO.Worker.Sync.Broadcast at the base, PETSEO.Worker.Synchronizer.Broadcast in the revision): 1 consumed message(s) at the base, 1 in the revision',
        'consumer source "default-endpoint" (PETSEO.Worker.Sync at the base, PETSEO.Worker.Synchronizer in the revision): 1 consumed message(s) at the base, 1 in the revision',
      ]),
    );
  });

  it("reports no moved consumer for the same rename with literal queues", async () => {
    const { layer: result } = await runCheck("3.0.0", "3.1.0", "literal.json");
    expect(result.status).toBe("ran");
    expect(getConsumerFindings(result.findings)).toEqual([]);
  });

  it("keeps the selected group queue when the composed source gives more names", async () => {
    const { layer: result } = await runCheck("3.1.0", "3.2.0");
    expect(result.status).toBe("ran");
    expect(getConsumerFindings(result.findings)).toEqual([]);
  });

  it("fails without consumer findings when queueFrom gives several names at a ref", async () => {
    const { exitCode, layer: result } = await runCheck("3.1.0", "3.2.0", "unselected.json");
    expect(exitCode).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.error).toBe(
      'consumer source "broadcast-group": queue source "group-queues" gives 2 queue names at 3.2.0 ' +
        "(PETSEO.Worker.Synchronizer.Broadcast, PETSEO.Worker.Synchronizer.Audit); set select to pick one",
    );
    expect(getConsumerFindings(result.findings)).toEqual([]);
  });

  it("fails without consumer findings when queueFrom gives no name at a ref", async () => {
    const { exitCode, layer: result } = await runCheck("3.2.0", "3.3.0");
    expect(exitCode).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      'consumer source "default-endpoint": queue source "rabbit-endpoint" gives no queue name at 3.3.0',
    );
    expect(getConsumerFindings(result.findings)).toEqual([]);
  });
});
