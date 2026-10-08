import { describe, expect, it } from "vitest";
import { readTypescriptClient } from "../../../src/layers/client-usage/read-typescript-client.js";
import type { ClientRefUsage } from "../../../src/layers/client-usage/refine.js";
import { refineRollbackFindings } from "../../../src/layers/client-usage/refine-rollback.js";
import type { Finding } from "../../../src/model/finding.js";
import { createFinding } from "../../helpers/stub-layer.js";

const CLIENT = `
export const client = {
  addVendor(body: AddVendor): Promise<void> {
    return fetch("/api/service-vendors", { method: "POST", body: JSON.stringify(body) });
  },
  listVendors(kind?: string): Promise<void> {
    return fetch(\`/api/service-vendors?kind=\${kind}\`, { method: "GET" });
  },
};
export interface AddVendor {
  name: string;
  latitude?: number | null;
  city: string;
}
`;

const SUBJECT = "POST /api/service-vendors";

function usage(overrides: Partial<ClientRefUsage> = {}): ClientRefUsage {
  return {
    client: "b2b",
    api: "b2b",
    ref: "2.3.7",
    commit: "c".repeat(40),
    clientPath: "web/client.ts",
    model: readTypescriptClient(CLIENT),
    deployedWith: "revision",
    ...overrides,
  };
}

const widening = (id: string, property: string, overrides: Partial<Finding> = {}): Finding =>
  createFinding("safe", {
    layer: "openapi",
    scope: "b2b",
    id,
    subject: SUBJECT,
    message: `the request property \`${property}\` became ${id === "request-property-became-nullable" ? "nullable" : "optional"}`,
    ...overrides,
  });

describe("refineRollbackFindings", () => {
  it("marks a property that became nullable and the revision build may omit as rollback-risk", () => {
    const finding = widening("request-property-became-nullable", "latitude");
    const [revision] = refineRollbackFindings([finding], [usage()]);
    expect(revision?.index).toBe(0);
    expect(revision?.finding.class).toBe("rollback-risk");
    expect(revision?.finding.reclassified).toEqual({
      from: "safe",
      by: "client-usage",
      reason:
        "b2b@2.3.7 deploys with the server and calls it; the base server does not accept this after a rollback",
    });
    expect(revision?.finding.message).toBe(
      "the request property `latitude` became nullable; after a rollback the base server gets `latitude` null or missing from b2b@2.3.7, which deploys with the server (client-usage); where the base type is a non-nullable value type (number, boolean) the base server binds a missing value to its default (0, false) instead of rejecting it",
    );
    expect(revision?.finding.evidence.at(-1)).toEqual({
      side: "client",
      ref: "2.3.7",
      commit: "c".repeat(40),
      path: "web/client.ts",
      line: 4,
    });
  });

  it("names the call site that sends the property as undefined", () => {
    const sources = [
      {
        path: "web/ProfileAddPage.tsx",
        text: 'client.addVendor({ name, latitude: undefined, city: "x" });\n',
      },
    ];
    const [revision] = refineRollbackFindings(
      [widening("request-property-became-nullable", "latitude")],
      [usage({ sources, sourceIdentifiers: new Set(["addVendor"]) })],
    );
    expect(revision?.finding.class).toBe("rollback-risk");
    expect(revision?.finding.evidence).toContainEqual(
      expect.objectContaining({ side: "client", path: "web/ProfileAddPage.tsx", line: 1 }),
    );
  });

  it("leaves the finding safe when the revision build always sends the property", () => {
    expect(refineRollbackFindings([widening("request-property-became-optional", "city")], [usage()])).toEqual(
      [],
    );
    expect(
      refineRollbackFindings([widening("request-property-became-optional", "latitude")], [usage()])[0]
        ?.finding.message,
    ).toContain("gets requests without `latitude` from b2b@2.3.7");
  });

  it("marks a widening without a property proof as rollback-risk whenever the revision build calls it", () => {
    const finding = createFinding("safe", {
      layer: "openapi",
      scope: "b2b",
      id: "request-parameter-became-optional",
      subject: "GET /api/service-vendors",
      message: "the `query` request parameter `kind` became optional",
    });
    const [revision] = refineRollbackFindings([finding], [usage()]);
    expect(revision?.finding.class).toBe("rollback-risk");
    expect(revision?.finding.message).toBe(
      "the `query` request parameter `kind` became optional; after a rollback the base server gets these requests from b2b@2.3.7, which deploys with the server (client-usage)",
    );
  });

  it("leaves alone operations the revision build does not call, other APIs, accepted and non-widening findings", () => {
    const findings = [
      widening("request-property-became-nullable", "latitude", { subject: "PUT /api/other" }),
      widening("request-property-became-nullable", "latitude", { scope: "b2c" }),
      widening("request-property-became-nullable", "latitude", { accepted: { reason: "geocoded" } }),
      widening("new-optional-request-property", "latitude"),
      widening("request-property-became-nullable", "latitude", { class: "breaking" }),
    ];
    expect(refineRollbackFindings(findings, [usage()])).toEqual([]);
    expect(
      refineRollbackFindings(
        [widening("request-property-became-nullable", "latitude")],
        [usage({ sourceIdentifiers: new Set(["listVendors"]) })],
      ),
    ).toEqual([]);
  });
});
