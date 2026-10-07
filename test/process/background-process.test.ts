import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findFreePort,
  startBackgroundProcess,
  withBackgroundProcess,
} from "../../src/process/background-process.js";
import { ok } from "../../src/result.js";
import { isProcessAlive } from "../helpers/process-state.js";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "compat-background-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.trim() !== "") return text;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${path} was never written`);
}

describe("startBackgroundProcess", () => {
  it("stops a process that ignores SIGTERM together with its grandchild", async () => {
    const pids = join(workDir, "pids");
    const started = await startBackgroundProcess({
      command: `trap '' TERM; sleep 60 & echo "$$ $!" > "${pids}"; wait`,
      stopGraceMs: 300,
    });
    if (!started.ok) throw new Error(started.error);
    const [shell, grandchild] = (await waitForFile(pids)).trim().split(" ").map(Number) as [number, number];
    expect(isProcessAlive(shell)).toBe(true);
    expect(isProcessAlive(grandchild)).toBe(true);

    const stopping = Date.now();
    await started.value.stop();
    expect(Date.now() - stopping).toBeLessThan(5_000);
    expect(isProcessAlive(shell)).toBe(false);
    expect(isProcessAlive(grandchild)).toBe(false);
    expect(started.value.getExit()).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("keeps the interleaved output and reports how the process exited", async () => {
    const started = await startBackgroundProcess({ command: "echo out; echo err >&2; exit 3" });
    if (!started.ok) throw new Error(started.error);
    for (let attempt = 0; attempt < 100 && started.value.getExit() === null; attempt += 1) {
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(started.value.getExit()).toEqual({ code: 3, signal: null });
    await started.value.stop();
    expect(started.value.getOutput()).toBe("out\nerr\n");
  });

  it("stops once even when stop is called twice", async () => {
    const started = await startBackgroundProcess({ command: "sleep 60" });
    if (!started.ok) throw new Error(started.error);
    await Promise.all([started.value.stop(), started.value.stop()]);
    expect(started.value.getExit()).not.toBeNull();
  });
});

describe("withBackgroundProcess", () => {
  it("returns the result of the callback and stops the process afterwards", async () => {
    let pid = 0;
    const result = await withBackgroundProcess({ command: "sleep 60" }, async (started) => {
      pid = started.pid;
      return ok("done");
    });
    expect(result).toEqual({ ok: true, value: "done" });
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("stops the process when the callback throws", async () => {
    let pid = 0;
    await expect(
      withBackgroundProcess({ command: "sleep 60" }, async (started) => {
        pid = started.pid;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe("findFreePort", () => {
  it("never returns the same port twice in one run", async () => {
    const ports = await Promise.all(Array.from({ length: 10 }, () => findFreePort()));
    const values = ports.map((port) => (port.ok ? port.value : 0));
    expect(values.every((port) => port > 0)).toBe(true);
    expect(new Set(values).size).toBe(10);
  });
});
