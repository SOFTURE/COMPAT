import { describe, expect, it } from "vitest";
import { openapiConfigSchema } from "../../../src/layers/openapi/config.js";

const api = (source: unknown, extra: object = {}) => ({ name: "b2c", source, ...extra });
const parse = (config: unknown) => openapiConfigSchema.safeParse(config);
const firstIssue = (config: unknown) => {
  const result = parse(config);
  return result.success
    ? undefined
    : `${result.error.issues[0]?.path.join(".")}: ${result.error.issues[0]?.message}`;
};

describe("openapi config", () => {
  it("accepts each source kind", () => {
    expect(parse({ apis: [api({ kind: "file", path: "openapi/b2c.json" })] }).success).toBe(true);
    expect(
      parse({
        apis: [api({ kind: "command", run: "make spec", output: "out/spec.json", timeoutSeconds: 60 })],
      }).success,
    ).toBe(true);
    expect(
      parse({ apis: [api({ kind: "url", base: "https://a.test/s.json", revision: "http://b.test/s.json" })] })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown source kind", () => {
    expect(firstIssue({ apis: [api({ kind: "docker", image: "x" })] })).toMatch(/^apis\.0\.source\.kind: /);
  });

  it("rejects duplicate API names and an empty list", () => {
    const source = { kind: "file", path: "a.json" };
    expect(firstIssue({ apis: [api(source), api(source)] })).toBe("apis: API names must be unique");
    expect(firstIssue({ apis: [] })).toMatch(/^apis: Too small/);
  });

  it("rejects a nested typo", () => {
    expect(firstIssue({ apis: [api({ kind: "file", path: "a.json" }, { acept: [] })] })).toBe(
      'apis.0: Unrecognized key: "acept"',
    );
  });

  it("accepts a setup command and a concurrency of 1 or 2", () => {
    const source = { kind: "file", path: "a.json" };
    const setup = { run: "dotnet build App.slnx", timeoutSeconds: 900 };
    expect(parse({ apis: [api(source)], setup, concurrency: 1 }).success).toBe(true);
    expect(parse({ apis: [api(source)], setup: { run: "make" }, concurrency: 2 }).success).toBe(true);
  });

  it("rejects an empty setup command, a setup typo and a concurrency outside 1..2", () => {
    const source = { kind: "file", path: "a.json" };
    expect(firstIssue({ apis: [api(source)], setup: { run: "" } })).toMatch(/^setup\.run: Too small/);
    expect(firstIssue({ apis: [api(source)], setup: { run: "make", timeout: 5 } })).toBe(
      'setup: Unrecognized key: "timeout"',
    );
    expect(firstIssue({ apis: [api(source)], concurrency: 3 })).toMatch(/^concurrency: Too big/);
    expect(firstIssue({ apis: [api(source)], concurrency: 0 })).toMatch(/^concurrency: Too small/);
  });

  it("rejects paths that leave the repository", () => {
    expect(firstIssue({ apis: [api({ kind: "file", path: "../secrets.json" })] })).toBe(
      "apis.0.source.path: must not contain '..'",
    );
    expect(firstIssue({ apis: [api({ kind: "file", path: "/etc/passwd" })] })).toBe(
      "apis.0.source.path: must be a relative path",
    );
  });

  it("rejects oasdiff args that override the output format or exit code", () => {
    const source = { kind: "file", path: "a.json" };
    expect(firstIssue({ apis: [api(source)], oasdiff: { args: ["--flatten-allof", "--format=yaml"] } })).toBe(
      "oasdiff.args: must not set --format, -f, --fail-on, -o",
    );
    expect(parse({ apis: [api(source)], oasdiff: { args: ["--flatten-allof"] } }).success).toBe(true);
  });

  it("requires accept operations in METHOD /path form", () => {
    const source = { kind: "file", path: "a.json" };
    expect(
      firstIssue({ apis: [api(source, { accept: [{ id: "x", operation: "/api/x", reason: "r" }] })] }),
    ).toBe("apis.0.accept.0.operation: must look like 'POST /api/pets/{petId}'");
  });
});
