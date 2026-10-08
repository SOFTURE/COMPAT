import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCheck } from "../../src/commands/check.js";
import { defineLayer, type FindingRevision, type Layer } from "../../src/layers/layer.js";
import type { LayerResult } from "../../src/model/finding.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createFinding, createIo, createStubLayer } from "../helpers/stub-layer.js";

let repo: TestRepo;

beforeAll(() => {
  repo = createRepo([
    { files: { "a.txt": "1" }, tag: "v1" },
    { files: { "a.txt": "2" }, tag: "v2" },
  ]);
  writeRepoFile(
    repo,
    "compat.config.json",
    JSON.stringify({ layers: { stub: { level: "breaking" }, refiner: {} } }),
  );
});
afterAll(() => repo.cleanup());

function createRefiner(revise: (earlier: readonly LayerResult[]) => FindingRevision[]): Layer {
  return defineLayer({
    name: "refiner",
    description: "test refiner",
    configSchema: z.strictObject({}),
    async run({ results }) {
      return {
        layer: "refiner",
        status: "ran",
        findings: [],
        notes: ["refined"],
        revisions: revise(results ?? []),
      };
    },
  });
}

const check = async (refiner: Layer) => {
  const run = createIo(repo.dir, [createStubLayer(), refiner]);
  const exitCode = await runCheck(
    { base: "v1", revision: "v2", format: "json", failOn: "breaking", allowIncomplete: false },
    run.io,
  );
  return { exitCode, report: JSON.parse(run.stdout()) };
};

describe("runCheck with a refining layer", () => {
  it("passes earlier results to the layer and applies its revisions before the gate", async () => {
    const { exitCode, report } = await check(
      createRefiner((earlier) => {
        const finding = createFinding("breaking", { layer: "stub" });
        expect(earlier).toEqual([{ layer: "stub", status: "ran", findings: [finding], notes: [] }]);
        return [
          {
            layer: "stub",
            index: 0,
            finding: {
              ...finding,
              class: "safe",
              reclassified: { from: "breaking", by: "refiner", reason: "unused" },
            },
          },
        ];
      }),
    );
    expect(exitCode).toBe(0);
    const [stub, refiner] = report.layers;
    expect(stub.findings[0].class).toBe("safe");
    expect(stub.findings[0].reclassified).toEqual({ from: "breaking", by: "refiner", reason: "unused" });
    expect(stub.verdict).toBe("safe");
    expect(refiner).toEqual({
      layer: "refiner",
      status: "ran",
      findings: [],
      notes: ["refined"],
      verdict: "no-findings",
      acceptedCount: 0,
      reclassifiedCount: 1,
    });
  });

  it("passes the client calls a layer shares to the layers after it, and keeps them out of the report", async () => {
    const calls = [{ client: "mobile", api: "b2c", ref: "1.0", operations: [{ method: "get", path: "/a" }] }];
    const sharer = createStubLayer("stub", () => ({ layer: "stub", status: "ran", findings: [], notes: [] }));
    const refiner = createRefiner(() => []);
    const seen: unknown[] = [];
    const run = createIo(repo.dir, [
      { ...sharer, run: async (context) => ({ ...(await sharer.run(context)), calls }) },
      {
        ...refiner,
        run: (context) => {
          seen.push(context.calls);
          return refiner.run(context);
        },
      },
    ]);
    await runCheck(
      { base: "v1", revision: "v2", format: "json", failOn: "breaking", allowIncomplete: false },
      run.io,
    );
    expect(seen).toEqual([calls]);
    expect(JSON.parse(run.stdout()).layers[0].calls).toBeUndefined();
  });

  it("fails the refining layer and keeps the original findings when a revision changes which finding it is", async () => {
    const { exitCode, report } = await check(
      createRefiner(() => [
        { layer: "stub", index: 0, finding: createFinding("safe", { layer: "stub", id: "other-rule" }) },
      ]),
    );
    expect(exitCode).toBe(1);
    const [stub, refiner] = report.layers;
    expect(stub.findings[0].class).toBe("breaking");
    expect(refiner.status).toBe("failed");
    expect(refiner.error).toBe("invalid refinement: revision of stub finding #0 changes id");
    expect(refiner.notes).toEqual(["refined"]);
  });
});
