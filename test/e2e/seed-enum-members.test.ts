import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const ENUM_PATH = "src/Domain/NotificationType.cs";
const SEED_PATH = "db/seed.sql";

const notificationType = (...extra: string[]) =>
  ["public enum NotificationType", "{", "    VisitReminder,", "    Newsletter,", ...extra, "}"].join("\n");

const seed = (...rows: string[]) =>
  [
    'INSERT INTO notifications."NotificationTemplates" ("Type", "Channel") VALUES',
    rows.join(",\n"),
    "ON CONFLICT DO NOTHING;",
    'INSERT INTO notifications."Banners" ("Key", "Type") VALUES',
    "('spring', 'Newsletter')",
    "ON CONFLICT DO NOTHING;",
  ].join("\n");

type JsonFinding = {
  layer: string;
  id: string;
  class: string;
  subject: string;
  message: string;
  evidence: { side: string; path: string; line?: number }[];
  reclassified?: { from: string; by: string; reason: string };
};
type JsonLayer = { layer: string; status: string; findings: JsonFinding[] };

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    {
      files: {
        [ENUM_PATH]: notificationType(),
        [SEED_PATH]: seed("('VisitReminder', 'Email')"),
      },
      tag: "2.2.4",
    },
    {
      files: {
        [ENUM_PATH]: notificationType("    TermsChange,"),
        [SEED_PATH]: [
          seed("('VisitReminder', 'Email')", "('TermsChange', 'Email')", "('TermsChange', 'Sms')"),
          'INSERT INTO notifications."Banners" ("Key", "Type") VALUES (\'summer\', \'Newsletter\') ON CONFLICT DO NOTHING;',
        ].join("\n"),
      },
      tag: "2.3.4",
    },
  ]);
  writeRepoFile(
    repo,
    "compat.json",
    JSON.stringify({
      layers: {
        seed: { sources: [{ name: "db", dialect: "postgres", files: [SEED_PATH] }] },
        "persisted-enums": {
          sources: "src/**/*.cs",
          enums: [{ kind: "named", name: "NotificationType", storage: "string" }],
        },
      },
    }),
  );
});
afterAll(() => repo.cleanup());

async function check() {
  const run = createIo(repo.dir);
  const exitCode = await main(
    ["check", "--base", "2.2.4", "--revision", "2.3.4", "--config", "compat.json", "--format", "json"],
    run.io,
  );
  const report = JSON.parse(run.stdout());
  const layer = (name: string) => report.layers.find((item: JsonLayer) => item.layer === name) as JsonLayer;
  return { exitCode, seed: layer("seed"), enums: layer("persisted-enums") };
}

describe("seed rows that write a persisted-enum member new in the revision", () => {
  it("reports the seed rows as rollback-risk with the enum declaration as evidence", async () => {
    const { seed: seedLayer } = await check();
    expect(seedLayer.status).toBe("ran");
    const templates = seedLayer.findings.find((finding) => finding.subject.includes("NotificationTemplates"));
    expect(templates).toMatchObject({
      id: "row-added",
      class: "rollback-risk",
      reclassified: {
        from: "safe",
        by: "persisted-enums",
        reason: "writes NotificationType member TermsChange, new in the revision",
      },
    });
    expect(templates?.message).toContain(
      "writes NotificationType member TermsChange, new in the revision: a base build that reads this table fails after a rollback",
    );
    expect(templates?.message).not.toContain("old builds ignore rows they do not know");
    expect(templates?.evidence).toEqual([
      expect.objectContaining({ side: "revision", path: SEED_PATH, line: 3 }),
      expect.objectContaining({ side: "revision", path: SEED_PATH, line: 4 }),
      expect.objectContaining({ side: "revision", path: ENUM_PATH, line: 5 }),
    ]);
  });

  it("keeps a seed row whose literals match no added member safe", async () => {
    const { seed: seedLayer } = await check();
    const banners = seedLayer.findings.find((finding) => finding.subject.includes("Banners"));
    expect(banners).toMatchObject({ id: "row-added", class: "safe" });
    expect(banners?.reclassified).toBeUndefined();
  });

  it("says the seed writes the added member on deploy, with the seed row as evidence", async () => {
    const { enums } = await check();
    expect(enums.findings).toHaveLength(1);
    const [added] = enums.findings;
    expect(added).toMatchObject({ id: "enum-member-added", class: "rollback-risk" });
    expect(added?.message).toBe(
      'string storage: "TermsChange" is new: the seed writes it on deploy, so the base build cannot read those rows after a rollback',
    );
    expect(added?.evidence).toEqual([
      expect.objectContaining({ side: "revision", path: ENUM_PATH, line: 5 }),
      expect.objectContaining({ side: "revision", path: SEED_PATH, line: 3 }),
    ]);
  });
});
