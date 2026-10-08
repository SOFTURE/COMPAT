import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { isProcessAlive } from "../helpers/process-state.js";
import { createIo } from "../helpers/stub-layer.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/behaviour/${name}`, import.meta.url), "utf8");

let repo: TestRepo;
let scratch: string;

const START = {
  run: "node app/server.mjs",
  background: true,
  ready: "http://127.0.0.1:{port}/hc",
  timeoutSeconds: 30,
};
const TEST = {
  run: "node tests/run-tests.mjs",
  results: { kind: "junit", path: "results/*.xml" },
  timeoutSeconds: 30,
};

beforeAll(() => {
  // Base and revision differ only in the response body: the revision renames `count` to `total`.
  repo = createRepo([
    {
      files: {
        "app/server.mjs": fixture("server.mjs"),
        "app/pets-count.json": '{"count":3}',
        "tests/run-tests.mjs": fixture("run-tests.mjs"),
      },
      tag: "2.2.4",
    },
    { files: { "app/pets-count.json": '{"total":3}' }, tag: "2.3.4" },
    { files: { "app/pets-count.json": '{"count":3,"total":3}' }, tag: "2.3.5" },
  ]);
});
afterAll(() => repo.cleanup());
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "compat-behaviour-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function check(layer: unknown, options: { revision?: string; env?: NodeJS.ProcessEnv } = {}) {
  writeRepoFile(repo, "compat.json", JSON.stringify({ layers: { behaviour: layer } }));
  const run = createIo(repo.dir);
  const args = ["check", "--base", "2.2.4", "--revision", options.revision ?? "2.3.4"];
  const logDir = join(scratch, "logs");
  const exitCode = await main([...args, "--config", "compat.json", "--format", "json", "--log-dir", logDir], {
    ...run.io,
    env: { ...process.env, ...options.env },
  });
  const report = run.stdout() ? JSON.parse(run.stdout()) : undefined;
  return { exitCode, layer: report?.layers[0], stderr: run.stderr() };
}

describe("behaviour layer", () => {
  it("reports a base test that fails against the revision stack as breaking", async () => {
    const { exitCode, layer } = await check({ start: START, test: TEST });
    expect(exitCode).toBe(1);
    expect(layer.status).toBe("ran");
    expect(layer.findings).toEqual([
      {
        layer: "behaviour",
        scope: "Pets.Api.Tests",
        id: "base-test-failed",
        subject: "Pets.Api.Tests.returns the pet count",
        class: "breaking",
        message: 'fails against the revision (2.3.4) stack: expected count 3, got {"total":3}',
        evidence: [expect.objectContaining({ side: "base", ref: "2.2.4", path: "results/junit.xml" })],
      },
    ]);
    expect(layer.notes).toContain(
      "2 test(s) from base (2.2.4) ran against the revision (2.3.4) stack, 1 failed",
    );
  });

  it("passes when the revision keeps the behaviour", async () => {
    const { exitCode, layer } = await check({ start: START, test: TEST }, { revision: "2.3.5" });
    expect(exitCode).toBe(0);
    expect(layer).toMatchObject({ status: "ran", findings: [] });
  });

  it("runs stop and stops the app after a test timeout", async () => {
    const pidFile = join(scratch, "app.pid");
    const stopMarker = join(scratch, "stopped");
    const { exitCode, layer } = await check(
      {
        start: START,
        test: { ...TEST, run: 'node -e "setTimeout(() => {}, 60000)"', timeoutSeconds: 1 },
        stop: {
          run: `node -e "require('fs').writeFileSync(process.env.STOP_MARKER, process.env.COMPAT_SIDE)"`,
        },
      },
      { env: { APP_PID_FILE: pidFile, STOP_MARKER: stopMarker } },
    );
    expect(exitCode).toBe(1);
    expect(layer.status).toBe("failed");
    expect(layer.error).toContain("test command at base (2.2.4) timed out after 1 s");
    expect(readFileSync(stopMarker, "utf8")).toBe("revision");
    expect(isProcessAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("runs stop when the stack does not get ready", async () => {
    const stopMarker = join(scratch, "stopped");
    const { layer } = await check(
      {
        start: { ...START, ready: "http://127.0.0.1:{port}/missing", timeoutSeconds: 1 },
        test: TEST,
        stop: { run: `node -e "require('fs').writeFileSync(process.env.STOP_MARKER, '1')"` },
      },
      { env: { STOP_MARKER: stopMarker } },
    );
    expect(layer.status).toBe("failed");
    expect(layer.error).toContain("start command at revision (2.3.4)");
    expect(layer.error).toContain("not ready after 1 s (last: HTTP 404)");
    expect(existsSync(stopMarker)).toBe(true);
  });

  it("reruns the tests and does not report a test that passes on a retry", async () => {
    const { layer } = await check(
      { start: START, test: TEST, retries: 1 },
      { revision: "2.3.5", env: { FLAKY_MARKER: join(scratch, "warm") } },
    );
    expect(layer.status).toBe("ran");
    expect(layer.findings).toEqual([]);
    expect(layer.notes).toContain(
      "1 test(s) failed and then passed on a retry: Pets.Api.Tests.is flaky on the first run",
    );
  });

  it("drops tests that already fail against the base stack when baseline is on", async () => {
    const env = { BROKEN_TEST: "1" };
    const without = await check({ start: START, test: TEST }, { env });
    expect(without.layer.findings.map((finding: { subject: string }) => finding.subject)).toEqual([
      "Pets.Api.Tests.returns the pet count",
      "Pets.Api.Tests.was already broken",
    ]);

    const withBaseline = await check({ start: START, test: TEST, baseline: true }, { env });
    expect(withBaseline.layer.status).toBe("ran");
    expect(withBaseline.layer.findings.map((finding: { subject: string }) => finding.subject)).toEqual([
      "Pets.Api.Tests.returns the pet count",
    ]);
    expect(withBaseline.layer.notes).toContain(
      "baseline: 1 of 3 test(s) already fail against the 2.2.4 stack and are not reported: Pets.Api.Tests.was already broken",
    );
  });

  it("accepts a failed test by name pattern", async () => {
    const { exitCode, layer } = await check({
      start: START,
      test: TEST,
      accept: [{ test: "*pet count", reason: "clients moved to total" }],
    });
    expect(exitCode).toBe(0);
    expect(layer.findings[0].accepted).toEqual({ reason: "clients moved to total" });
    expect(layer.notes).toContain("accept entry for *pet count accepted 1 failed test(s)");
  });

  it("fails when the test command writes no result file", async () => {
    const { exitCode, layer } = await check({
      start: START,
      test: { ...TEST, run: "echo cannot build >&2; exit 3" },
    });
    expect(exitCode).toBe(1);
    expect(layer.status).toBe("failed");
    const log = join(scratch, "logs", "behaviour", "check-test-base.log");
    expect(layer.error).toBe(
      `test command at base (2.2.4) exited 3 and wrote no file matching results/*.xml; full output in ${log}`,
    );
    expect(layer.outputs).toEqual([
      {
        command: "test command at base (2.2.4) exited 3 and wrote no file matching results/*.xml",
        tail: "cannot build",
        log,
      },
    ]);
    expect(readFileSync(log, "utf8")).toBe(
      "$ echo cannot build >&2; exit 3\n\n# stdout\n\n\n# stderr\ncannot build\n",
    );
  });

  it("keeps every line of a failed start in its log and names it in the baseline failure", async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `step ${index + 1}`);
    const { layer } = await check({
      start: { run: `node -e "for (let i = 1; i <= 60; i++) console.error('step ' + i); process.exit(1)"` },
      test: TEST,
      baseline: true,
    });
    const log = join(scratch, "logs", "behaviour", "baseline-start-base.log");
    expect(layer.status).toBe("failed");
    expect(layer.error).toBe(`baseline: start command at base (2.2.4) exited 1; full output in ${log}`);
    expect(layer.outputs).toEqual([
      {
        command: "baseline: start command at base (2.2.4) exited 1",
        tail: lines.slice(-40).join("\n"),
        log,
      },
    ]);
    expect(readFileSync(log, "utf8")).toContain(`# stderr\n${lines.join("\n")}\n`);
    expect(layer.notes).toContain(`command logs in ${join(scratch, "logs", "behaviour")}`);
  });

  it("runs collect after a failed test run and before stop", async () => {
    const order = join(scratch, "order");
    const append = (word: string) =>
      `node -e "require('fs').appendFileSync(process.env.ORDER_FILE, '${word} ' + process.env.COMPAT_SIDE + '\\n'); console.log('${word} output')"`;
    const { layer } = await check(
      { start: START, test: TEST, collect: { run: append("collect") }, stop: { run: append("stop") } },
      { env: { ORDER_FILE: order } },
    );
    expect(layer.status).toBe("ran");
    expect(readFileSync(order, "utf8")).toBe("collect revision\nstop revision\n");
    const log = join(scratch, "logs", "behaviour", "check-collect-revision.log");
    expect(layer.notes).toContain(`collect command output in ${log}`);
    expect(readFileSync(log, "utf8")).toContain("# stdout\ncollect output\n");
  });

  describe("verify", () => {
    const commitOf = (ref: string) => repo.git("rev-parse", `${ref}^{commit}`).trim();

    it("notes that the stack was not verified and how long start took", async () => {
      const { layer } = await check({ start: START, test: TEST, baseline: true });
      const revision = commitOf("2.3.4").slice(0, 12);
      const base = commitOf("2.2.4").slice(0, 12);
      expect(layer.notes).toContain(
        `the stack's code was not verified to be revision (2.3.4, ${revision}); set verify to prove it`,
      );
      expect(layer.notes).toContain(
        `baseline: the stack's code was not verified to be base (2.2.4, ${base}); set verify to prove it`,
      );
      expect(layer.notes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^start command at revision \(2\.3\.4\) took \d+\.\d s$/),
          expect.stringMatching(/^baseline: start command at base \(2\.2\.4\) took \d+\.\d s$/),
        ]),
      );
    });

    it("runs the tests when the stack's URL reports the side's commit", async () => {
      const { layer } = await check({
        start: START,
        test: TEST,
        verify: { url: "http://127.0.0.1:{port}/version" },
      });
      expect(layer.status).toBe("ran");
      expect(layer.findings).toHaveLength(1);
      const commit = commitOf("2.3.4");
      expect(layer.notes).toContain(
        `verified the stack runs revision (2.3.4, ${commit.slice(0, 12)}): it reported ${commit}`,
      );
    });

    it("fails the layer, without running the tests, when the stack reports another commit, and still stops it", async () => {
      const stopMarker = join(scratch, "stopped");
      const stale = commitOf("2.2.4");
      const { exitCode, layer } = await check(
        {
          start: START,
          test: TEST,
          verify: { url: "http://127.0.0.1:{port}/version", expect: "{commit}" },
          stop: { run: `node -e "require('fs').writeFileSync(process.env.STOP_MARKER, '1')"` },
        },
        { env: { STALE_REVISION: stale, STOP_MARKER: stopMarker } },
      );
      expect(exitCode).toBe(1);
      expect(layer.status).toBe("failed");
      expect(layer.findings).toEqual([]);
      expect(layer.error).toMatch(
        new RegExp(
          `^verify URL http://127\\.0\\.0\\.1:\\d+/version at revision \\(2\\.3\\.4\\): ` +
            `the stack reported "${stale}", expected ${commitOf("2.3.4")}$`,
        ),
      );
      expect(existsSync(stopMarker)).toBe(true);
      expect(existsSync(join(scratch, "logs", "behaviour", "check-test-base.log"))).toBe(false);
    });

    it("accepts a short commit printed by a verify command at the stack's side", async () => {
      const { layer } = await check({
        start: START,
        test: TEST,
        verify: { run: `node -e "console.log('revision ' + process.env.COMPAT_COMMIT.slice(0, 7))"` },
      });
      expect(layer.status).toBe("ran");
      expect(layer.notes).toContain(
        `verified the stack runs revision (2.3.4, ${commitOf("2.3.4").slice(0, 12)}): it reported ${commitOf("2.3.4")}`,
      );
    });

    it("expands {ref} and names the log of a verify command that reports something else", async () => {
      const { layer } = await check({
        start: START,
        test: TEST,
        verify: { run: "echo 2.2.4", expect: "{ref}" },
      });
      const log = join(scratch, "logs", "behaviour", "check-verify-revision.log");
      expect(layer.status).toBe("failed");
      expect(layer.error).toBe(
        `verify command at revision (2.3.4): the stack reported "2.2.4", expected 2.3.4; full output in ${log}`,
      );
      expect(layer.outputs).toEqual([
        {
          command: 'verify command at revision (2.3.4): the stack reported "2.2.4", expected 2.3.4',
          tail: "2.2.4",
          log,
        },
      ]);
    });

    it("verifies the baseline stack against the test side's commit", async () => {
      const { layer } = await check(
        { start: START, test: TEST, baseline: true, verify: { url: "http://127.0.0.1:{port}/version" } },
        { env: { STALE_REVISION: "0000000" } },
      );
      expect(layer.status).toBe("failed");
      expect(layer.error).toMatch(
        /^baseline: verify URL \S+ at base \(2\.2\.4\): the stack reported "0000000", expected [0-9a-f]{40}$/,
      );
    });
  });

  it("does not run collect when every test passes", async () => {
    const order = join(scratch, "order");
    const { layer } = await check(
      {
        start: START,
        test: TEST,
        collect: { run: `node -e "require('fs').writeFileSync(process.env.ORDER_FILE, 'collect')"` },
      },
      { revision: "2.3.5", env: { ORDER_FILE: order } },
    );
    expect(layer.status).toBe("ran");
    expect(existsSync(order)).toBe(false);
  });
});
