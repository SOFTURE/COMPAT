import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

const ENUM_PATH = "PETSEO.Domain/Notifications/NotificationType.cs";
const CLIENT_PATH = "APP/MOBILE/services/api/petseo.client.ts";
const SCREEN_PATH = "APP/MOBILE/app/notifications.tsx";

const notificationType = (...extra: string[]) =>
  ["public enum NotificationType", "{", "    VisitReminder,", "    Newsletter,", ...extra, "}"].join("\n");

const CLIENT = [
  "export interface NotificationDto { id: string; type: string; }",
  "export const getNotifications = () => fetch(`/api/notifications`, { method: 'GET' });",
].join("\n");

/** The 2.2.4 screen only renders the type; the 2.1.0 screen switches on it exhaustively. */
const RENDERING_SCREEN = "export const Row = (n: NotificationDto) => <Text>{n.type}</Text>;\n";
const SWITCHING_SCREEN = [
  "export function iconOf(n: NotificationDto): string {",
  "  switch (n.type) {",
  '    case "VisitReminder": return "bell";',
  '    case "Newsletter": return "mail";',
  "  }",
  "}",
].join("\n");

type ReportFinding = {
  id: string;
  class: string;
  message: string;
  evidence: { side: string; ref: string; path: string; line?: number }[];
  reclassified?: { from: string; by: string; reason: string };
};

let repo: TestRepo;

function writeConfig(name: string, refs: string[]): void {
  writeRepoFile(
    repo,
    name,
    JSON.stringify({
      layers: {
        "persisted-enums": {
          sources: "**/*.cs",
          enums: [
            {
              kind: "named",
              name: "NotificationType",
              storage: "string",
              exposed: [{ api: "b2c", fields: ["NotificationDto.type"] }],
            },
          ],
        },
        "client-usage": {
          clients: [
            {
              name: "mobile",
              api: "b2c",
              refs,
              generatedClient: { kind: "typescript", path: CLIENT_PATH },
              sources: ["APP/MOBILE/app/**/*.tsx"],
            },
          ],
        },
      },
    }),
  );
}

beforeAll(() => {
  repo = createRepo([
    { files: { [CLIENT_PATH]: CLIENT, [SCREEN_PATH]: SWITCHING_SCREEN }, tag: "mobile-2.1.0" },
    { files: { [SCREEN_PATH]: RENDERING_SCREEN }, tag: "mobile-2.2.4" },
    { files: { [ENUM_PATH]: notificationType() }, tag: "2.2.4" },
    { files: { [ENUM_PATH]: notificationType("    TermsChange,") }, tag: "2.3.4" },
  ]);
  writeConfig("rendering.json", ["mobile-2.2.4"]);
  writeConfig("switching.json", ["mobile-2.1.0", "mobile-2.2.4"]);
});
afterAll(() => repo.cleanup());

async function runCheck(config: string) {
  const run = createIo(repo.dir);
  const args = ["check", "--base", "2.2.4", "--revision", "2.3.4", "--config", config, "--format", "json"];
  const exitCode = await main(args, run.io);
  const report = JSON.parse(run.stdout());
  const layers = report.layers
    .filter((layer: { status: string }) => layer.status === "ran")
    .map((layer: { layer: string }) => layer.layer);
  const enums = report.layers.find((layer: { layer: string }) => layer.layer === "persisted-enums");
  const find = (id: string): ReportFinding =>
    enums.findings.find((finding: ReportFinding) => finding.id === id);
  return { exitCode, layers, find };
}

describe("exposed persisted enums refined by client-usage (issue #15)", () => {
  it("reports enum-member-exposed-added next to enum-member-added and drops it to safe without a branch", async () => {
    const { exitCode, layers, find } = await runCheck("rendering.json");
    expect(exitCode).toBe(0);
    expect(layers).toEqual(["persisted-enums", "client-usage"]);
    expect(find("enum-member-added").class).toBe("rollback-risk");
    const exposed = find("enum-member-exposed-added");
    expect(exposed.class).toBe("safe");
    expect(exposed.reclassified).toEqual({
      from: "needs-action",
      by: "client-usage",
      reason: "no live client ref branches on NotificationDto.type: mobile@mobile-2.2.4",
    });
    expect(exposed.evidence).toContainEqual(
      expect.objectContaining({ side: "client", ref: "mobile-2.2.4", path: CLIENT_PATH }),
    );
  });

  it("keeps needs-action and cites the switch of a live ref that branches on the field", async () => {
    const { find } = await runCheck("switching.json");
    const exposed = find("enum-member-exposed-added");
    expect(exposed.class).toBe("needs-action");
    expect(exposed.reclassified).toBeUndefined();
    expect(exposed.message).toBe(
      'old clients receive the unknown value "TermsChange" in NotificationDto.type (API "b2c"); check that they tolerate it; mobile@mobile-2.1.0 branch on NotificationDto.type (client-usage)',
    );
    expect(exposed.evidence).toContainEqual(
      expect.objectContaining({ side: "client", ref: "mobile-2.1.0", path: SCREEN_PATH, line: 2 }),
    );
  });
});
