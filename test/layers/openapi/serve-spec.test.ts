import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRefTree, type RefTree } from "../../../src/git/ref-tree.js";
import type { ServeSource, SpecSource } from "../../../src/layers/openapi/config.js";
import { openapiLayer } from "../../../src/layers/openapi/openapi-layer.js";
import {
  getServeDisplayPath,
  interpolateHeaders,
  isOpenapiDocument,
} from "../../../src/layers/openapi/serve-spec.js";
import { resolveSpec } from "../../../src/layers/openapi/spec-source.js";
import { createRepo, type TestRepo } from "../../helpers/git-repo.js";
import { FAKE_OASDIFF } from "../../helpers/oasdiff.js";
import { isProcessAlive } from "../../helpers/process-state.js";

/** A literal `${NAME}` header placeholder. */
const variable = (name: string) => `\${${name}}`;
const SERVE_APP = fileURLToPath(new URL("../../helpers/serve-app.mjs", import.meta.url));
const SPEC_URL = "http://127.0.0.1:{port}/swagger/v1/swagger.json";
const BASE_SPEC = '{"openapi":"3.0.3","info":{"title":"b2c","version":"1"},"paths":{}}';
const REVISION_SPEC = '{"openapi":"3.0.3","info":{"title":"b2c","version":"2"},"paths":{}}';

let repo: TestRepo;
let tempRoot: string;
let base: RefTree;
let revision: RefTree;

beforeAll(async () => {
  repo = createRepo([
    { files: { "api/spec.json": BASE_SPEC }, tag: "v1" },
    { files: { "api/spec.json": REVISION_SPEC }, tag: "v2" },
  ]);
  tempRoot = await mkdtemp(join(tmpdir(), "compat-serve-"));
  const opened = await Promise.all([
    openRefTree({ repoDir: repo.dir, ref: "v1", side: "base", tempRoot }),
    openRefTree({ repoDir: repo.dir, ref: "v2", side: "revision", tempRoot }),
  ]);
  if (!opened[0].ok || !opened[1].ok) throw new Error("cannot open refs");
  base = opened[0].value;
  revision = opened[1].value;
});

afterAll(async () => {
  repo.cleanup();
  await rm(tempRoot, { recursive: true, force: true });
});

const serve = (overrides: Partial<ServeSource> = {}): ServeSource => ({
  kind: "serve",
  run: `node "${SERVE_APP}"`,
  url: SPEC_URL,
  env: { APP_PORT: "{port}" },
  timeoutSeconds: 20,
  ...overrides,
});

const resolveAt = (tree: RefTree, source: SpecSource, env: NodeJS.ProcessEnv = {}) =>
  resolveSpec({ source, tree, tempDir: tempRoot, apiName: "b2c", env: { ...process.env, ...env } });

describe("serve spec source", () => {
  it("checks base and revision in parallel, each app on its own port", async () => {
    const log = join(tempRoot, "oasdiff.log");
    const result = await openapiLayer.run({
      config: {
        oasdiff: { path: FAKE_OASDIFF },
        apis: [{ name: "b2c", source: serve({ env: { APP_PORT: "{port}", APP_START_DELAY_MS: "300" } }) }],
      },
      base,
      revision,
      repoDir: repo.dir,
      tempDir: tempRoot,
      env: { ...process.env, FAKE_OASDIFF_MODE: "changes", FAKE_OASDIFF_OUTPUT: "[]", FAKE_OASDIFF_LOG: log },
      log: () => {},
    });
    expect(result).toMatchObject({ layer: "openapi", status: "ran", findings: [] });
    const changelogArgs = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .find((args) => args[0] === "changelog");
    if (!changelogArgs) throw new Error("oasdiff changelog did not run");
    const [baseFile, revisionFile] = changelogArgs.filter((arg) => arg.endsWith(".spec")) as [string, string];
    expect(await readFile(baseFile, "utf8")).toBe(BASE_SPEC);
    expect(await readFile(revisionFile, "utf8")).toBe(REVISION_SPEC);
  });

  it("names the spec by its URL template and passes COMPAT_PORT, the side and the ref", async () => {
    const result = await resolveAt(
      revision,
      serve({
        run: `[ "$COMPAT_SIDE $COMPAT_REF" = "revision v2" ] && APP_PORT=$COMPAT_PORT node "${SERVE_APP}"`,
      }),
    );
    if (!result.ok || result.value.status !== "found") throw new Error(JSON.stringify(result));
    expect(result.value.displayPath).toBe(SPEC_URL);
    expect(result.value.root).toBeNull();
  });

  it("waits for the ready URL before the spec", async () => {
    const result = await resolveAt(base, serve({ ready: "http://127.0.0.1:{port}/hc" }));
    expect(result.ok).toBe(true);
    const failed = await resolveAt(
      base,
      serve({ ready: "http://127.0.0.1:{port}/health", timeoutSeconds: 1 }),
    );
    expect(failed).toEqual({
      ok: false,
      error: expect.stringContaining(
        "serve source at base (v1): http://127.0.0.1:{port}/health not ready after 1 s (last: HTTP 404)",
      ),
    });
  });

  it("sends interpolated headers and reports HTTP 401 without printing them", async () => {
    const env = { APP_API_KEY: "s3cret-value", INTERNAL_API_KEY: "s3cret-value" };
    const secured = serve({ env: { APP_PORT: "{port}", APP_API_KEY: "s3cret-value" } });
    const unauthorized = await resolveAt(base, { ...secured, timeoutSeconds: 1 }, env);
    if (unauthorized.ok) throw new Error("expected a failure");
    expect(unauthorized.error).toMatch(
      /^serve source at base \(v1\): http:\/\/127\.0\.0\.1:\{port\}\/swagger\/v1\/swagger\.json not ready after 1 s \(last: HTTP 401\); app output: listening on \d+$/,
    );
    expect(unauthorized.error).not.toContain("s3cret-value");

    const authorized = await resolveAt(
      base,
      { ...secured, headers: { "X-Internal-Api-Key": variable("INTERNAL_API_KEY") } },
      env,
    );
    if (!authorized.ok || authorized.value.status !== "found") throw new Error(JSON.stringify(authorized));
    expect(await readFile(authorized.value.file, "utf8")).toBe(BASE_SPEC);
  });

  it("fails before starting the app when a header variable is not set", async () => {
    expect(
      await resolveAt(base, serve({ headers: { "X-Internal-Api-Key": variable("COMPAT_TEST_UNSET_KEY") } }), {
        COMPAT_TEST_UNSET_KEY: undefined,
      }),
    ).toEqual({
      ok: false,
      error: `serve source at base (v1): header "X-Internal-Api-Key" uses ${variable("COMPAT_TEST_UNSET_KEY")}, which is not set`,
    });
  });

  it("reports an app that exits before the spec answers, with its output", async () => {
    expect(await resolveAt(revision, serve({ env: { APP_PORT: "{port}", APP_EXIT_CODE: "3" } }))).toEqual({
      ok: false,
      error: `serve source at revision (v2): app exited 3 before ${SPEC_URL} answered (last: connection refused); app output: startup failed: missing connection string`,
    });
  });

  it("leaves no process behind when the app ignores SIGTERM and the spec never appears", async () => {
    const pidFile = join(tempRoot, "app.pid");
    const result = await resolveAt(
      base,
      serve({
        url: "http://127.0.0.1:{port}/missing.json",
        env: { APP_PORT: "{port}", APP_IGNORE_TERM: "1", APP_PID_FILE: pidFile },
        // Long enough for a busy CI runner to boot the app, so the 404 proves it ran and wrote its pid.
        timeoutSeconds: 3,
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(
        "http://127.0.0.1:{port}/missing.json not ready after 3 s (last: HTTP 404)",
      ),
    });
    expect(isProcessAlive(Number(await readFile(pidFile, "utf8")))).toBe(false);
  }, 15_000);
});

describe("serve helpers", () => {
  it("keeps {port} and redacts secrets in the display path", () => {
    expect(getServeDisplayPath("http://127.0.0.1:{port}/swagger.json?key=1")).toBe(
      "http://127.0.0.1:{port}/swagger.json (redacted)",
    );
    expect(getServeDisplayPath("http://localhost:5000/swagger.json")).toBe(
      "http://localhost:5000/swagger.json",
    );
  });

  it("interpolates every variable of a header value", () => {
    expect(
      interpolateHeaders({ Authorization: `Bearer ${variable("A")}.${variable("B")}` }, { A: "x", B: "y" }),
    ).toEqual({
      ok: true,
      value: { Authorization: "Bearer x.y" },
    });
  });

  it("recognises OpenAPI documents in JSON and YAML only", () => {
    expect(isOpenapiDocument('{"openapi":"3.0.3"}')).toBe(true);
    expect(isOpenapiDocument('{"swagger":"2.0"}')).toBe(true);
    expect(isOpenapiDocument("openapi: 3.1.0\ninfo: {}")).toBe(true);
    expect(isOpenapiDocument('{"status":"starting"}')).toBe(false);
    expect(isOpenapiDocument("<html>starting</html>")).toBe(false);
  });
});
