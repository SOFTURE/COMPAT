import { symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import type { SpecSource } from "../../../src/layers/openapi/config.js";
import { redactUrl } from "../../../src/layers/openapi/safe-path.js";
import { resolveSpec } from "../../../src/layers/openapi/spec-source.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";

let repo: TestRepo;
let tempRoot: string;
let tree: RefTree;
let server: Server;
let serverUrl: string;

beforeAll(async () => {
  repo = createRepo([
    { files: { "api/b2c.yaml": "openapi: 3.0.3", "tools/export.sh": "echo exported" }, tag: "v1" },
  ]);
  symlinkSync("/etc/hostname", join(repo.dir, "escape.yaml"));
  repo.git("add", "escape.yaml");
  repo.git("commit", "-q", "-m", "symlink");
  repo.git("tag", "v2");
  tempRoot = await mkdtemp(join(tmpdir(), "compat-spec-source-"));
  const opened = await openRefTree({ repoDir: repo.dir, ref: "v2", side: "revision", tempRoot });
  if (!opened.ok) throw new Error(opened.error);
  tree = opened.value;
  server = createServer((request, response) => {
    if (request.url?.startsWith("/spec.json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"openapi":"3.0.3"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

const resolveWith = (source: SpecSource) =>
  resolveSpec({ source, tree, tempDir: tempRoot, apiName: "b2c", env: process.env });

describe("resolveSpec", () => {
  it("finds a file source inside the materialized tree", async () => {
    const result = await resolveWith({ kind: "file", path: "api/b2c.yaml" });
    if (!result.ok || result.value.status !== "found") throw new Error(JSON.stringify(result));
    expect(result.value.displayPath).toBe("api/b2c.yaml");
    expect(result.value.root).not.toBeNull();
    expect(await readFile(result.value.file, "utf8")).toBe("openapi: 3.0.3");
  });

  it("reports an absent file source", async () => {
    expect(await resolveWith({ kind: "file", path: "api/b2b.yaml" })).toEqual({
      ok: true,
      value: { status: "absent", displayPath: "api/b2b.yaml" },
    });
  });

  it("rejects paths and symlinks that leave the tree", async () => {
    expect(await resolveWith({ kind: "file", path: "../outside.yaml" })).toEqual({
      ok: false,
      error: 'path "../outside.yaml" must stay inside the repository',
    });
    expect(await resolveWith({ kind: "file", path: "/etc/hostname" })).toEqual({
      ok: false,
      error: 'path "/etc/hostname" must stay inside the repository',
    });
    expect(await resolveWith({ kind: "file", path: "escape.yaml" })).toEqual({
      ok: false,
      error: 'path "escape.yaml" resolves outside the repository',
    });
  });

  it("runs a command source in the tree with the side, ref and commit in its environment", async () => {
    const result = await resolveWith({
      kind: "command",
      run: 'mkdir -p out && printf "%s %s %s" "$COMPAT_SIDE" "$COMPAT_REF" "$COMPAT_COMMIT" > out/spec.json',
      output: "out/spec.json",
    });
    if (!result.ok || result.value.status !== "found") throw new Error(JSON.stringify(result));
    expect(await readFile(result.value.file, "utf8")).toBe(`revision v2 ${tree.commit}`);
    expect(result.value.displayPath).toBe("out/spec.json");
  });

  it("returns the stderr tail when a command source fails", async () => {
    expect(
      await resolveWith({ kind: "command", run: "echo build failed >&2; exit 4", output: "out.json" }),
    ).toEqual({
      ok: false,
      error: "export command at revision (v2) exited 4: build failed",
    });
  });

  it("fails when a command source does not write its output", async () => {
    expect(await resolveWith({ kind: "command", run: "true", output: "missing.json" })).toEqual({
      ok: false,
      error: "export command at revision (v2) succeeded but did not write missing.json",
    });
  });

  it("fails when a command source times out", async () => {
    const result = await resolveWith({
      kind: "command",
      run: "sleep 5",
      output: "x.json",
      timeoutSeconds: 1,
    });
    expect(result).toEqual({ ok: false, error: "export command at revision (v2) timed out after 1 s" });
  });

  it("downloads a URL source for the tree's side", async () => {
    const result = await resolveWith({
      kind: "url",
      base: `${serverUrl}/nope`,
      revision: `${serverUrl}/spec.json`,
    });
    if (!result.ok || result.value.status !== "found") throw new Error(JSON.stringify(result));
    expect(result.value.root).toBeNull();
    expect(result.value.displayPath).toBe(`${serverUrl}/spec.json`);
    expect(await readFile(result.value.file, "utf8")).toBe('{"openapi":"3.0.3"}');
  });

  it("names the status but not the query token when a URL fails", async () => {
    const result = await resolveWith({
      kind: "url",
      base: "https://x.test",
      revision: `${serverUrl}/missing?token=s3cret`,
    });
    expect(result).toEqual({ ok: false, error: `cannot fetch ${serverUrl}/missing (redacted): HTTP 404` });
  });
});

describe("redactUrl", () => {
  it("drops user info, query and fragment", () => {
    expect(redactUrl("https://user:pass@api.test/swagger.json?key=1#x")).toBe(
      "https://api.test/swagger.json (redacted)",
    );
    expect(redactUrl("https://api.test/swagger.json")).toBe("https://api.test/swagger.json");
    expect(redactUrl("not a url")).toBe("(invalid URL)");
  });
});
