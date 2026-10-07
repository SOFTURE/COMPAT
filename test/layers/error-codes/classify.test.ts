import { describe, expect, it } from "vitest";
import {
  applyErrorCodeAccept,
  type CodeDeclaration,
  classifyErrorCodes,
} from "../../../src/layers/error-codes/classify.js";

const declare = (side: "base" | "revision", line: number): CodeDeclaration => ({
  source: "api",
  evidence: { side, ref: side === "base" ? "v1" : "v2", commit: side, path: "src/Errors.cs", line },
});

const base = new Map([
  ["Shop.Cart.Full", declare("base", 1)],
  ["Pet.Gone", declare("base", 2)],
]);
const revision = new Map([
  ["Shop.Cart.Full", declare("revision", 1)],
  ["Shop.Cart.NotFound", declare("revision", 2)],
  ["FeatureFlag.General.Disabled", declare("revision", 3)],
]);
const ref = (name: string, codes: string[]) => ({
  ref: name,
  commit: `c-${name}`,
  paths: ["app/api.ts"],
  codes: new Set(codes),
});

describe("classifyErrorCodes", () => {
  it("reports added and removed codes as safe and new codes a live ref lacks as needs-action", () => {
    const findings = classifyErrorCodes({
      base,
      revision,
      clients: [
        {
          client: "mobile",
          refs: [ref("2.0.1", ["Shop.Cart.Full"]), ref("2.2.4", ["Shop.Cart.Full", "Shop.Cart.NotFound"])],
        },
        { client: "web", refs: [ref("2.3.5", ["Shop.Cart.NotFound", "FeatureFlag.General.Disabled"])] },
      ],
    });
    expect(findings.map((finding) => [finding.id, finding.class, finding.scope, finding.subject])).toEqual([
      ["error-code-added", "safe", "api", "FeatureFlag.General.Disabled"],
      ["error-code-added", "safe", "api", "Shop.Cart.NotFound"],
      ["error-code-removed", "safe", "api", "Pet.Gone"],
      ["error-code-unknown-to-client", "needs-action", "mobile", "FeatureFlag.General.Disabled"],
      ["error-code-unknown-to-client", "needs-action", "mobile", "Shop.Cart.NotFound"],
    ]);
    const unknown = findings[4];
    expect(unknown?.message).toBe(
      "error code Shop.Cart.NotFound is new in the revision and not translated by mobile@2.0.1; these builds show a generic error instead of its message",
    );
    expect(unknown?.evidence).toEqual([
      declare("revision", 2).evidence,
      { side: "client", ref: "2.0.1", commit: "c-2.0.1", path: "app/api.ts" },
    ]);
    expect(findings[3]?.message).toContain("not translated by mobile@2.0.1, 2.2.4;");
  });

  it("reports nothing when the codes are unchanged", () => {
    expect(
      classifyErrorCodes({ base, revision: base, clients: [{ client: "m", refs: [ref("1", [])] }] }),
    ).toEqual([]);
  });
});

describe("applyErrorCodeAccept", () => {
  it("accepts unknown-to-client findings by code and client and notes unused entries", () => {
    const findings = classifyErrorCodes({
      base,
      revision,
      clients: [
        { client: "mobile", refs: [ref("2.0.1", [])] },
        { client: "admin", refs: [ref("1.0.0", [])] },
      ],
    });
    const { findings: accepted, notes } = applyErrorCodeAccept(findings, [
      { code: "Shop.Cart.NotFound", client: "mobile", reason: "cart is web only" },
      { code: "FeatureFlag.General.Disabled", reason: "shown as a toast" },
      { code: "Pet.Gone", reason: "no longer used" },
    ]);
    expect(
      accepted.filter((finding) => finding.accepted).map((finding) => [finding.scope, finding.subject]),
    ).toEqual([
      ["mobile", "FeatureFlag.General.Disabled"],
      ["mobile", "Shop.Cart.NotFound"],
      ["admin", "FeatureFlag.General.Disabled"],
    ]);
    expect(notes).toEqual([
      "accept entry Shop.Cart.NotFound for mobile accepted 1 finding(s)",
      "accept entry FeatureFlag.General.Disabled accepted 2 finding(s)",
      "accept entry Pet.Gone matched nothing; remove it if the code is translated now",
    ]);
  });
});

describe("applyErrorCodeAccept with globs", () => {
  const findings = classifyErrorCodes({
    base: new Map(),
    revision: new Map([
      ["Shop.Cart.NotFound", declare("revision", 1)],
      ["Shop.Order.Paid", declare("revision", 2)],
      ["FeatureFlag.General.Disabled", declare("revision", 3)],
    ]),
    clients: [{ client: "mobile", refs: [ref("2.0.1", [])] }],
  }).filter((finding) => finding.id === "error-code-unknown-to-client");

  it("accepts every code a glob matches, counts them and reports a glob that matched nothing", () => {
    const { findings: accepted, notes } = applyErrorCodeAccept(findings, [
      { code: "Shop.*", reason: "shop is new" },
      { code: "Notification*.*", client: "mobile", reason: "admin only" },
    ]);
    expect(accepted.map((finding) => [finding.subject, finding.accepted?.reason])).toEqual([
      ["FeatureFlag.General.Disabled", undefined],
      ["Shop.Cart.NotFound", "shop is new"],
      ["Shop.Order.Paid", "shop is new"],
    ]);
    expect(notes).toEqual([
      "accept entry Shop.* accepted 2 finding(s)",
      "accept entry Notification*.* for mobile matched nothing; remove it if the code is translated now",
    ]);
  });

  it("leaves findings that are already safe alone, so an entry they made redundant reads as unused", () => {
    const scoped = findings.map((finding) => ({ ...finding, class: "safe" as const }));
    const { findings: accepted, notes } = applyErrorCodeAccept(scoped, [{ code: "Shop.*", reason: "x" }]);
    expect(accepted.every((finding) => finding.accepted === undefined)).toBe(true);
    expect(notes).toEqual(["accept entry Shop.* matched nothing; remove it if the code is translated now"]);
  });
});
