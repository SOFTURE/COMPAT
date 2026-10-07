// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/config.js";
import { LAYERS } from "../../src/layers/registry.js";
import { main } from "../../src/main.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

type Written = { layers: Record<string, Record<string, unknown> & { enabled?: boolean }> };

const repos: TestRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repoWith(files: Record<string, string>): TestRepo {
  const repo = createRepo([{ files, tag: "v1" }]);
  repos.push(repo);
  return repo;
}

async function init(repo: TestRepo, ...extra: string[]) {
  const run = createIo(repo.dir);
  const exitCode = await main(["init", ...extra], run.io);
  const path = join(repo.dir, "compat.config.json");
  const written = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Written) : null;
  return { exitCode, written, stderr: run.stderr(), stdout: run.stdout() };
}

const EF_POSTGRES = `CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory" ("MigrationId" character varying(150) NOT NULL);\n`;
const EF_SQLSERVER = `IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL\nBEGIN\n    CREATE TABLE [__EFMigrationsHistory] ([MigrationId] nvarchar(150) NOT NULL);\nEND;\nGO\n`;

describe("softure-compat init", () => {
  it("writes every layer disabled with an example when nothing is detected, and the file is a valid config", async () => {
    const repo = repoWith({ "README.md": "# app\n" });
    const { exitCode, written, stderr } = await init(repo);
    expect(exitCode).toBe(0);
    expect(Object.keys(written?.layers ?? {})).toEqual(LAYERS.map((layer) => layer.name));
    for (const layer of Object.values(written?.layers ?? {})) expect(layer.enabled).toBe(false);
    expect(parseConfig(written, LAYERS, "compat.config.json").ok).toBe(true);
    expect(stderr).toContain("openapi disabled:");
    expect(stderr).toContain("wrote");
    expect(stderr).toContain("softure-compat check --base <production tag> --revision HEAD");
  });

  it("detects OpenAPI specs and names them after the file or its folder, uniquely", async () => {
    const repo = repoWith({
      "api/b2c/openapi.yaml": "openapi: 3.0.0\n",
      "api/admin/openapi.yaml": "openapi: 3.0.0\n",
      "docs/swagger-public.json": "{}",
      "web/node_modules/pkg/openapi.json": "{}",
      "src/Api/bin/Debug/swagger.json": "{}",
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers.openapi).toEqual({
      apis: [
        { name: "admin", source: { kind: "file", path: "api/admin/openapi.yaml" } },
        { name: "b2c", source: { kind: "file", path: "api/b2c/openapi.yaml" } },
        { name: "swagger-public", source: { kind: "file", path: "docs/swagger-public.json" } },
      ],
    });
    expect(stderr).toContain(
      "openapi enabled: api/admin/openapi.yaml, api/b2c/openapi.yaml, docs/swagger-public.json",
    );
  });

  it("makes colliding API names unique", async () => {
    const repo = repoWith({ "a/api/openapi.json": "{}", "b/api/openapi.json": "{}" });
    const { written } = await init(repo);
    const apis = written?.layers.openapi?.apis as { name: string }[];
    expect(apis.map((api) => api.name)).toEqual(["api", "api-2"]);
  });

  it("detects EF Core idempotent scripts with their dialect", async () => {
    const repo = repoWith({
      "db/pg/migrations.sql": EF_POSTGRES,
      "db/mssql/Scripts/migrations.sql": EF_SQLSERVER,
      "db/other.sql": "SELECT 1;\n",
    });
    const { written } = await init(repo);
    expect(written?.layers["sql-migrations"]).toEqual({
      sources: [
        {
          name: "migrations",
          dialect: "sqlserver",
          kind: "ef-script",
          path: "db/mssql/Scripts/migrations.sql",
        },
        { name: "migrations-2", dialect: "postgres", kind: "ef-script", path: "db/pg/migrations.sql" },
      ],
    });
  });

  it("detects drizzle folders by their journal and skips non-Postgres dialects", async () => {
    const repo = repoWith({
      "drizzle/meta/_journal.json": JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }),
      "drizzle/0000_init.sql": "CREATE TABLE a (id int);\n",
      "legacy/drizzle/meta/_journal.json": JSON.stringify({ version: "5", dialect: "pg", entries: [] }),
      "mysql/drizzle/meta/_journal.json": JSON.stringify({ version: "7", dialect: "mysql", entries: [] }),
      "broken/meta/_journal.json": "{",
    });
    const { written } = await init(repo);
    expect(written?.layers["sql-migrations"]).toEqual({
      sources: [
        { name: "drizzle", dialect: "postgres", kind: "folder", path: "drizzle" },
        { name: "drizzle-2", dialect: "postgres", kind: "folder", path: "legacy/drizzle" },
      ],
    });
  });

  it("detects seed scripts per dialect and leaves migration scripts out", async () => {
    const repo = repoWith({
      "db/seed.sql": "INSERT INTO a (id) VALUES (1) ON CONFLICT (id) DO NOTHING;\n",
      "db/Seeds/SeedData.sql": "INSERT INTO [dbo].[A] ([Id]) VALUES (1)\nGO\n",
      "db/seed-migrations.sql": EF_POSTGRES,
    });
    const { written } = await init(repo);
    expect(written?.layers.seed).toEqual({
      sources: [
        { name: "seed-postgres", dialect: "postgres", files: ["db/seed.sql"] },
        { name: "seed-sqlserver", dialect: "sqlserver", files: ["db/Seeds/SeedData.sql"] },
      ],
    });
    expect(written?.layers["sql-migrations"]?.enabled).toBeUndefined();
  });

  it("names a single-dialect seed source `seed`", async () => {
    const repo = repoWith({ "db/seed.sql": "INSERT INTO a (id) VALUES (1);\n" });
    const { written } = await init(repo);
    expect(written?.layers.seed).toEqual({
      sources: [{ name: "seed", dialect: "postgres", files: ["db/seed.sql"] }],
    });
  });

  it("enables persisted enums only when a DbContext calls ConfigureEnum", async () => {
    const plain = repoWith({ "src/AppDbContext.cs": "class AppDbContext : DbContext { }\n" });
    expect((await init(plain)).written?.layers["persisted-enums"]?.enabled).toBe(false);

    const convention = repoWith({
      "src/AppDbContext.cs": "class AppDbContext : DbContext { void C(B b) { b.ConfigureEnum<Kind>(); } }\n",
    });
    const { written } = await init(convention);
    expect(written?.layers["persisted-enums"]).toEqual({
      sources: "**/*.cs",
      enums: [
        {
          kind: "discover",
          files: "**/*DbContext.cs",
          pattern: "ConfigureEnum<(?<name>[\\w.]+)>",
          storage: "string",
        },
      ],
    });
  });

  it("enables only the config sources that match a file", async () => {
    const composeOnly = repoWith({ "deploy/docker-compose.yml": "services: {}\n" });
    expect((await init(composeOnly)).written?.layers.config).toEqual({ sources: [{ kind: "compose" }] });

    const both = repoWith({ "compose.yaml": "services: {}\n", ".env.example": "A=\n" });
    expect((await init(both)).written?.layers.config).toEqual({
      sources: [{ kind: "compose" }, { kind: "dotenv" }],
    });
  });

  it("enables message contracts with one glob per contract folder, ignoring build output", async () => {
    const none = repoWith({ "src/App/Program.cs": "class Program { }\n" });
    expect((await init(none)).written?.layers["message-contracts"]?.enabled).toBe(false);
    const repo = repoWith({
      "src/PETSEO.Contract.Internal.Messages/Broadcasts/Started.cs": "public record Started(int X);\n",
      "src/PETSEO.Contract.Internal.Messages/bin/Debug/Gen.cs": "public record Gen(int X);\n",
      "src/Worker/Messages/Done.cs": "public record Done(int X);\n",
    });
    const { written } = await init(repo);
    expect(written?.layers["message-contracts"]).toEqual({
      sources: [
        {
          name: "contracts",
          language: "csharp",
          files: ["src/PETSEO.Contract.Internal.Messages/**/*.cs", "src/Worker/Messages/**/*.cs"],
        },
      ],
    });
  });

  it("refuses to overwrite an existing config without --force", async () => {
    const repo = repoWith({ "compose.yaml": "services: {}\n" });
    writeRepoFile(repo, "compat.config.json", "{}\n");
    const refused = await init(repo);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("already exists");
    expect(readFileSync(join(repo.dir, "compat.config.json"), "utf8")).toBe("{}\n");

    const forced = await init(repo, "--force");
    expect(forced.exitCode).toBe(0);
    expect(forced.written?.layers.config).toEqual({ sources: [{ kind: "compose" }] });
  });

  it("writes to --config, relative to the current directory", async () => {
    const repo = repoWith({ "compose.yaml": "services: {}\n" });
    const { exitCode } = await init(repo, "--config", "ops/compat.json");
    expect(exitCode).toBe(2);
    expect(existsSync(join(repo.dir, "ops/compat.json"))).toBe(false);

    mkdirSync(join(repo.dir, "ops"));
    expect((await init(repo, "--config", "ops/compat.json")).exitCode).toBe(0);
    expect(existsSync(join(repo.dir, "ops/compat.json"))).toBe(true);
  });

  it("writes where check reads by default when started from a subdirectory", async () => {
    const repo = repoWith({
      "services/api/compose.yaml": "services:\n  api:\n    environment:\n      A: ${A}\n",
    });
    const subdir = join(repo.dir, "services/api");
    const run = createIo(subdir);
    expect(await main(["init"], run.io)).toBe(0);
    expect(existsSync(join(subdir, "compat.config.json"))).toBe(true);
    expect(existsSync(join(repo.dir, "compat.config.json"))).toBe(false);
    const check = createIo(subdir);
    expect(await main(["check", "--base", "v1", "--revision", "v1"], check.io)).toBe(0);
  });

  it("asks for a commit in a repository without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compat-init-empty-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const run = createIo(dir);
      expect(await main(["init"], run.io)).toBe(2);
      expect(run.stderr()).toContain("commit first");
      expect(existsSync(join(dir, "compat.config.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails outside a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compat-init-nogit-"));
    try {
      const run = createIo(dir);
      expect(await main(["init"], run.io)).toBe(2);
      expect(run.stderr()).toContain("not inside a git repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives a config that check runs: init, commit a change, check", async () => {
    const repo = repoWith({ "compose.yaml": "services:\n  api:\n    environment:\n      A: ${A:-1}\n" });
    expect((await init(repo)).exitCode).toBe(0);
    writeRepoFile(
      repo,
      "compose.yaml",
      "services:\n  api:\n    environment:\n      A: ${A:-1}\n      B: ${B}\n",
    );
    repo.git("add", "compose.yaml");
    repo.git("commit", "-q", "-m", "v2");
    const run = createIo(repo.dir);
    const exitCode = await main(["check", "--base", "v1", "--revision", "HEAD", "--format", "json"], run.io);
    expect(exitCode).toBe(0);
    const report = JSON.parse(run.stdout()) as {
      layers: { layer: string; findings: { subject: string; id: string }[] }[];
    };
    expect(report.layers.map((layer) => layer.layer)).toEqual(["config"]);
    expect(report.layers[0]?.findings.map((finding) => `${finding.subject} ${finding.id}`)).toEqual([
      "B config-key-added-required",
    ]);
  });
});
