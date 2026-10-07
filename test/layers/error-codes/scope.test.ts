import { describe, expect, it } from "vitest";
import { type CodeDeclaration, classifyErrorCodes } from "../../../src/layers/error-codes/classify.js";
import { errorCodesConfigSchema } from "../../../src/layers/error-codes/config.js";
import { scopeErrorCodes } from "../../../src/layers/error-codes/scope.js";
import type { ClientRefCalls } from "../../../src/layers/layer.js";
import type { LayerResult } from "../../../src/model/finding.js";
import { createFinding } from "../../helpers/stub-layer.js";

const declare = (line: number): CodeDeclaration => ({
  source: "api",
  evidence: { side: "revision", ref: "v2", commit: "c2", path: "src/Errors.cs", line },
});

const revision = new Map(
  [
    "Shop.Cart.NotFound",
    "ServiceVendor.Location.Invalid",
    "NotificationBroadcast.Sent",
    "FeatureFlag.General.Disabled",
  ].map((code, index) => [code, declare(index + 1)]),
);

const lacking = (ref: string) => ({
  ref,
  commit: `c-${ref}`,
  paths: ["app/api.ts"],
  codes: new Set<string>(),
});

const findings = classifyErrorCodes({
  base: new Map(),
  revision,
  clients: [
    { client: "mobile", refs: [lacking("2.0.1")] },
    { client: "web", refs: [lacking("w1")] },
    { client: "admin", refs: [lacking("a1")] },
  ],
}).filter((finding) => finding.id === "error-code-unknown-to-client");

const config = errorCodesConfigSchema.parse({
  codes: [{ name: "api", files: ["src/**/*.cs"], pattern: "(?<code>x)" }],
  clients: [
    { name: "mobile", refs: ["v1"], files: ["a.ts"], pattern: "(?<code>x)" },
    { name: "web", refs: ["v1"], files: ["a.ts"], pattern: "(?<code>x)", usage: ["web-b2b"] },
    { name: "admin", refs: ["v1"], files: ["a.ts"], pattern: "(?<code>x)" },
  ],
  returnedBy: [
    { codes: "Shop.*", api: "b2c", operations: "* /api/shop/**" },
    {
      codes: ["ServiceVendor.Location.*"],
      api: "b2b",
      operations: ["POST /api/service-vendors", "PUT /api/service-vendors"],
    },
    { codes: "NotificationBroadcast.*", api: "admin", operations: "* /api/notification-broadcasts{,/**}" },
  ],
});

const calls: ClientRefCalls[] = [
  {
    client: "mobile",
    api: "b2c",
    ref: "2.0.1",
    operations: [
      { method: "get", path: "/api/shop/items" },
      { method: "get", path: "/api/pets/{}" },
    ],
  },
  {
    client: "web-b2b",
    api: "b2b",
    ref: "w1",
    operations: [
      { method: "post", path: "/api/service-vendors" },
      { method: "get", path: "/api/service-vendors/{}" },
    ],
  },
];

const openapi: LayerResult = {
  layer: "openapi",
  status: "ran",
  findings: [
    createFinding("safe", {
      layer: "openapi",
      scope: "b2c",
      id: "endpoint-added",
      subject: "GET /api/shop/items",
    }),
    createFinding("safe", {
      layer: "openapi",
      scope: "admin",
      id: "endpoint-added",
      subject: "POST /api/notification-broadcasts",
    }),
  ],
  notes: [],
};

const summarize = (scoped: ReturnType<typeof scopeErrorCodes>) =>
  scoped.findings.map((finding) => [
    finding.scope,
    finding.subject,
    finding.class,
    finding.reclassified?.reason,
  ]);

describe("scopeErrorCodes", () => {
  it("makes a code safe for a client whose live refs call none of the operations that return it", () => {
    const scoped = scopeErrorCodes(findings, {
      returnedBy: config.returnedBy ?? [],
      clients: config.clients,
      calls,
      results: [openapi],
    });
    expect(summarize(scoped)).toEqual([
      ["mobile", "FeatureFlag.General.Disabled", "needs-action", undefined],
      [
        "mobile",
        "NotificationBroadcast.Sent",
        "safe",
        "returned only by * /api/notification-broadcasts{,/**} (admin), which mobile@2.0.1 does not call",
      ],
      [
        "mobile",
        "ServiceVendor.Location.Invalid",
        "safe",
        "returned only by POST /api/service-vendors, PUT /api/service-vendors (b2b), which mobile@2.0.1 does not call",
      ],
      [
        "mobile",
        "Shop.Cart.NotFound",
        "safe",
        "returned only by * /api/shop/** (b2c); mobile@2.0.1 calls there only endpoints new in the revision",
      ],
      ["web", "FeatureFlag.General.Disabled", "needs-action", undefined],
      [
        "web",
        "NotificationBroadcast.Sent",
        "safe",
        "returned only by * /api/notification-broadcasts{,/**} (admin), which web-b2b@w1 does not call",
      ],
      ["web", "ServiceVendor.Location.Invalid", "needs-action", undefined],
      [
        "web",
        "Shop.Cart.NotFound",
        "safe",
        "returned only by * /api/shop/** (b2c), which web-b2b@w1 does not call",
      ],
      ["admin", "FeatureFlag.General.Disabled", "needs-action", undefined],
      ["admin", "NotificationBroadcast.Sent", "needs-action", undefined],
      ["admin", "ServiceVendor.Location.Invalid", "needs-action", undefined],
      ["admin", "Shop.Cart.NotFound", "needs-action", undefined],
    ]);
    const vendor = scoped.findings[6];
    expect(vendor?.message).toMatch(/; returned by POST \/api\/service-vendors, which web-b2b@w1 calls$/);
    expect(scoped.findings[1]?.reclassified?.from).toBe("needs-action");
    expect(scoped.findings[1]?.reclassified?.by).toBe("error-codes");
    expect(scoped.notes).toEqual([
      'client "admin": no client-usage calls, so returnedBy cannot scope its codes; enable client-usage with a client named "admin" or list its clients in clients[].usage',
      "returnedBy made 5 error-code-unknown-to-client finding(s) safe",
    ]);
  });

  it("keeps every finding when client-usage did not run", () => {
    const scoped = scopeErrorCodes(findings, {
      returnedBy: config.returnedBy ?? [],
      clients: config.clients,
      calls: undefined,
      results: [openapi],
    });
    expect(scoped.findings).toEqual(findings);
    expect(scoped.notes).toHaveLength(4);
  });

  it("changes nothing without returnedBy", () => {
    expect(
      scopeErrorCodes(findings, { returnedBy: [], clients: config.clients, calls, results: [openapi] }),
    ).toEqual({ findings, notes: [] });
  });

  it("counts a call with an unknown method as calling every method", () => {
    const scoped = scopeErrorCodes(findings, {
      returnedBy: config.returnedBy ?? [],
      clients: config.clients,
      calls: [
        {
          client: "mobile",
          api: "b2b",
          ref: "2.0.1",
          operations: [{ method: "*", path: "/api/service-vendors" }],
        },
      ],
      results: [],
    });
    const vendor = scoped.findings.find(
      (finding) => finding.scope === "mobile" && finding.subject === "ServiceVendor.Location.Invalid",
    );
    expect(vendor?.class).toBe("needs-action");
  });
});

describe("error-codes returnedBy config", () => {
  it("rejects an operation without a method and path", () => {
    const parsed = errorCodesConfigSchema.safeParse({
      codes: [{ name: "api", files: ["a.cs"], pattern: "(?<code>x)" }],
      clients: [{ name: "m", refs: ["v1"], files: ["a.ts"], pattern: "(?<code>x)" }],
      returnedBy: [{ codes: "Shop.*", api: "b2c", operations: "/api/shop/**" }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([
      'returnedBy.0.operations.0: use "METHOD /path/glob", for example "* /api/shop/**"',
    ]);
  });
});
