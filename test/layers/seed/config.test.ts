import { describe, expect, it } from "vitest";
import { seedConfigSchema } from "../../../src/layers/seed/config.js";

const parse = (config: unknown) => seedConfigSchema.safeParse(config);
const source = (extra: object = {}) => ({
  name: "db",
  dialect: "postgres",
  files: ["db/seed.sql"],
  ...extra,
});

describe("seed config", () => {
  it("accepts a minimal source and accept entries", () => {
    const parsed = parse({
      sources: [source({ accept: [{ id: "update-data", object: "Breeds", reason: "reviewed" }] })],
    });
    expect(parsed.success && parsed.data.sources[0]).toEqual(
      source({ accept: [{ id: "update-data", object: "Breeds", reason: "reviewed" }] }),
    );
  });

  it.each([
    ["an unknown key", { sources: [source({ path: "db/seed.sql" })] }, "sources.0"],
    ["empty files", { sources: [source({ files: [] })] }, "sources.0.files"],
    ["an absolute path", { sources: [source({ files: ["/etc/seed.sql"] })] }, "sources.0.files.0"],
    ["a parent path", { sources: [source({ files: ["../seed.sql"] })] }, "sources.0.files.0"],
    ["duplicate names", { sources: [source(), source()] }, "sources"],
    ["an unknown dialect", { sources: [source({ dialect: "mysql" })] }, "sources.0.dialect"],
    ["no sources", { sources: [] }, "sources"],
    [
      "an accept entry without a reason",
      { sources: [source({ accept: [{ id: "truncate" }] })] },
      "sources.0.accept.0.reason",
    ],
  ])("rejects %s", (_name, config, path) => {
    const parsed = parse(config);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain(path);
  });
});
