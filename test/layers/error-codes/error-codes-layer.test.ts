import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import { errorCodesLayer } from "../../../src/layers/error-codes/error-codes-layer.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

const ERRORS_V1 = [
  "public static class CartErrors {",
  '  public static readonly Error Full = new Error("Shop.Cart.Full", "Cart is full");',
  '  public static readonly Error Gone = new Error("Pet.Gone", "Pet is gone");',
  "}",
].join("\n");

const ERRORS_V2 = [
  "public static class CartErrors {",
  '  public static readonly Error Full = new Error("Shop.Cart.Full", "Cart is full");',
  '  public static readonly Error NotFound = new Error("Shop.Cart.NotFound", "No cart");',
  "}",
  'public static readonly Error Disabled = new Error("FeatureFlag.General.Disabled", "Off");',
].join("\n");

const map = (codes: string[]) =>
  `export const API_ERRORS = {\n${codes.map((code) => `  "${code}": "text",`).join("\n")}\n};\n`;

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    { files: { "app/constants/api.ts": map(["Shop.Cart.Full"]) }, tag: "mobile-2.0.1" },
    { files: { "src/Errors.cs": ERRORS_V1 }, tag: "server-2.2.4" },
    { files: { "app/constants/api.ts": map(["Shop.Cart.Full", "Shop.Cart.NotFound"]) }, tag: "mobile-2.2.4" },
    { files: { "src/Errors.cs": ERRORS_V2, "app/constants/api.ts": null }, tag: "server-2.3.5" },
    { files: { "app/constants/api.ts": map(["Shop.Cart.Full", "Shop.Cart.NotFound"]) }, tag: "server-2.3.6" },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-error-codes-layer-"));
  const opened = await Promise.all([
    openRefTree({ repoDir: repo.dir, ref: "server-2.2.4", side: "base", tempRoot }),
    openRefTree({ repoDir: repo.dir, ref: "server-2.3.5", side: "revision", tempRoot }),
  ]);
  if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
  base = opened[0].value;
  revision = opened[1].value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

const codes = [{ name: "api", files: ["src/**/*.cs"], pattern: 'new Error\\(\\s*"(?<code>[\\w.]+)"' }];
const mobile = {
  name: "mobile",
  refs: { tags: "mobile-*" },
  files: ["app/constants/api.ts"],
  pattern: '"(?<code>[\\w.]+)":',
};

const run = (config: unknown, revisionTree = revision) =>
  errorCodesLayer.run({
    config: errorCodesLayer.configSchema.parse(config),
    base,
    revision: revisionTree,
    repoDir: repo.dir,
    tempDir: tempRoot,
    env: process.env,
    log: () => {},
  });

describe("error-codes layer", () => {
  it("reports codes new in the revision that live client refs cannot translate", async () => {
    const result = await run({ codes, clients: [mobile] });
    expect(result.status).toBe("ran");
    if (result.status === "skipped") return;
    expect(result.findings.map((finding) => [finding.id, finding.class, finding.subject])).toEqual([
      ["error-code-added", "safe", "FeatureFlag.General.Disabled"],
      ["error-code-added", "safe", "Shop.Cart.NotFound"],
      ["error-code-removed", "safe", "Pet.Gone"],
      ["error-code-unknown-to-client", "needs-action", "FeatureFlag.General.Disabled"],
      ["error-code-unknown-to-client", "needs-action", "Shop.Cart.NotFound"],
    ]);
    const notFound = result.findings[4];
    expect(notFound?.message).toContain("not translated by mobile@mobile-2.0.1;");
    expect(notFound?.evidence.map(({ side, ref, path, line }) => [side, ref, path, line])).toEqual([
      ["revision", "server-2.3.5", "src/Errors.cs", 3],
      ["client", "mobile-2.0.1", "app/constants/api.ts", undefined],
    ]);
    expect(result.findings[3]?.message).toContain("not translated by mobile@mobile-2.0.1, mobile-2.2.4;");
    expect(result.notes).toEqual([
      'code source "api": 2 code(s) at base, 3 at revision',
      'client "mobile" at mobile-2.0.1, mobile-2.2.4: 1/2 translated code(s)',
      'client "mobile": tags:mobile-* → mobile-2.0.1, mobile-2.2.4',
    ]);
  });

  it("applies accept entries", async () => {
    const result = await run({
      codes,
      clients: [{ ...mobile, refs: ["mobile-2.2.4"] }],
      accept: [{ code: "FeatureFlag.General.Disabled", reason: "shown as a toast" }],
    });
    if (result.status === "skipped") throw new Error("skipped");
    expect(result.findings.filter((finding) => finding.id === "error-code-unknown-to-client")).toEqual([
      expect.objectContaining({
        subject: "FeatureFlag.General.Disabled",
        accepted: { reason: "shown as a toast" },
      }),
    ]);
  });

  it("reports only codes returned by operations that live client refs call", async () => {
    const web = { ...mobile, name: "web", refs: ["mobile-2.0.1"] };
    const result = await errorCodesLayer.run({
      config: errorCodesLayer.configSchema.parse({
        codes,
        clients: [{ ...mobile, refs: ["mobile-2.0.1"] }, web],
        returnedBy: [{ codes: "Shop.*", api: "b2c", operations: "* /api/shop/**" }],
      }),
      base,
      revision,
      repoDir: repo.dir,
      tempDir: tempRoot,
      env: process.env,
      log: () => {},
      results: [{ layer: "openapi", status: "ran", findings: [], notes: [] }],
      calls: [
        {
          client: "mobile",
          api: "b2c",
          ref: "2.0.1",
          operations: [{ method: "get", path: "/api/shop/cart" }],
        },
        { client: "web", api: "b2c", ref: "w1", operations: [{ method: "get", path: "/api/pets" }] },
      ],
    });
    if (result.status === "skipped") throw new Error("skipped");
    expect(
      result.findings
        .filter((finding) => finding.id === "error-code-unknown-to-client")
        .map((finding) => [finding.scope, finding.subject, finding.class]),
    ).toEqual([
      ["mobile", "FeatureFlag.General.Disabled", "needs-action"],
      ["mobile", "Shop.Cart.NotFound", "needs-action"],
      ["web", "FeatureFlag.General.Disabled", "needs-action"],
      ["web", "Shop.Cart.NotFound", "safe"],
    ]);
    expect(result.notes).toContain("returnedBy made 1 error-code-unknown-to-client finding(s) safe");
  });

  it("fails when a client ref has no map file, keeping the code findings", async () => {
    const result = await run({ codes, clients: [{ ...mobile, refs: ["server-2.3.5"] }] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toBe('client "mobile": server-2.3.5: no file matches app/constants/api.ts');
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "error-code-added",
      "error-code-added",
      "error-code-removed",
    ]);
  });

  it("fails when a client pattern captures no code", async () => {
    const result = await run({ codes, clients: [{ ...mobile, pattern: "'(?<code>[\\w.]+)':" }] });
    expect(result.status === "failed" && result.error).toBe(
      'client "mobile": mobile-2.0.1: pattern captured no code in app/constants/api.ts',
    );
  });

  it("fails without comparing when a code source matches nothing at the revision", async () => {
    const result = await run({ codes: [{ ...codes[0], files: ["server/**/*.cs"] }], clients: [mobile] });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).toBe('code source "api": no file matches server/**/*.cs at revision server-2.3.5');
    expect(result.findings).toEqual([]);
  });

  it("fails when a client ref is not in the clone", async () => {
    const result = await run({ codes, clients: [{ ...mobile, refs: ["mobile-9.9.9"] }] });
    expect(result.status === "failed" && result.error).toMatch(
      /^client "mobile": .*fetch the client refs \(actions\/checkout with fetch-depth: 0\)$/,
    );
  });

  describe("a client deployed with the server", () => {
    const web = { ...mobile, name: "web", refs: ["mobile-2.0.1"], deployedWith: "revision" };

    const openRevision = async (ref: string) => {
      const tree = await openRefTree({ repoDir: repo.dir, ref, side: "revision", tempRoot });
      if (!tree.ok) throw new Error(tree.error);
      return tree.value;
    };

    const unknown = (findings: { id: string; subject: string; class: string }[]) =>
      findings
        .filter((finding) => finding.id === "error-code-unknown-to-client")
        .map((finding) => [finding.subject, finding.class]);

    it("makes a code the revision build translates safe as a stale-tab gap", async () => {
      const result = await run({ codes, clients: [web] }, await openRevision("server-2.3.6"));
      if (result.status === "skipped") throw new Error("skipped");
      expect(unknown(result.findings)).toEqual([
        ["FeatureFlag.General.Disabled", "needs-action"],
        ["Shop.Cart.NotFound", "safe"],
      ]);
      expect(
        result.findings.find(
          (finding) =>
            finding.id === "error-code-unknown-to-client" && finding.subject === "Shop.Cart.NotFound",
        )?.reclassified,
      ).toEqual({
        from: "needs-action",
        by: "error-codes",
        reason: "only web@mobile-2.0.1 tabs opened before the deploy; web@server-2.3.6 translates it",
      });
      expect(result.notes).toContain('client "web" at revision server-2.3.6: 2 translated code(s)');
    });

    it("keeps needs-action without deployedWith", async () => {
      const result = await run(
        { codes, clients: [{ ...web, deployedWith: undefined }] },
        await openRevision("server-2.3.6"),
      );
      if (result.status === "skipped") throw new Error("skipped");
      expect(unknown(result.findings)).toEqual([
        ["FeatureFlag.General.Disabled", "needs-action"],
        ["Shop.Cart.NotFound", "needs-action"],
      ]);
    });

    it("fails when the revision has no map file for the client", async () => {
      const result = await run({ codes, clients: [web] });
      expect(result.status === "failed" && result.error).toBe(
        'client "web": server-2.3.5: no file matches app/constants/api.ts',
      );
    });
  });
});
