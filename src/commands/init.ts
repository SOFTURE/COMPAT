import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, posix, resolve } from "node:path";
import { DEFAULT_CONFIG_FILE, parseConfig } from "../config/config.js";
import { openRefTree, type RefTree, resolveRepoRoot } from "../git/ref-tree.js";
import { DEFAULT_COMPOSE_FILES, DEFAULT_DOTENV_FILES } from "../layers/config/config.js";
import { DEFAULT_NPM_FILES, DEFAULT_NUGET_FILES } from "../layers/dependencies/config.js";
import { BROKER_GENERIC, BROKER_NEW, readTypeArguments } from "../layers/message-contracts/broker-usage.js";
import { LAYERS } from "../layers/registry.js";
import { guessCheckDefaults } from "../resolve/guess-check-defaults.js";
import { err, ok, type Result } from "../result.js";
import type { SqlDialect } from "../sql/statements.js";
import { type CheckIo, EXIT_CANNOT_RUN } from "./check.js";
import {
  DEFAULT_DEPENDENCY_IGNORE,
  detectDeployChain,
  findMobileApps,
  isInFolderOf,
  isTestPath,
} from "./init-selection.js";

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
/** An SDK-style project that `dotnet run` can start. */
const WEB_SDK = /(?:Sdk="|<Sdk\s+Name=")[^"]*Microsoft\.NET\.Sdk\.Web/i;
const EXE_OUTPUT = /<OutputType>\s*Exe\s*<\/OutputType>/i;
/** Calls that register an OpenAPI document, so the running app actually serves one. */
const SPEC_REGISTRATION_CALLS = ["SwaggerDocument(", "AddSwaggerGen(", "AddOpenApiDocument(", "MapOpenApi("];
const SOLUTION_GLOBS = ["**/*.sln", "**/*.slnx"];
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
/** Folder names that hold broker messages by convention, without a reference to check. */
const BROKER_FOLDER = /(?:Messages|Events)$/;
const TYPE_DECLARATION = /\b(?:class|record|struct|interface|enum)\s+@?([A-Za-z_]\w*)/g;
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

const folderOf = (path: string) => posix.dirname(path);
const isInside = (path: string, folder: string) => folder === "." || path.startsWith(`${folder}/`);

/** Reads each path; a path missing at the ref is skipped. */
async function readFiles(tree: RefTree, paths: string[]): Promise<Result<Map<string, string>>> {
  const texts = new Map<string, string>();
  for (const path of paths) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    if (text.value !== null) texts.set(path, text.value);
  }
  return ok(texts);
}

/**
 * The projects among `candidates` whose own C# files call a spec registration method. A file belongs
 * to the project in its nearest enclosing folder, so a nested project's files are not counted twice.
 */
async function findRegisteringProjects(
  tree: RefTree,
  candidates: string[],
  allProjects: string[],
): Promise<Result<Set<string>>> {
  const sources = await listSourceFiles(tree, ["**/*.cs"]);
  if (!sources.ok) return sources;
  const projectFolders = [...new Set(allProjects.map(folderOf))].sort((a, b) => b.length - a.length);
  const candidateByFolder = new Map(candidates.map((path) => [folderOf(path), path]));
  const owned = sources.value.filter((path) => {
    const owner = projectFolders.find((folder) => isInside(path, folder));
    return owner !== undefined && candidateByFolder.has(owner);
  });
  const texts = await readFiles(tree, owned);
  if (!texts.ok) return texts;
  const registering = new Set<string>();
  for (const [path, text] of texts.value) {
    if (!SPEC_REGISTRATION_CALLS.some((call) => text.includes(call))) continue;
    const owner = projectFolders.find((folder) => isInside(path, folder));
    const project = owner === undefined ? undefined : candidateByFolder.get(owner);
    if (project !== undefined) registering.add(project);
  }
  return ok(registering);
}

/** The deepest solution whose folder holds every project and whose text names every project file. */
async function findSharedSolution(tree: RefTree, projects: string[]): Promise<Result<string | null>> {
  const solutions = await listSourceFiles(tree, SOLUTION_GLOBS);
  if (!solutions.ok) return solutions;
  const texts = await readFiles(tree, solutions.value);
  if (!texts.ok) return texts;
  const matching = [...texts.value.entries()]
    .filter(([path, text]) =>
      projects.every((project) => isInside(project, folderOf(path)) && text.includes(basename(project))),
    )
    .map(([path]) => path)
    .sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
  return ok(matching[0] ?? null);
}

/**
 * No committed spec: executable ASP.NET projects that serve their spec at runtime get a disabled
 * `serve` source each, since the command line and URL usually need a review. Several APIs from one
 * solution share one build per side.
 */
async function detectServedOpenapi(tree: RefTree): Promise<Result<StarterLayer>> {
  const projects = await listSourceFiles(tree, ["**/*.csproj"]);
  if (!projects.ok) return projects;
  const texts = await readFiles(tree, projects.value);
  if (!texts.ok) return texts;
  const referencing = [...texts.value.entries()].filter(([, text]) => RUNTIME_SPEC_PACKAGE.test(text));
  const executable = referencing
    .filter(([, text]) => WEB_SDK.test(text) || EXE_OUTPUT.test(text))
    .map(([path]) => path);
  const leftOut = referencing
    .filter(([path]) => !executable.includes(path))
    .map(([path]) => `${path} (class library)`);
  const registering = await findRegisteringProjects(tree, executable, projects.value);
  if (!registering.ok) return registering;
  // No candidate registers a spec in its own files: the call likely sits in a shared library, so keep them all.
  const served =
    registering.value.size > 0 ? executable.filter((path) => registering.value.has(path)) : executable;
  leftOut.push(
    ...executable
      .filter((path) => !served.includes(path))
      .map((path) => `${path} (no ${SPEC_REGISTRATION_CALLS.map((call) => `${call})`).join("/")} call)`),
  );
  const notes = leftOut.length > 0 ? `; left out: ${leftOut.join(", ")}` : "";
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
        `no committed openapi*/swagger* spec; set a command that exports the spec at each ref${notes}`,
      ),
    );
  }
  const solution = served.length > 1 ? await findSharedSolution(tree, served) : ok(null);
  if (!solution.ok) return solution;
  const build = solution.value === null ? "" : " --no-build";
  const used = new Set<string>();
  const apis = served.map((path) => ({
    name: takeUniqueName(stripExtension(path), used),
    source: {
      kind: "serve",
      run: `dotnet run${build} --no-launch-profile --project ${path}`,
      url: "http://127.0.0.1:{port}/swagger/v1/swagger.json",
      env: { ASPNETCORE_URLS: "http://127.0.0.1:{port}", ASPNETCORE_ENVIRONMENT: "Development" },
      timeoutSeconds: 300,
    },
  }));
  const setup = solution.value === null ? {} : { setup: { run: `dotnet build ${solution.value} -c Debug` } };
  const fallback =
    registering.value.size === 0
      ? "; none registers a spec in its own files, so all executable ones are kept"
      : "";
  return ok(
    disabled(
      "openapi",
      { ...setup, apis },
      `${served.join(", ")} serve the spec at runtime${fallback}${notes}; check the serve sources (URL, headers), then enable the layer`,
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

/** The files of a default glob that `init` keeps, and why it left out the others. */
type Selection = { selected: string[]; skipped: string[] };

/** A source with its default files when it keeps them all, else with the kept files listed. */
const toSource = (kind: string, all: string[], selected: string[]) =>
  selected.length === all.length ? { kind } : { kind, files: selected };

const describeSkipped = (skipped: string[]) => (skipped.length > 0 ? `; skipped ${skipped.join("; ")}` : "");

/** Leaves out test files and files of mobile apps; `mobileApps` are `package.json` paths. */
function selectServerFiles(files: string[], mobileApps: string[]): Selection {
  const tests = files.filter(isTestPath);
  const mobile = files.filter(
    (path) => !isTestPath(path) && mobileApps.some((manifest) => isInFolderOf(path, manifest)),
  );
  const selected = files.filter((path) => !tests.includes(path) && !mobile.includes(path));
  const skipped = [
    ...(tests.length > 0 ? [`test files ${tests.join(", ")}`] : []),
    ...(mobile.length > 0 ? [`mobile app files ${mobile.join(", ")}`] : []),
  ];
  return { selected, skipped };
}

async function findMobileAppManifests(tree: RefTree): Promise<Result<string[]>> {
  const packages = await listSourceFiles(tree, DEFAULT_NPM_FILES);
  return packages.ok ? findMobileApps(tree, packages.value) : packages;
}

/**
 * Compose files and `.env` examples outside tests and mobile apps, compose files referenced by the
 * deploy tooling over the rest, and the deploy chain itself (Ansible, workflows) as regex sources.
 */
async function detectConfig(tree: RefTree, mobileApps: string[]): Promise<Result<StarterLayer>> {
  const compose = await listSourceFiles(tree, DEFAULT_COMPOSE_FILES);
  if (!compose.ok) return compose;
  const dotenv = await listSourceFiles(tree, DEFAULT_DOTENV_FILES);
  if (!dotenv.ok) return dotenv;
  const allFiles = await listSourceFiles(tree, ["**"]);
  if (!allFiles.ok) return allFiles;
  const serverCompose = selectServerFiles(compose.value, mobileApps);
  const deploy = await detectDeployChain(tree, allFiles.value, serverCompose.selected);
  if (!deploy.ok) return deploy;
  const deployed = deploy.value.composeFiles;
  const composeFiles = deployed.length > 0 ? deployed : serverCompose.selected;
  const notDeployed = serverCompose.selected.filter((path) => !composeFiles.includes(path));
  const serverDotenv = selectServerFiles(dotenv.value, mobileApps);

  const deploySources = deploy.value.sources;
  const sources = [
    ...(composeFiles.length > 0 ? [toSource("compose", compose.value, composeFiles)] : []),
    ...(serverDotenv.selected.length > 0 ? [toSource("dotenv", dotenv.value, serverDotenv.selected)] : []),
    ...deploySources,
  ];
  if (sources.length === 0) {
    return ok(
      disabled(
        "config",
        { sources: [{ kind: "compose" }, { kind: "dotenv" }] },
        "no compose file, no .env example and no deploy chain (Ansible, GitHub workflows)",
      ),
    );
  }
  const required = deploy.value.required;
  const members = [
    ...(deployed.length > 0 ? ["compose"] : []),
    ...deploySources.map((source) => source.name).filter((name) => name !== required),
  ];
  const chainMembers = members.length + (required === null ? 0 : 1);
  const chains =
    deploySources.length > 0 && members.length > 0 && chainMembers >= 2
      ? [{ name: "deploy", sources: members, ...(required === null ? {} : { required: [required] }) }]
      : [];
  const environment = deploy.value.environment;
  const config = {
    sources,
    ...(chains.length > 0 ? { chains } : {}),
    ...(environment === null
      ? {}
      : { presence: { run: `gh secret list --env ${environment} --json name --jq '.[].name'` } }),
  };
  const found = [
    ...composeFiles,
    ...serverDotenv.selected,
    ...deploySources.map((source) => `${source.name} (${source.files.join(", ")})`),
  ];
  const skipped = [
    ...serverCompose.skipped,
    ...(notDeployed.length > 0 ? [`compose files the deploy does not use ${notDeployed.join(", ")}`] : []),
    ...serverDotenv.skipped,
  ];
  return ok({ name: "config", config, summary: found.join(", ") + describeSkipped(skipped), enabled: true });
}

/** NuGet and npm manifests, without mobile apps; test packages are written as `ignore`. */
async function detectDependencies(tree: RefTree, mobileApps: string[]): Promise<Result<StarterLayer>> {
  const nuget = await listSourceFiles(tree, DEFAULT_NUGET_FILES);
  if (!nuget.ok) return nuget;
  const npm = await listSourceFiles(tree, DEFAULT_NPM_FILES);
  if (!npm.ok) return npm;
  const mobile = npm.value.filter((path) => mobileApps.some((manifest) => isInFolderOf(path, manifest)));
  const serverNpm = npm.value.filter((path) => !mobile.includes(path));
  const sources = [
    ...(nuget.value.length > 0 ? [{ kind: "nuget" }] : []),
    ...(serverNpm.length > 0 ? [toSource("npm", npm.value, serverNpm)] : []),
  ];
  const skipped = mobile.length > 0 ? [`React Native/Expo apps ${mobile.join(", ")}`] : [];
  if (sources.length === 0) {
    return ok(
      disabled(
        "dependencies",
        { sources: [{ kind: "nuget" }, { kind: "npm" }] },
        `no MSBuild project or props file and no server package.json${describeSkipped(skipped)}`,
      ),
    );
  }
  const config = {
    sources,
    ...(nuget.value.length > 0 ? { ignore: DEFAULT_DEPENDENCY_IGNORE } : {}),
  };
  const found = [...nuget.value, ...serverNpm];
  return ok({
    name: "dependencies",
    config,
    summary: found.join(", ") + describeSkipped(skipped),
    enabled: true,
  });
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

/** Simple names of the types that broker APIs name in the repository's C# files. */
async function findBrokerTypeNames(tree: RefTree): Promise<Result<Set<string>>> {
  const files = await listSourceFiles(tree, ["**/*.cs"]);
  if (!files.ok) return files;
  const names = new Set<string>();
  for (const path of files.value) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    if (text.value === null) continue;
    for (const match of text.value.matchAll(BROKER_GENERIC)) {
      const typeArguments = readTypeArguments(text.value, match.index + match[0].length - 1);
      for (const name of typeArguments.match(/[A-Za-z_]\w*/g) ?? []) names.add(name);
    }
    for (const match of text.value.matchAll(BROKER_NEW)) {
      names.add(match[1]?.split(".").at(-1) ?? "");
    }
  }
  return ok(names);
}

/** Whether a contract folder holds broker messages: by its name, or because a broker API names one of its types. */
async function isBrokerFolder(
  tree: RefTree,
  folder: { path: string; files: string[] },
  brokerTypes: Set<string>,
): Promise<Result<boolean>> {
  if (BROKER_FOLDER.test(posix.basename(folder.path))) return ok(true);
  for (const path of folder.files) {
    const text = await tree.readFile(path);
    if (!text.ok) return text;
    for (const match of text.value?.matchAll(TYPE_DECLARATION) ?? []) {
      if (brokerTypes.has(match[1] ?? "")) return ok(true);
    }
  }
  return ok(false);
}

/**
 * The outermost folder of each C# file under a `*Contract*` or `*Messages` folder, kept when it holds
 * broker messages; request and response DTO folders are left to `openapi`.
 */
async function detectMessageContracts(tree: RefTree): Promise<Result<StarterLayer>> {
  const files = await listSourceFiles(tree, CONTRACT_GLOBS);
  if (!files.ok) return files;
  const folders = new Map<string, string[]>();
  for (const path of files.value) {
    const segments = path.split("/");
    const position = segments.findIndex(
      (segment, index) => index < segments.length - 1 && CONTRACT_FOLDER.test(segment),
    );
    if (position === -1 || segments.some((segment) => TEST_FOLDER.test(segment))) continue;
    const folder = segments.slice(0, position + 1).join("/");
    folders.set(folder, [...(folders.get(folder) ?? []), path]);
  }
  const candidates = [...folders.keys()].sort();
  const toGlobs = (paths: string[]) => paths.map((folder) => `${folder}/**/*.cs`);
  if (candidates.length === 0) {
    return ok(
      disabled(
        "message-contracts",
        { sources: [{ name: "contracts", language: "csharp", files: "src/**/*.Contracts/**/*.cs" }] },
        "no C# files under a *Contract* or *Messages folder; point a source at your message contracts",
      ),
    );
  }
  const brokerTypes = await findBrokerTypeNames(tree);
  if (!brokerTypes.ok) return brokerTypes;
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const path of candidates) {
    const isBroker = await isBrokerFolder(tree, { path, files: folders.get(path) ?? [] }, brokerTypes.value);
    if (!isBroker.ok) return isBroker;
    (isBroker.value ? kept : skipped).push(path);
  }
  const skippedNote = `no IConsumer<T>, ConsumeContext<T>, IRequestClient<T>, Publish or Send names a type of ${skipped.join(", ")} and the folder name does not end with Messages or Events, so it is read as HTTP DTOs that openapi covers`;
  if (kept.length === 0) {
    return ok(
      disabled(
        "message-contracts",
        { sources: [{ name: "contracts", language: "csharp", files: toGlobs(skipped) }] },
        `${skippedNote}; enable the layer if these types travel through a broker`,
      ),
    );
  }
  return ok({
    name: "message-contracts",
    config: { sources: [{ name: "contracts", language: "csharp", files: toGlobs(kept) }] },
    summary: skipped.length === 0 ? kept.join(", ") : `${kept.join(", ")}; skipped: ${skippedNote}`,
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
  const mobileApps = await findMobileAppManifests(tree);
  if (!mobileApps.ok) return mobileApps;
  const config = await detectConfig(tree, mobileApps.value);
  if (!config.ok) return config;
  const dependencies = await detectDependencies(tree, mobileApps.value);
  if (!dependencies.ok) return dependencies;
  const messageContracts = await detectMessageContracts(tree);
  if (!messageContracts.ok) return messageContracts;
  const detected = [
    openapi.value,
    detectClientUsage(openapi.value),
    disabled(
      "error-codes",
      {
        codes: [{ name: "api", files: ["src/**/*.cs"], pattern: 'new Error\\(\\s*"(?<code>[\\w.]+)"' }],
        clients: [
          {
            name: "mobile",
            refs: { tags: "mobile-*" },
            files: ["app/constants/api.ts"],
            pattern: '"(?<code>[\\w.]+)"\\s*:',
          },
        ],
      },
      "error code constructors and client translation maps are project-specific; set the code pattern and each client's map",
    ),
    detectSqlMigrations(sqlFiles.value, drizzleFolders.value),
    detectSeed(sqlFiles.value, drizzleFolders.value),
    persistedEnums.value,
    config.value,
    dependencies.value,
    messageContracts.value,
    disabled(
      "outbound",
      {
        targets: [
          {
            name: "http",
            files: ["src/**/*.cs"],
            pattern: '"(?<host>https://[\\w.-]+)(?<path>/[^"{?]*)?',
          },
        ],
      },
      "where outbound URLs are written is project-specific; set the patterns that capture each host and path",
    ),
    disabled(
      "behaviour",
      {
        start: { run: "./scripts/start-integration-stack.sh" },
        test: {
          run: "dotnet test tests/Integration.Tests --logger trx",
          results: { kind: "trx", path: "**/*.trx" },
        },
        stop: { run: "docker compose -f docker-compose.integration.yml down -v" },
      },
      "nothing in a repository says how its stack starts; set start, test and stop to your commands",
    ),
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

  const guess = await guessCheckDefaults({ repoDir: repoRoot.value, env: io.env, fetch: io.fetch });
  const config = {
    check: { base: guess.base, revision: guess.revision, failOn: "breaking" },
    layers: Object.fromEntries(layers.value.map((layer) => [layer.name, layer.config])),
  };
  const parsed = parseConfig(config, LAYERS, configPath);
  if (!parsed.ok) return fail(`init built an invalid config, please report it: ${parsed.error}`);

  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    return fail(`cannot write ${configPath} (${(error as NodeJS.ErrnoException).code})`);
  }
  io.stderr(`softure-compat: check compares ${guess.base} with ${guess.revision}: ${guess.reason}\n`);
  for (const layer of layers.value) {
    io.stderr(`softure-compat: ${layer.name} ${layer.enabled ? "enabled" : "disabled"}: ${layer.summary}\n`);
  }
  io.stderr(
    `softure-compat: wrote ${configPath}\n` +
      'Review it (a disabled layer is turned on by removing its "enabled": false, and "check" names the refs to\n' +
      "compare), then run:\n" +
      "  softure-compat check\n",
  );
  return 0;
}
