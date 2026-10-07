import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const CONTEXT_PATH = "PETSEO.Infrastructure/Persistence/PetseoDbContext.cs";
const ENUM_PATH = "PETSEO.Domain/Notifications/NotificationType.cs";

/** A DbContext whose `ConfigureEnum<NotificationType>()` call sits on line 188, as in research F7. */
const dbContext = [
  "namespace PETSEO.Infrastructure.Persistence;",
  "",
  "public sealed class PetseoDbContext : DbContext",
  "{",
  "    protected override void ConfigureConventions(ModelConfigurationBuilder builder)",
  "    {",
  ...Array.from({ length: 181 }, (_, index) => `        // convention ${index + 1}`),
  "        builder.ConfigureEnum<NotificationType>();",
  "    }",
  "",
  "    // The helper itself matches the discovery pattern too; `T` is declared nowhere and is skipped.",
  "    private static void ConfigureEnum<T>(ModelConfigurationBuilder builder) where T : struct, Enum",
  "        => builder.Properties<T>().HaveConversion<string>();",
  "}",
].join("\n");

const notificationType = (...extra: string[]) =>
  [
    "namespace PETSEO.Domain.Notifications;",
    "",
    "public enum NotificationType",
    "{",
    "    /// <summary>Visit reminder.</summary>",
    '    [Description("Reminder, before a visit")]',
    "    VisitReminder,",
    "    Newsletter,",
    ...extra,
    "}",
  ].join("\n");

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        [CONTEXT_PATH]: dbContext,
        [ENUM_PATH]: notificationType(),
        // An enum the parser cannot read must not block the others.
        "PETSEO.Domain/Debug.cs": "enum DebugOnly\n{\n#if DEBUG\n    Trace,\n#endif\n}",
      },
      tag: "2.2.4",
    },
    { files: { [ENUM_PATH]: notificationType("    TermsChange,") }, tag: "2.3.4" },
  ]);
  const layer = {
    sources: "**/*.cs",
    enums: [
      {
        kind: "discover",
        files: "**/*DbContext.cs",
        pattern: "ConfigureEnum<(?<name>[\\w.]+)>",
        storage: "string",
      },
    ],
  };
  writeRepoFile(repo, "plain.json", JSON.stringify({ layers: { "persisted-enums": layer } }));
  writeRepoFile(
    repo,
    "accepted.json",
    JSON.stringify({
      layers: {
        "persisted-enums": {
          ...layer,
          accept: [
            {
              id: "enum-member-added",
              enum: "NotificationType",
              member: "TermsChange",
              reason: "no rollback below 2.3.4 is planned once terms notifications are sent",
            },
          ],
        },
      },
    }),
  );
});
afterAll(() => repo.cleanup());

const check = (config: string, ...extra: string[]) => [
  "check",
  "--base",
  "2.2.4",
  "--revision",
  "2.3.4",
  "--config",
  config,
  ...extra,
];

describe("persisted-enums layer (research F7)", () => {
  it("reports the added member as rollback-risk with the member line and the DbContext line as evidence", async () => {
    const run = createIo(repo.dir);
    expect(await main(check("plain.json", "--format", "json", "--fail-on", "rollback-risk"), run.io)).toBe(1);
    const report = JSON.parse(run.stdout());
    expect(report.layers.filter((item: { status: string }) => item.status === "ran")).toHaveLength(1);
    const [layer] = report.layers;
    expect(layer.status).toBe("ran");
    expect(layer.findings).toHaveLength(1);
    expect(layer.notes).toEqual([
      "1 persisted enum(s) checked",
      'enum "T" was discovered but is declared in no source file at either ref; it is not checked',
    ]);
    const [finding] = layer.findings;
    expect(finding).toMatchObject({
      layer: "persisted-enums",
      scope: "NotificationType",
      id: "enum-member-added",
      subject: "NotificationType.TermsChange",
      class: "rollback-risk",
    });
    expect(finding.evidence).toEqual([
      expect.objectContaining({ side: "revision", ref: "2.3.4", path: ENUM_PATH, line: 9 }),
      expect.objectContaining({ side: "revision", ref: "2.3.4", path: CONTEXT_PATH, line: 188 }),
    ]);
  });

  it("passes the default gate, which fails only on breaking findings", async () => {
    const run = createIo(repo.dir);
    expect(await main(check("plain.json"), run.io)).toBe(0);
    expect(run.stdout()).toContain("NotificationType.TermsChange");
  });

  it("passes a rollback-risk gate when the finding is accepted", async () => {
    const run = createIo(repo.dir);
    expect(await main(check("accepted.json", "--fail-on", "rollback-risk"), run.io)).toBe(0);
    expect(run.stdout()).toContain("**Gate: PASS**");
    expect(run.stdout()).toContain("## Accepted (1)");
  });
});
