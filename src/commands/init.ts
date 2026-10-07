import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, posix, resolve } from "node:path";
import { DEFAULT_CONFIG_FILE, parseConfig } from "../config/config.js";
import { openRefTree, type RefTree, resolveRepoRoot } from "../git/ref-tree.js";
import { DEFAULT_COMPOSE_FILES, DEFAULT_DOTENV_FILES } from "../layers/config/config.js";
import { DEFAULT_NPM_FILES, DEFAULT_NUGET_FILES } from "../layers/dependencies/config.js";
import { LAYERS } from "../layers/registry.js";
import { err, ok, type Result } from "../result.js";
import type { SqlDialect } from "../sql/statements.js";
import { type CheckIo, EXIT_CANNOT_RUN } from "./check.js";

export type InitOptions = {
  repoDir?: string;
  /** Where to write the config; relative to the current directory. Default: `<repoDir>/compat.config.json`, as for `check`. */
  configPath?: string;
  force: boolean;
};

/** One layer of the starter config: detected inputs enable it, otherwise it carries a disabled example. */
export type StarterLayer = {
  name: string;
  config: Record<string, unknown>;
  /** What was found, or why the layer is disabled; printed to stderr. */
  summary: string;
  enabled: boolean;
};

const IGNORED_SEGMENTS = new Set(["node_modules", "bin", "obj", "dist"]);
const OPENAPI_GLOBS = ["**/{openapi,swagger}*.{json,yaml,yml}"];
/** Packages that serve an OpenAPI spec from a running ASP.NET app. */
const RUNTIME_SPEC_PACKAGE = /Include="(FastEndpoints\.Swagger|NSwag\.AspNetCore|Swashbuckle\.AspNetCore)"/i;
const EF_HISTORY_TABLE = "__EFMigrationsHistory";
const DRIZZLE_POSTGRES_DIALECTS = ["postgresql", "pg"];
const ENUM_CONVENTION = "ConfigureEnum<";
const ENUM_DISCOVERY = {
  kind: "discover",
  files: "**/*DbContext.cs",
  pattern: "ConfigureEnum<(?<name>[\\w.]+)>",
  storage: "string",
};

const CONTRACT_GLOBS = ["**/*Contract*/**/*.cs", "**/*Messages/**/*.cs"];
const CONTRACT_FOLDER = /Contract|Messages$/;
const TEST_FOLDER = /(?:^|\.)Tests?$/i;

const isIgnored = (path: string) => path.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));

/** Repository files matching the globs, without dependency and build output folders. */
async function listSourceFiles(tree: RefTree, globs: string[]): Promise<Result<string[]>> {
  const files = await tree.listFiles(globs);
  return files.ok ? ok(files.value.filter((path) => !isIgnored(path))) : files;
}

/** T-SQL batches (`GO`) or `[dbo]` names mean SQL Server; anything else is read as Postgres. */
export function detectSqlDialect(text: string): SqlDialect {
  return /^[ \t]*GO[ \t]*;?[ \t]*$/im.test(text) || /\[dbo\]/i.test(text) ? "sqlserver" : "postgres";
}

/** A name that satisfies the layers' name rule and is not taken yet; `used` is updated. */
function takeUniqueName(wanted: string, used: Set<string>): string {
  const base = wanted.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "source";
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}`;
  used.add(name);
  return name;
}

const stripExtension = (path: string) => basename(path).replace(/\.[^.]+$/, "");

function disabled(name: string, example: Record<string, unknown>, why: string): StarterLayer {
  return { name, config: { enabled: false, ...example }, summary: why, enabled: false };
}

async function detectOpenapi(tree: RefTree): Promise<Result<StarterLayer>> {
  const specs = await listSourceFiles(tree, OPENAPI_GLOBS);
  if (!specs.ok) return specs;
  if (specs.value.length === 0) return detectServedOpenapi(tree);
  const used = new Set<string>();
  const apis = specs.value.map((path) => {
    const fileName = stripExtension(path);
    const isGenericName = /^(openapi|swagger)$/i.test(fileName);
    const wanted = isGenericName && dirname(path) !== "." ? basename(dirname(path)) : fileName;
    return { name: takeUniqueName(wanted, used), source: { kind: "file", path } };
  });
  return ok({ name: "openapi", config: { apis }, summary: specs.value.join(", "), enabled: true });
}

/**
 * No committed spec: ASP.NET projects that serve their spec at runtime get a disabled `serve`
 * source each, since the command line and URL usually need a review.
 */
async function detectServedOpenapi(tree: RefTree): Promise<Result<StarterLayer>> {
  const projects = await listSourceFiles(tree, ["**/*.csproj"]);
  if (!projects.ok) return projects;
  const served: string[] = [];
  for (const path of projects.value) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    if (text.value !== null && RUNTIME_SPEC_PACKAGE.test(text.value)) served.push(path);
  }
  if (served.length === 0) {
    return ok(
      disabled(
        "openapi",
        {
          apis: [
            {
              name: "api",
              source: { kind: "command", run: "npm run export:openapi", output: "openapi.json" },
            },
          ],
        },
        "no committed openapi*/swagger* spec; set a command that exports the spec at each ref",
      ),
    );
  }
  const used = new Set<string>();
  const apis = served.map((path) => ({
    name: takeUniqueName(stripExtension(path), used),
    source: {
      kind: "serve",
      run: `dotnet run --no-launch-profile --project ${path}`,
      url: "http://127.0.0.1:{port}/swagger/v1/swagger.json",
      env: { ASPNETCORE_URLS: "http://127.0.0.1:{port}", ASPNETCORE_ENVIRONMENT: "Development" },
      timeoutSeconds: 300,
    },
  }));
  return ok(
    disabled(
      "openapi",
      { apis },
      `${served.join(", ")} serve the spec at runtime; check the serve sources (URL, headers), then enable the layer`,
    ),
  );
}

type SqlFile = { path: string; text: string };

async function readSqlFiles(tree: RefTree): Promise<Result<SqlFile[]>> {
  const paths = await listSourceFiles(tree, ["**/*.sql"]);
  if (!paths.ok) return paths;
  const files: SqlFile[] = [];
  for (const path of paths.value) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    if (text.value !== null) files.push({ path, text: text.value });
  }
  return ok(files);
}

async function findDrizzleFolders(tree: RefTree): Promise<Result<string[]>> {
  const journals = await listSourceFiles(tree, ["**/meta/_journal.json"]);
  if (!journals.ok) return journals;
  const folders: string[] = [];
  for (const journal of journals.value) {
    const text = await tree.readFile(journal);
    if (!text.ok) return text;
    let dialect: unknown;
    try {
      dialect = (JSON.parse(text.value ?? "") as { dialect?: unknown }).dialect;
    } catch {
      continue; // Not a drizzle journal we can read; the folder is left for the user to configure.
    }
    if (typeof dialect === "string" && DRIZZLE_POSTGRES_DIALECTS.includes(dialect)) {
      folders.push(posix.dirname(posix.dirname(journal)));
    }
  }
  return ok(folders);
}

function detectSqlMigrations(sqlFiles: SqlFile[], drizzleFolders: string[]): StarterLayer {
  const used = new Set<string>();
  const efScripts = sqlFiles.filter((file) => file.text.includes(EF_HISTORY_TABLE));
  const sources = [
    ...efScripts.map((file) => ({
      name: takeUniqueName(stripExtension(file.path), used),
      dialect: detectSqlDialect(file.text),
      kind: "ef-script",
      path: file.path,
    })),
    ...drizzleFolders.map((folder) => ({
      name: takeUniqueName(posix.basename(folder), used),
      dialect: "postgres",
      kind: "folder",
      path: folder,
    })),
  ];
  if (sources.length === 0) {
    return disabled(
      "sql-migrations",
      { sources: [{ name: "db", dialect: "postgres", kind: "folder", path: "migrations" }] },
      `no EF Core idempotent script (${EF_HISTORY_TABLE}) and no drizzle journal for Postgres`,
    );
  }
  const found = [...efScripts.map((file) => file.path), ...drizzleFolders.map((folder) => `${folder}/`)];
  return { name: "sql-migrations", config: { sources }, summary: found.join(", "), enabled: true };
}

function detectSeed(sqlFiles: SqlFile[], drizzleFolders: string[]): StarterLayer {
  const isMigration = (file: SqlFile) =>
    file.text.includes(EF_HISTORY_TABLE) ||
    drizzleFolders.some((folder) => file.path.startsWith(`${folder}/`));
  const seeds = sqlFiles.filter((file) => /seed/i.test(basename(file.path)) && !isMigration(file));
  if (seeds.length === 0) {
    return disabled(
      "seed",
      { sources: [{ name: "db", dialect: "postgres", files: ["db/seed.sql"] }] },
      "no .sql file named *seed*",
    );
  }
  const byDialect = new Map<SqlDialect, string[]>();
  for (const file of seeds) {
    const dialect = detectSqlDialect(file.text);
    byDialect.set(dialect, [...(byDialect.get(dialect) ?? []), file.path]);
  }
  const sources = [...byDialect.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dialect, files]) => ({ name: byDialect.size === 1 ? "seed" : `seed-${dialect}`, dialect, files }));
  return {
    name: "seed",
    config: { sources },
    summary: seeds.map((file) => file.path).join(", "),
    enabled: true,
  };
}

async function detectPersistedEnums(tree: RefTree): Promise<Result<StarterLayer>> {
  const contexts = await listSourceFiles(tree, [ENUM_DISCOVERY.files]);
  if (!contexts.ok) return contexts;
  const matching: string[] = [];
  for (const path of contexts.value) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    if (text.value?.includes(ENUM_CONVENTION)) matching.push(path);
  }
  const config = { sources: "**/*.cs", enums: [ENUM_DISCOVERY] };
  if (matching.length === 0) {
    return ok(
      disabled(
        "persisted-enums",
        config,
        `no *DbContext.cs calls ${ENUM_CONVENTION}...>; list the enums stored in the database by name or pattern`,
      ),
    );
  }
  return ok({ name: "persisted-enums", config, summary: matching.join(", "), enabled: true });
}

async function detectConfig(tree: RefTree): Promise<Result<StarterLayer>> {
  const compose = await listSourceFiles(tree, DEFAULT_COMPOSE_FILES);
  if (!compose.ok) return compose;
  const dotenv = await listSourceFiles(tree, DEFAULT_DOTENV_FILES);
  if (!dotenv.ok) return dotenv;
  const sources = [
    ...(compose.value.length > 0 ? [{ kind: "compose" }] : []),
    ...(dotenv.value.length > 0 ? [{ kind: "dotenv" }] : []),
  ];
  if (sources.length === 0) {
    return ok(
      disabled(
        "config",
        { sources: [{ kind: "compose" }, { kind: "dotenv" }] },
        "no compose file and no .env example",
      ),
    );
  }
  const found = [...compose.value, ...dotenv.value];
  return ok({ name: "config", config: { sources }, summary: found.join(", "), enabled: true });
}

async function detectDependencies(tree: RefTree): Promise<Result<StarterLayer>> {
  const nuget = await listSourceFiles(tree, DEFAULT_NUGET_FILES);
  if (!nuget.ok) return nuget;
  const npm = await listSourceFiles(tree, DEFAULT_NPM_FILES);
  if (!npm.ok) return npm;
  const sources = [
    ...(nuget.value.length > 0 ? [{ kind: "nuget" }] : []),
    ...(npm.value.length > 0 ? [{ kind: "npm" }] : []),
  ];
  if (sources.length === 0) {
    return ok(
      disabled(
        "dependencies",
        { sources: [{ kind: "nuget" }, { kind: "npm" }] },
        "no MSBuild project or props file and no package.json",
      ),
    );
  }
  const found = [...nuget.value, ...npm.value];
  return ok({ name: "dependencies", config: { sources }, summary: found.join(", "), enabled: true });
}

/** Always disabled: which client builds are live is not in the repository. */
function detectClientUsage(openapi: StarterLayer): StarterLayer {
  const apis = (openapi.config as { apis?: { name: string }[] }).apis;
  const example = {
    clients: [
      {
        name: "mobile",
        api: apis?.[0]?.name ?? "api",
        refs: { tags: "mobile-*" },
        generatedClient: { kind: "typescript", path: "app/api/client.ts" },
      },
    ],
  };
  return disabled(
    "client-usage",
    example,
    "list the live client refs and their generated TypeScript client to re-classify openapi findings by what they call",
  );
}

/** The outermost folder of each C# file under a `*Contract*` or `*Messages` folder. */
async function detectMessageContracts(tree: RefTree): Promise<Result<StarterLayer>> {
  const files = await listSourceFiles(tree, CONTRACT_GLOBS);
  if (!files.ok) return files;
  const folders = new Set<string>();
  for (const path of files.value) {
    const segments = path.split("/");
    const position = segments.findIndex(
      (segment, index) => index < segments.length - 1 && CONTRACT_FOLDER.test(segment),
    );
    if (position !== -1 && !segments.some((segment) => TEST_FOLDER.test(segment)))
      folders.add(segments.slice(0, position + 1).join("/"));
  }
  const globs = [...folders].sort().map((folder) => `${folder}/**/*.cs`);
  if (globs.length === 0) {
    return ok(
      disabled(
        "message-contracts",
        { sources: [{ name: "contracts", language: "csharp", files: "src/**/*.Contracts/**/*.cs" }] },
        "no C# files under a *Contract* or *Messages folder; point a source at your message contracts",
      ),
    );
  }
  return ok({
    name: "message-contracts",
    config: { sources: [{ name: "contracts", language: "csharp", files: globs }] },
    summary: [...folders].sort().join(", "),
    enabled: true,
  });
}

/** Builds the starter config for the committed files of `tree`, one entry per registered layer. */
export async function buildStarterConfig(tree: RefTree): Promise<Result<StarterLayer[]>> {
  const sqlFiles = await readSqlFiles(tree);
  if (!sqlFiles.ok) return sqlFiles;
  const drizzleFolders = await findDrizzleFolders(tree);
  if (!drizzleFolders.ok) return drizzleFolders;
  const openapi = await detectOpenapi(tree);
  if (!openapi.ok) return openapi;
  const persistedEnums = await detectPersistedEnums(tree);
  if (!persistedEnums.ok) return persistedEnums;
  const config = await detectConfig(tree);
  if (!config.ok) return config;
  const dependencies = await detectDependencies(tree);
  if (!dependencies.ok) return dependencies;
  const messageContracts = await detectMessageContracts(tree);
  if (!messageContracts.ok) return messageContracts;
  const detected = [
    openapi.value,
    detectClientUsage(openapi.value),
    detectSqlMigrations(sqlFiles.value, drizzleFolders.value),
    detectSeed(sqlFiles.value, drizzleFolders.value),
    persistedEnums.value,
    config.value,
    dependencies.value,
    messageContracts.value,
  ];
  // Registry order, so the file reads like the report; a layer without a detector would be a bug here.
  const ordered: StarterLayer[] = [];
  for (const layer of LAYERS) {
    const entry = detected.find((item) => item.name === layer.name);
    if (entry === undefined) return err(`init has no starter config for the layer "${layer.name}"`);
    ordered.push(entry);
  }
  return ok(ordered);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes a starter `compat.config.json` for the repository and returns the exit code. */
export async function runInit(options: InitOptions, io: CheckIo): Promise<number> {
  const fail = (message: string) => {
    io.stderr(`softure-compat: ${message}\n`);
    return EXIT_CANNOT_RUN;
  };
  const repoDir = resolve(io.cwd, options.repoDir ?? ".");
  const repoRoot = await resolveRepoRoot(repoDir);
  if (!repoRoot.ok) return fail(repoRoot.error);
  // The same default as `check`, so `init` and `check` started from one directory use one file.
  const configPath =
    options.configPath === undefined
      ? resolve(repoDir, DEFAULT_CONFIG_FILE)
      : resolve(io.cwd, options.configPath);
  if (!options.force && (await exists(configPath))) {
    return fail(`${configPath} already exists; use --force to overwrite it`);
  }

  const tree = await openRefTree({
    repoDir: repoRoot.value,
    ref: "HEAD",
    side: "revision",
    tempRoot: tmpdir(),
  });
  if (!tree.ok) return fail(`init reads the committed files at HEAD, which does not exist yet; commit first`);
  const layers = await buildStarterConfig(tree.value);
  if (!layers.ok) return fail(`cannot read the repository: ${layers.error}`);

  const config = { layers: Object.fromEntries(layers.value.map((layer) => [layer.name, layer.config])) };
  const parsed = parseConfig(config, LAYERS, configPath);
  if (!parsed.ok) return fail(`init built an invalid config, please report it: ${parsed.error}`);

  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    return fail(`cannot write ${configPath} (${(error as NodeJS.ErrnoException).code})`);
  }
  for (const layer of layers.value) {
    io.stderr(`softure-compat: ${layer.name} ${layer.enabled ? "enabled" : "disabled"}: ${layer.summary}\n`);
  }
  io.stderr(
    `softure-compat: wrote ${configPath}\n` +
      'Review it (a disabled layer is turned on by removing its "enabled": false), then run:\n' +
      "  softure-compat check --base <production tag> --revision HEAD\n",
  );
  return 0;
}
