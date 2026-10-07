import { describe, expect, it } from "vitest";
import type { ClientRefUsage } from "../../../src/layers/client-usage/refine.js";
import {
  getBranchKey,
  refineExposedFindings,
  toBranchTarget,
} from "../../../src/layers/client-usage/refine-enums.js";
import type { Finding } from "../../../src/model/finding.js";
import { createFinding } from "../../helpers/stub-layer.js";

const b2c = { api: "b2c", fields: ["NotificationDto.Type", "InboxItem.type"] };
const admin = { api: "admin", fields: ["Row.kind"] };

const exposed = (overrides: Partial<Finding> = {}) =>
  createFinding("needs-action", {
    layer: "persisted-enums",
    scope: "NotificationType",
    id: "enum-member-exposed-added",
    subject: "NotificationType.TermsChange",
    exposure: [b2c],
    ...overrides,
  });

function usage(api: string, ref: string, sites?: { path: string; line: number }[]): ClientRefUsage {
  const result: ClientRefUsage = {
    client: api === "b2c" ? "mobile" : "panel",
    api,
    ref,
    commit: "c".repeat(40),
    clientPath: "client.ts",
    model: { operations: [], unreadUrls: [], types: new Map() },
  };
  if (sites !== undefined) {
    const target = toBranchTarget("NotificationType", api === "b2c" ? b2c : admin);
    result.branches = new Map([[getBranchKey(target), sites]]);
  }
  return result;
}

describe("toBranchTarget", () => {
  it("keeps the distinct lower-case property names of the fields", () => {
    expect(toBranchTarget("NotificationType", b2c)).toEqual({
      enumName: "NotificationType",
      properties: ["type"],
    });
  });
});

describe("refineExposedFindings", () => {
  it("leaves accepted, safe and other findings alone", () => {
    const findings = [
      exposed({ accepted: { reason: "fine" } }),
      exposed({ class: "safe" }),
      exposed({ id: "enum-member-added" }),
      createFinding("needs-action", { exposure: [b2c] }),
    ];
    expect(refineExposedFindings(findings, [usage("b2c", "1.0", [])]).revisions).toEqual([]);
  });

  it("keeps the class while one exposing API has no client, and says so", () => {
    const summary = refineExposedFindings([exposed({ exposure: [b2c, admin] })], [usage("b2c", "1.0", [])]);
    expect(summary.revisions[0]?.finding.class).toBe("needs-action");
    expect(summary.revisions[0]?.finding.message).toBe(
      'a needs-action change; API "admin" has no client configured (client-usage)',
    );
    expect(summary.withEvidence).toBe(1);
  });

  it("drops to safe only when every exposing API is read and none branches", () => {
    const summary = refineExposedFindings(
      [exposed({ exposure: [b2c, admin] })],
      [usage("b2c", "1.0", []), usage("b2c", "1.1", []), usage("admin", "3.0", [])],
    );
    expect(summary.toSafe).toBe(1);
    expect(summary.revisions[0]?.finding.reclassified?.reason).toBe(
      "no live client ref branches on NotificationDto.Type, InboxItem.type, Row.kind: mobile@1.0, 1.1; panel@3.0",
    );
  });

  it("cites the branch sites of every branching ref", () => {
    const summary = refineExposedFindings(
      [exposed()],
      [usage("b2c", "1.0", [{ path: "a.ts", line: 3 }]), usage("b2c", "1.1", [])],
    );
    const finding = summary.revisions[0]?.finding;
    expect(finding?.class).toBe("needs-action");
    expect(finding?.evidence.at(-1)).toEqual({
      side: "client",
      ref: "1.0",
      commit: "c".repeat(40),
      path: "a.ts",
      line: 3,
    });
  });
});
