import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/process/run-process.js";

describe("runProcess", () => {
  it("returns stdout, stderr and a non-zero exit code without failing", async () => {
    expect(await runProcess({ command: "echo out; echo err >&2; exit 3", shell: true })).toEqual({
      ok: true,
      value: { exitCode: 3, stdout: "out\n", stderr: "err\n" },
    });
  });

  it("reports a missing binary as spawn-failed", async () => {
    const result = await runProcess({ command: "/nonexistent/binary" });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "spawn-failed", code: "ENOENT" }),
    });
  });

  it("stops a grandchild on timeout and returns quickly", async () => {
    const started = Date.now();
    const result = await runProcess({ command: "sleep 30 & wait", shell: true, timeoutMs: 500 });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "timed-out", timeoutMs: 500 }),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("returns when the process exits although a background child still holds the pipes", async () => {
    const started = Date.now();
    const result = await runProcess({ command: "sleep 30 & echo built", shell: true, timeoutMs: 20_000 });
    expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: "built\n", stderr: "" } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
