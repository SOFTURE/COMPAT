// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DEPENDENCY_IGNORE } from "../../src/commands/init-selection.js";
import { parseConfig } from "../../src/config/config.js";
import { LAYERS } from "../../src/layers/registry.js";
import { main } from "../../src/main.js";
import type { FetchFn } from "../../src/resolve/github.js";
import { createFakeGitHub, GITHUB_ENV } from "../helpers/fake-github.js";
import { createRepo, type TestRepo, writeRepoFile } from "../helpers/git-repo.js";
import { createIo } from "../helpers/stub-layer.js";

type Written = {
  check?: Record<string, string>;
  layers: Record<string, Record<string, unknown> & { enabled?: boolean }>;
};

/** The test runner's own GitHub variables must not reach the deployment lookup. */
const {
  GITHUB_REPOSITORY: _repository,
  GH_TOKEN: _ghToken,
  GITHUB_TOKEN: _token,
  ...OFFLINE_ENV
} = process.env;

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
  return initWith(repo, { env: OFFLINE_ENV }, ...extra);
}

async function initWith(
  repo: TestRepo,
  github: { env: NodeJS.ProcessEnv; fetch?: FetchFn },
  ...extra: string[]
) {
  const run = createIo(repo.dir);
  const exitCode = await main(["init", ...extra], { ...run.io, ...github });
  const path = join(repo.dir, "compat.config.json");
  const written = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Written) : null;
  return { exitCode, written, stderr: run.stderr(), stdout: run.stdout() };
}

const EF_POSTGRES = `CREATE TABLE IF NOT EXISTS "__EFMigrationsHistory" ("MigrationId" character varying(150) NOT NULL);\n`;
const EF_SQLSERVER = `IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL\nBEGIN\n    CREATE TABLE [__EFMigrationsHistory] ([MigrationId] nvarchar(150) NOT NULL);\nEND;\nGO\n`;

const DEPLOY_REPO: Record<string, string> = {
  "APP/docker-compose.yml":
    "services:\n  api:\n    environment:\n      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET}\n",
  "VPS/DOCKER/PROD/docker-compose.yml": "services:\n  api:\n    environment:\n      API_KEY: ${API_KEY}\n",
  "VPS/ANSIBLE/roles/app/templates/app.env.j2": "# generated\nAPI_KEY={{ api_key }}\n",
  "VPS/ANSIBLE/roles/app/defaults/main.yml": "api_key: \"{{ lookup('env', 'API_KEY') }}\"\n",
  "VPS/ANSIBLE/roles/app/tasks/main.yml": [
    "- name: Check the configuration",
    "  ansible.builtin.assert:",
    "    that:",
    "      - api_key | length > 0",
    "- ansible.builtin.copy:",
    '    src: "{{ playbook_dir }}/../DOCKER/PROD/docker-compose.yml"',
    "    dest: /opt/app/docker-compose.yml",
    "",
  ].join("\n"),
  ".github/workflows/deploy.yml": [
    "jobs:",
    "  deploy:",
    "    environment: production",
    "    steps:",
    "      - run: ansible-playbook VPS/ANSIBLE/site.yml",
    "        env:",
    "          API_KEY: ${{ secrets.API_KEY }}",
    "          token: ${{ secrets.GITHUB_TOKEN }}",
    "",
  ].join("\n"),
};

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
    expect(written?.check).toEqual({ base: "latest-tag", revision: "HEAD", failOn: "breaking" });
    expect(stderr).toContain(
      "check compares latest-tag with HEAD: GitHub not read: cannot tell the GitHub repository",
    );
    expect(stderr).toMatch(/then run:\n {2}softure-compat check\n$/);
  });

  it("enables dependencies for the package manifests it finds, skipping node_modules", async () => {
    const repo = repoWith({
      "APP/Directory.Packages.props": "<Project />\n",
      "web/node_modules/pkg/package.json": "{}",
    });
    const { written } = await init(repo);
    expect(written?.layers.dependencies).toEqual({
      sources: [{ kind: "nuget" }],
      ignore: DEFAULT_DEPENDENCY_IGNORE,
    });
  });

  it("skips React Native and Expo apps in dependencies and writes no NuGet ignore without NuGet", async () => {
    const repo = repoWith({
      "APP/WEB/package.json": '{ "dependencies": { "next": "15.0.0" } }\n',
      "APP/MOBILE/B2C/package.json": '{ "dependencies": { "expo": "52.0.0" } }\n',
      "APP/MOBILE/B2B/package.json": '{ "devDependencies": { "react-native": "0.76.0" } }\n',
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers.dependencies).toEqual({
      sources: [{ kind: "npm", files: ["APP/WEB/package.json"] }],
    });
    expect(stderr).toContain(
      "skipped React Native/Expo apps APP/MOBILE/B2B/package.json, APP/MOBILE/B2C/package.json",
    );
  });

  it("disables dependencies when the only package.json is a mobile app, and says so", async () => {
    const repo = repoWith({ "app/package.json": '{ "dependencies": { "expo": "52.0.0" } }\n' });
    const { written, stderr } = await init(repo);
    expect(written?.layers.dependencies?.enabled).toBe(false);
    expect(stderr).toContain("skipped React Native/Expo apps app/package.json");
  });

  const WEB = (packages: string) =>
    `<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup>${packages}</ItemGroup></Project>\n`;
  const SWAGGER = '<PackageReference Include="Swashbuckle.AspNetCore" />';
  const FAST_SWAGGER = '<PackageReference Include="FastEndpoints.Swagger" Version="6.0.0" />';
  const serve = (path: string, build = "") => ({
    kind: "serve",
    run: `dotnet run${build} --no-launch-profile --project ${path}`,
    url: "http://127.0.0.1:{port}/swagger/v1/swagger.json",
    env: { ASPNETCORE_URLS: "http://127.0.0.1:{port}", ASPNETCORE_ENVIRONMENT: "Development" },
    timeoutSeconds: 300,
  });
  const NO_CALL = "no SwaggerDocument()/AddSwaggerGen()/AddOpenApiDocument()/MapOpenApi() call";

  it("proposes a disabled serve source for executable projects that register a spec, and builds them once per solution", async () => {
    const repo = repoWith({
      "App.slnx":
        '<Solution><Project Path="src/Api/Api.csproj" /><Project Path="src/Admin/Admin.csproj" /></Solution>\n',
      "src/Api/Api.csproj": WEB(SWAGGER),
      "src/Api/Program.cs": "builder.Services.AddSwaggerGen();\n",
      "src/Admin/Admin.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>${FAST_SWAGGER}</Project>\n`,
      "src/Admin/Startup/Swagger.cs": "services.SwaggerDocument(o => {});\n",
      "src/Domain/Domain.csproj": "<Project />\n",
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers.openapi).toEqual({
      enabled: false,
      setup: { run: "dotnet build App.slnx -c Debug" },
      apis: [
        { name: "Admin", source: serve("src/Admin/Admin.csproj", " --no-build") },
        { name: "Api", source: serve("src/Api/Api.csproj", " --no-build") },
      ],
    });
    expect(parseConfig(written, LAYERS, "compat.config.json").ok).toBe(true);
    expect(stderr).toContain(
      "openapi disabled: src/Admin/Admin.csproj, src/Api/Api.csproj serve the spec at runtime; check the serve sources (URL, headers), then enable the layer",
    );
  });

  it("leaves out class libraries and executables without a spec registration, naming each", async () => {
    const repo = repoWith({
      "SHARED/Common/Common.csproj": `<Project Sdk="Microsoft.NET.Sdk">${FAST_SWAGGER}</Project>\n`,
      "SHARED/Common/SwaggerSetup.cs": "services.SwaggerDocument();\n",
      "src/Public/Public.csproj": `<Project><Sdk Name="Microsoft.NET.Sdk.Web" />${FAST_SWAGGER}</Project>\n`,
      "src/Public/Program.cs": "builder.Services.SwaggerDocument();\n",
      "src/Internal/Internal.csproj": WEB(FAST_SWAGGER),
      "src/Internal/Program.cs": "builder.Services.AddFastEndpoints();\n",
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers.openapi).toEqual({
      enabled: false,
      apis: [{ name: "Public", source: serve("src/Public/Public.csproj") }],
    });
    expect(stderr).toContain(
      `openapi disabled: src/Public/Public.csproj serve the spec at runtime; left out: SHARED/Common/Common.csproj (class library), src/Internal/Internal.csproj (${NO_CALL}); check the serve sources`,
    );
  });

  it("does not count a nested project's files as the outer project's spec registration", async () => {
    const repo = repoWith({
      "Api.csproj": WEB(SWAGGER),
      "Program.cs": "app.Run();\n",
      "tools/Gen/Gen.csproj": WEB(SWAGGER),
      "tools/Gen/Program.cs": "builder.Services.AddOpenApiDocument();\n",
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers.openapi).toEqual({
      enabled: false,
      apis: [{ name: "Gen", source: serve("tools/Gen/Gen.csproj") }],
    });
    expect(stderr).toContain(`left out: Api.csproj (${NO_CALL})`);
  });

  it("keeps every executable candidate when none registers a spec in its own files", async () => {
    const repo = repoWith({
      "src/A/A.csproj": WEB(SWAGGER),
      "src/B/B.csproj": WEB(SWAGGER),
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers.openapi).toEqual({
      enabled: false,
      apis: [
        { name: "A", source: serve("src/A/A.csproj") },
        { name: "B", source: serve("src/B/B.csproj") },
      ],
    });
    expect(stderr).toContain(
      "src/A/A.csproj, src/B/B.csproj serve the spec at runtime; none registers a spec in its own files, so all executable ones are kept;",
    );
  });

  it("picks the deepest solution that lists every API and skips solutions that miss one", async () => {
    const repo = repoWith({
      "All.sln":
        'Project("{X}") = "A", "APP\\src\\A\\A.csproj"\nProject("{X}") = "B", "APP\\src\\B\\B.csproj"\n',
      "APP/App.sln": 'Project("{X}") = "A", "src\\A\\A.csproj"\nProject("{X}") = "B", "src\\B\\B.csproj"\n',
      "APP/Only.slnx": '<Solution><Project Path="src/A/A.csproj" /></Solution>\n',
      "APP/src/A/A.csproj": WEB(SWAGGER),
      "APP/src/A/Program.cs": "MapOpenApi();\n",
      "APP/src/B/B.csproj": WEB(SWAGGER),
      "APP/src/B/Program.cs": "MapOpenApi();\n",
    });
    const { written } = await init(repo);
    expect(written?.layers.openapi).toHaveProperty("setup", { run: "dotnet build APP/App.sln -c Debug" });
  });

  it("writes no setup for several APIs when no solution lists them all, nor for a single API", async () => {
    const several = repoWith({
      "App.slnx": '<Solution><Project Path="src/A/A.csproj" /></Solution>\n',
      "src/A/A.csproj": WEB(SWAGGER),
      "src/B/B.csproj": WEB(SWAGGER),
    });
    const single = repoWith({
      "App.slnx": '<Solution><Project Path="src/A/A.csproj" /></Solution>\n',
      "src/A/A.csproj": WEB(SWAGGER),
    });
    const { written: severalWritten } = await init(several);
    const { written: singleWritten } = await init(single);
    expect(severalWritten?.layers.openapi).not.toHaveProperty("setup");
    expect(singleWritten?.layers.openapi).toEqual({
      enabled: false,
      apis: [{ name: "A", source: serve("src/A/A.csproj") }],
    });
  });

  it("falls back to the command example when every referencing project is a class library", async () => {
    const repo = repoWith({
      "src/Common/Common.csproj": `<Project Sdk="Microsoft.NET.Sdk">${SWAGGER}</Project>\n`,
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers.openapi).toEqual({
      enabled: false,
      apis: [
        { name: "api", source: { kind: "command", run: "npm run export:openapi", output: "openapi.json" } },
      ],
    });
    expect(stderr).toContain("; left out: src/Common/Common.csproj (class library)\n");
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

  it("leaves out compose and .env files of tests and mobile apps", async () => {
    const repo = repoWith({
      "APP/docker-compose.yml": "services: {}\n",
      "VPS/DOCKER/TESTS/docker-compose.integration-tests.yml": "services: {}\n",
      "deploy/compose.e2e.yml": "services: {}\n",
      "APP/API/.env.example": "A=\n",
      "APP/MOBILE/B2C/.env.example": "EXPO_PUBLIC_API=\n",
      "APP/MOBILE/B2C/package.json": '{ "dependencies": { "expo": "52.0.0" } }\n',
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers.config).toEqual({
      sources: [
        { kind: "compose", files: ["APP/docker-compose.yml"] },
        { kind: "dotenv", files: ["APP/API/.env.example"] },
      ],
    });
    expect(stderr).toContain(
      "skipped test files VPS/DOCKER/TESTS/docker-compose.integration-tests.yml, deploy/compose.e2e.yml",
    );
    expect(stderr).toContain("mobile app files APP/MOBILE/B2C/.env.example");
  });

  it("reads the deploy chain: Ansible and workflow regex sources, a chain with the assert required, presence", async () => {
    const repo = repoWith(DEPLOY_REPO);
    const { written, stderr } = await init(repo);
    expect(written?.layers.config).toEqual({
      sources: [
        { kind: "compose", files: ["VPS/DOCKER/PROD/docker-compose.yml"] },
        {
          kind: "regex",
          name: "ansible-template",
          files: ["VPS/ANSIBLE/roles/app/templates/app.env.j2"],
          pattern: "^[ \\t]*(?:export[ \\t]+)?(?<key>[A-Za-z_][A-Za-z0-9_]*)[ \\t]*=[ \\t]*[\"']?\\{\\{",
          flags: "m",
          comments: "hash",
        },
        {
          kind: "regex",
          name: "ansible-env",
          files: ["VPS/ANSIBLE/roles/app/defaults/main.yml"],
          pattern: "lookup\\([ \\t]*[\"']env[\"'][ \\t]*,[ \\t]*[\"'](?<key>[A-Za-z_][A-Za-z0-9_]*)[\"']",
          flags: "",
          comments: "hash",
        },
        {
          kind: "regex",
          name: "ansible-assert",
          files: ["VPS/ANSIBLE/roles/app/tasks/main.yml"],
          pattern:
            "^[ \\t]*-[ \\t]*[\"']?(?<key>[A-Za-z_][A-Za-z0-9_]*)[ \\t]*(?:\\|[ \\t]*length[ \\t]*>[ \\t]*0|is[ \\t]+defined)",
          flags: "m",
          comments: "hash",
        },
        {
          kind: "regex",
          name: "workflow-secrets",
          files: [".github/workflows/deploy.yml"],
          pattern: "^[ \\t]*(?<key>[A-Z][A-Z0-9_]*)[ \\t]*:[ \\t]*[\"']?\\$\\{\\{[ \\t]*secrets\\.",
          flags: "m",
          comments: "hash",
        },
      ],
      chains: [
        {
          name: "deploy",
          sources: ["compose", "ansible-template", "ansible-env", "workflow-secrets"],
          required: ["ansible-assert"],
        },
      ],
      presence: { run: "gh secret list --env production --json name --jq '.[].name'" },
    });
    expect(parseConfig(written, LAYERS, "compat.config.json").ok).toBe(true);
    expect(stderr).toContain("compose files the deploy does not use APP/docker-compose.yml");
  });

  it("matches a bare compose file name to the nearest file and reads project_src folders", async () => {
    const repo = repoWith({
      "APP/docker-compose.yml": "services: {}\n",
      "ops/files/docker-compose.yml": "services: {}\n",
      "ops/stack/compose.yaml": "services: {}\n",
      "ops/roles/app/tasks/main.yml": [
        "- ansible.builtin.copy:",
        "    src: docker-compose.yml",
        "    dest: /opt/app/docker-compose.yml",
        "- community.docker.docker_compose_v2:",
        '    project_src: "{{ repo_dir }}/ops/stack"',
        "",
      ].join("\n"),
    });
    const { written } = await init(repo);
    expect(written?.layers.config).toEqual({
      sources: [{ kind: "compose", files: ["ops/files/docker-compose.yml", "ops/stack/compose.yaml"] }],
    });
  });

  it("gives a deploy chain that check runs: a key added to the template but not to the assert breaks", async () => {
    const { ".github/workflows/deploy.yml": _workflow, ...withoutWorkflow } = DEPLOY_REPO;
    const repo = repoWith(withoutWorkflow);
    expect((await init(repo)).exitCode).toBe(0);
    writeRepoFile(
      repo,
      "VPS/ANSIBLE/roles/app/templates/app.env.j2",
      "API_KEY={{ api_key }}\nNEW_KEY={{ new_key }}\n",
    );
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "v2");
    const run = createIo(repo.dir);
    const exitCode = await main(["check", "--base", "v1", "--revision", "HEAD", "--format", "json"], run.io);
    const report = JSON.parse(run.stdout()) as {
      layers: { layer: string; status: string; findings: { subject: string; id: string; class: string }[] }[];
    };
    const config = report.layers.find((layer) => layer.layer === "config");
    expect(config?.status).toBe("ran");
    const chain = config?.findings.filter((finding) => finding.id === "config-chain-missing") ?? [];
    expect(chain.map((finding) => `${finding.subject} ${finding.class}`)).toContain("NEW_KEY breaking");
    expect(exitCode).toBe(1);
  });

  it("enables message contracts with one glob per contract folder, ignoring build output", async () => {
    const none = repoWith({ "src/App/Program.cs": "class Program { }\n" });
    expect((await init(none)).written?.layers["message-contracts"]?.enabled).toBe(false);
    const repo = repoWith({
      "src/PETSEO.Contract.Internal.Messages/Broadcasts/Started.cs": "public record Started(int X);\n",
      "src/PETSEO.Contract.Internal.Messages/bin/Debug/Gen.cs": "public record Gen(int X);\n",
      "src/Worker/Messages/Done.cs": "public record Done(int X);\n",
      "tests/Orders.Contracts.Tests/Fixtures.cs": "public class Fixtures { }\n",
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

  it("keeps only contract folders whose types travel through the broker (issue #45)", async () => {
    const repo = repoWith({
      "src/PETSEO.Contract.Internal.Messages/Started.cs": "public record Started(int X);\n",
      "src/PETSEO.Contract.B2C.Internal.Requests/AddMedicationRequest.cs":
        "public record AddMedicationRequest(List<DayOfWeek>? DaysOfWeek);\n",
      "src/PETSEO.Contract.Internal.Requests/GetPetRequest.cs": "public record GetPetRequest(Guid Id);\n",
      "src/Billing.Contracts/Invoices/InvoicePaid.cs":
        "public sealed class InvoicePaid { public int Id { get; set; } }\n",
      "src/Billing.Contracts/Invoices/InvoiceDto.cs": "public sealed class InvoiceDto { }\n",
      "src/Orders.Contracts/OrderShipped.cs": "public record OrderShipped(int Id);\n",
      "src/Worker/InvoicePaidConsumer.cs":
        "public class InvoicePaidConsumer : IConsumer<InvoicePaid> { public Task Consume(ConsumeContext<InvoicePaid> context) => Task.CompletedTask; }\n",
      "src/Api/Orders.cs": "await bus.Publish(new Orders.OrderShipped(1));\n",
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers["message-contracts"]).toEqual({
      sources: [
        {
          name: "contracts",
          language: "csharp",
          files: [
            "src/Billing.Contracts/**/*.cs",
            "src/Orders.Contracts/**/*.cs",
            "src/PETSEO.Contract.Internal.Messages/**/*.cs",
          ],
        },
      ],
    });
    expect(stderr).toContain(
      "skipped: no IConsumer<T>, ConsumeContext<T>, IRequestClient<T>, Publish or Send names a type of src/PETSEO.Contract.B2C.Internal.Requests, src/PETSEO.Contract.Internal.Requests",
    );
  });

  it("writes message contracts disabled when no contract folder is used by the broker", async () => {
    const repo = repoWith({
      "src/Shop.Contract.Requests/CreateOrderRequest.cs": "public record CreateOrderRequest(int Id);\n",
      "src/Shop.Api/Endpoint.cs": "public class Endpoint { void Send<T>(T value) { } }\n",
    });
    const { written, stderr } = await init(repo);
    expect(written?.layers["message-contracts"]).toEqual({
      enabled: false,
      sources: [{ name: "contracts", language: "csharp", files: ["src/Shop.Contract.Requests/**/*.cs"] }],
    });
    expect(stderr).toContain("message-contracts disabled: no IConsumer<T>");
    expect(stderr).toContain("enable the layer if these types travel through a broker");
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
      layers: { layer: string; status: string; findings: { subject: string; id: string }[] }[];
    };
    expect(report.layers.filter((layer) => layer.status !== "disabled").map((layer) => layer.layer)).toEqual([
      "config",
    ]);
    expect(report.layers[0]?.findings.map((finding) => `${finding.subject} ${finding.id}`)).toEqual([
      "B config-key-added-required",
    ]);
  });

  describe("check defaults from GitHub deployments", () => {
    const DEPLOYMENTS = "/deployments?per_page=100";
    const success = [{ state: "success" }];

    it("compares the two most recently deployed environments, the one named like production as the base", async () => {
      const github = createFakeGitHub({
        [DEPLOYMENTS]: [
          { id: 5, environment: "production" },
          { id: 4, environment: "dev" },
          { id: 3, environment: "production" },
          { id: 2, environment: "staging" },
        ],
        "/deployments/5/statuses?per_page=1": success,
        "/deployments/4/statuses?per_page=1": success,
      });
      const { written, stderr } = await initWith(repoWith({ "README.md": "" }), {
        env: GITHUB_ENV,
        fetch: github.fetch,
      });
      expect(written?.check).toEqual({
        base: "github-deployment:production",
        revision: "github-deployment:dev",
        failOn: "breaking",
      });
      expect(github.calls).toEqual([
        DEPLOYMENTS,
        "/deployments/5/statuses?per_page=1",
        "/deployments/4/statuses?per_page=1",
      ]);
      expect(stderr).toContain('"production" is taken as production');
    });

    it("takes the less recently deployed environment as the base when no name says production", async () => {
      const github = createFakeGitHub({
        [DEPLOYMENTS]: [
          { id: 3, environment: "dev" },
          { id: 2, environment: "test" },
          { id: 1, environment: "live" },
        ],
        "/deployments/3/statuses?per_page=1": success,
        "/deployments/2/statuses?per_page=1": [{ state: "failure" }],
        "/deployments/1/statuses?per_page=1": success,
      });
      const { written } = await initWith(repoWith({ "README.md": "" }), {
        env: GITHUB_ENV,
        fetch: github.fetch,
      });
      expect(written?.check).toMatchObject({
        base: "github-deployment:live",
        revision: "github-deployment:dev",
      });
    });

    it("compares the only deployed environment with HEAD", async () => {
      const github = createFakeGitHub({
        [DEPLOYMENTS]: [{ id: 1, environment: "prod" }],
        "/deployments/1/statuses?per_page=1": success,
      });
      const { written } = await initWith(repoWith({ "README.md": "" }), {
        env: GITHUB_ENV,
        fetch: github.fetch,
      });
      expect(written?.check).toMatchObject({ base: "github-deployment:prod", revision: "HEAD" });
    });

    it("falls back to the newest tag when no environment has a successful deployment", async () => {
      const github = createFakeGitHub({ [DEPLOYMENTS]: [] });
      const { exitCode, written, stderr } = await initWith(repoWith({ "README.md": "" }), {
        env: GITHUB_ENV,
        fetch: github.fetch,
      });
      expect(exitCode).toBe(0);
      expect(written?.check).toMatchObject({ base: "latest-tag", revision: "HEAD" });
      expect(stderr).toContain("no GitHub environment has a successful deployment");
    });

    it("still writes the config when GitHub answers with an error", async () => {
      const github = createFakeGitHub({ [DEPLOYMENTS]: 403 });
      const { exitCode, written, stderr } = await initWith(repoWith({ "README.md": "" }), {
        env: GITHUB_ENV,
        fetch: github.fetch,
      });
      expect(exitCode).toBe(0);
      expect(written?.check).toMatchObject({ base: "latest-tag", revision: "HEAD" });
      expect(stderr).toContain("GitHub not read: GET");
      expect(stderr).toContain("returned HTTP 403");
    });
  });
});
