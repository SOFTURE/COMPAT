# softure-compat

`@softure-ai/compat` answers one question before a server release: **is the revision about to be released backward
compatible with the release running in production?** It compares two git refs of your repository (for example the
production tag and `HEAD`) layer by layer, classifies every change, and fails a CI gate when something would break
clients, data or a rollback.

It works only from git. It never connects to a production server or database.

| Layer | What it compares |
| --- | --- |
| [`openapi`](#openapi) | the HTTP contract, through [oasdiff](https://github.com/oasdiff/oasdiff) |
| [`sql-migrations`](#sql-migrations) | new SQL migrations (folders such as drizzle, or EF Core idempotent scripts), Postgres and SQL Server |
| [`seed`](#seed) | seed scripts that run on every deploy, row by row |
| [`persisted-enums`](#persisted-enums) | enums stored in the database as strings or numbers (C# and TypeScript) |
| [`config`](#config) | configuration keys a release needs (compose interpolation, `.env` examples, your own patterns) |
| [`dependencies`](#dependencies) | runtime package versions (NuGet, npm), classified by semver |
| [`message-contracts`](#message-contracts) | C# message contracts (types, wire properties, enums) and queue names, for messages in flight |

## Install

```sh
npm install --save-dev @softure-ai/compat
```

Node.js 22 or newer and `git` are required. The `openapi` layer also needs **oasdiff v1.33.0**:

```sh
go install github.com/oasdiff/oasdiff@v1.33.0
```

The CLI finds oasdiff on `PATH`, in `layers.openapi.oasdiff.path`, or in the `SOFTURE_COMPAT_OASDIFF`
environment variable. Without it the `openapi` layer is skipped, and a skipped layer fails the gate unless you pass
`--allow-incomplete`.

## Quick start

```sh
npx softure-compat init                                  # writes compat.config.json from the files committed at HEAD
npx softure-compat check --base v2.2.4 --revision HEAD   # Markdown report on stdout, exit code for CI
```

`init` looks at the files committed at `HEAD` and writes every layer into `compat.config.json`. A layer whose inputs
it found is enabled; any other layer is written with `"enabled": false` and an example, so you can see what to fill
in. Review the file, adjust it, and remove `"enabled": false` from the layers you want. `init` never overwrites an
existing file unless you pass `--force`.

What `init` detects:

| Layer | Enabled when the commit has |
| --- | --- |
| `openapi` | `openapi*` or `swagger*` files (`.json`, `.yaml`, `.yml`); each becomes a `file` source |
| `sql-migrations` | `.sql` files mentioning `__EFMigrationsHistory` (EF Core idempotent scripts), or drizzle `meta/_journal.json` folders for PostgreSQL |
| `seed` | `.sql` files with `seed` in the name that are not migrations |
| `persisted-enums` | a `*DbContext.cs` calling `ConfigureEnum<T>()` (string storage) |
| `config` | compose files and `.env` examples at the default globs |
| `message-contracts` | C# files under a folder whose name contains `Contract` or ends with `Messages`; one glob per such folder |

Folders named `node_modules`, `bin`, `obj` and `dist` are ignored. A SQL file is read as SQL Server when it has `GO`
batch lines or `[dbo]` names, otherwise as Postgres.

## Command line

```
softure-compat check --base <ref> --revision <ref> [options]
softure-compat init [--repo <dir>] [--config <file>] [--force]
```

| Option | Command | Meaning |
| --- | --- | --- |
| `--base <ref>` | check | git ref running in production, or a [resolver](#finding-the-production-ref) (required) |
| `--revision <ref>` | check | git ref about to be released, or a [resolver](#finding-the-production-ref) (required) |
| `--repo <dir>` | both | repository directory (default: current directory) |
| `--config <file>` | both | config file (default: `<repo>/compat.config.json`) |
| `--format <md\|json>` | check | report format (default: `md`) |
| `--output <file>` | check | write the report to a file instead of stdout |
| `--fail-on <class>` | check | `breaking`, `rollback-risk`, `needs-action` or `never` (default: `breaking`) |
| `--allow-incomplete` | check | do not fail when a layer was skipped or failed |
| `--force` | init | overwrite an existing config file |
| `-h`, `--help` | both | show the help |
| `-v`, `--version` | both | show the version |

**Exit codes:** `0` the gate passed (`init`: the config was written), `1` the gate failed, `2` the command could not
run (bad arguments, invalid config, unknown ref, a resolver that found nothing, unreadable repository).

### Finding the production ref

`--base` must be what production runs, and the newest tag usually is not (it is often what DEV runs). Instead of a
git ref, `--base` and `--revision` take a resolver:

| Value | Resolves to |
| --- | --- |
| `github-deployment:<environment>` | the commit of the newest GitHub deployment to that environment whose newest status is `success` (superseded deployments are `inactive` and skipped) |
| `github-workflow:<file>` | the head commit of the newest successful run of that workflow, e.g. `github-workflow:deploy-prod.yml` |
| `latest-tag[:<glob>]` | the newest tag matching the glob (all tags without one), in version order, e.g. `latest-tag:v2.*` |

The GitHub resolvers read the token from `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`; the repository from
`GITHUB_REPOSITORY`, then the `origin` remote; the API from `GITHUB_API_URL` (default `https://api.github.com`). A
resolver that finds nothing stops the check with exit code `2`; it never falls back to a guess. The resolved commit
must be in the clone, so fetch the full history. The report header names both, e.g.
"Base github-deployment:prod → 2.2.4 `26b8973e1f0a`". A branch literally named `latest-tag` has to be passed as
`refs/heads/latest-tag`.

### Classes and the gate

Every finding has one class, from least to most severe:

| Class | Meaning |
| --- | --- |
| `safe` | old clients and the old build keep working |
| `needs-action` | works, but someone must do something or check something before the deploy (a secret, a precondition on data) |
| `rollback-risk` | the release works, but after it writes new data, rolling back to the base build breaks |
| `breaking` | existing clients or the base build break as soon as the revision is deployed |

The gate fails when an unaccepted finding is at or above `--fail-on`, or when a layer was `skipped` or `failed`
(unless `--allow-incomplete`). A failed layer still reports the findings it produced. Each layer accepts known
findings with an `accept` list: every entry needs a `reason`, accepted findings stay in the report under
"Accepted", and an entry that matched nothing is reported as a note so stale entries get cleaned up.

### In CI

The check needs both refs in the clone, so fetch the full history (or at least the production tag):

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: actions/setup-node@v4
  with:
    node-version: 22
- uses: actions/setup-go@v5
  with:
    go-version: "1.24"
- run: go install github.com/oasdiff/oasdiff@v1.33.0
- run: npm ci
- run: npx softure-compat check --base github-deployment:production --revision HEAD --output compat-report.md
  env:
    GH_TOKEN: ${{ github.token }}
```

The job needs `permissions: { contents: read, deployments: read, actions: read }` for the GitHub resolvers. A
literal ref (`--base "$PRODUCTION_TAG"`) works too.

`--format json` gives a machine-readable report with the same content.

## Configuration

`check` and `init` use `compat.config.json` in the `--repo` directory (default: the current directory), or the
file `--config` names. Unknown keys are errors, so a
typo never silently disables a check. Every layer is optional; a configured layer runs unless it has
`"enabled": false`. All paths and globs are relative to the repository root; globs support `**`, `*`, `?` and
`{a,b}`.

```json
{
  "layers": {
    "openapi": { "apis": [{ "name": "public", "source": { "kind": "file", "path": "api/openapi.yaml" } }] },
    "sql-migrations": { "sources": [{ "name": "db", "dialect": "postgres", "kind": "folder", "path": "drizzle" }] },
    "seed": { "sources": [{ "name": "db", "dialect": "postgres", "files": ["db/seed.sql"] }] },
    "persisted-enums": {
      "sources": "**/*.cs",
      "enums": [{ "kind": "discover", "files": "**/*DbContext.cs", "pattern": "ConfigureEnum<(?<name>[\\w.]+)>", "storage": "string" }]
    },
    "config": { "sources": [{ "kind": "compose" }, { "kind": "dotenv" }] },
    "dependencies": { "watch": [{ "name": "SOFTURE.*", "class": "needs-action" }] }
  }
}
```

### openapi

Compares the OpenAPI spec of each API at both refs with `oasdiff changelog`. oasdiff levels map to classes: error →
`breaking`, warning → `needs-action`, info → `safe`. Finding ids are oasdiff check ids (for example
`endpoint-added`, `request-property-became-not-nullable`); see the
[oasdiff checks](https://github.com/oasdiff/oasdiff/blob/main/docs/BREAKING-CHANGES-EXAMPLES.md).

```json
{
  "apis": [
    {
      "name": "b2c",
      "source": { "kind": "command", "run": "dotnet run --project src/Api -- export-openapi openapi.json", "output": "openapi.json" },
      "accept": [
        {
          "id": "request-property-became-not-nullable",
          "operation": "POST /api/pets/{petId}/medications",
          "reason": "the old app always sends an array; the handler does ?? []"
        }
      ]
    }
  ],
  "oasdiff": { "path": "tools/oasdiff", "args": ["--exclude-elements", "description"] }
}
```

Several APIs built from one solution can share one build per side:

```json
{
  "setup": { "run": "dotnet build App.slnx -c Debug", "timeoutSeconds": 900 },
  "apis": [
    { "name": "b2c", "source": { "kind": "command", "run": "dotnet run --no-build --project src/B2C -- export openapi.json", "output": "openapi.json" } },
    { "name": "admin", "source": { "kind": "command", "run": "dotnet run --no-build --project src/Admin -- export admin.json", "output": "admin.json" } }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `apis[].name` | unique name (letters, digits, `.`, `_`, `-`) |
| `apis[].source` | where the spec comes from at each ref, see below |
| `apis[].accept[]` | `{ id, operation?, reason }`; `operation` is `METHOD /path` as oasdiff reports it |
| `setup` | `{ run, timeoutSeconds? }`: a command run once per side, before any spec source of that side; see below |
| `concurrency` | `2` (default) prepares the base and revision sides in parallel; `1` prepares them one after the other |
| `oasdiff.path` | oasdiff binary; a relative path is resolved against the repository root |
| `oasdiff.args` | extra arguments for `oasdiff changelog` (not `--format`, `-f`, `--fail-on`, `-o`) |

Spec sources:

- `{ "kind": "file", "path": "api/openapi.yaml" }`: a committed spec. A spec present only in the revision is
  `api-added` (`safe`); one present only at the base is `api-removed` (`breaking`).
- `{ "kind": "command", "run": "...", "output": "openapi.json", "timeoutSeconds": 600 }`: **the command runs twice,
  once inside each materialised ref**: a temporary checkout of the base commit and one of the revision commit (never
  your working tree). It runs through the shell with that checkout as the working directory and must write `output`,
  relative to the checkout. The environment carries `COMPAT_SIDE` (`base` or `revision`), `COMPAT_REF` and
  `COMPAT_COMMIT`. A committed copy of `output` is deleted before the command runs, so a stale file never passes for a
  fresh export. The default timeout is 600 seconds (maximum 7200). Use it for specs generated from code (NSwag,
  Swashbuckle, FastEndpoints), and make sure the command works on a clean checkout (restore dependencies inside it).
- `{ "kind": "url", "base": "https://dev.example.com/swagger.json", "revision": "https://..." }`: fetched over
  HTTP(S), for example from a DEV environment.
- `{ "kind": "serve", "run": "...", "url": "http://127.0.0.1:{port}/swagger/v1/swagger.json" }`: for specs that
  exist only while the app runs (ASP.NET with Swashbuckle, NSwag or FastEndpoints, spec hidden in production). In each
  materialised ref the tool picks a free port, starts `run` through the shell, polls `url` until it answers 2xx with an
  OpenAPI document (JSON or YAML), saves it, and stops the app with everything it started (SIGTERM, then SIGKILL to
  the whole process group after 3 seconds). See below.

`setup` runs **once in each materialised ref**, whatever the number of APIs, before their spec sources, with the
same working directory and environment (`COMPAT_SIDE`, `COMPAT_REF`, `COMPAT_COMMIT`) as a `command` source. Use it
for a build that every export command shares; the export commands then skip the build (`dotnet run --no-build`).
The default timeout is 600 seconds (maximum 7200). A failing setup fails the layer with the side, the ref and the
end of its stderr. The base and revision checkouts are separate, so both sides (setup, then the spec of each API in
order) run in parallel; set `"concurrency": 1` when one build at a time is all the machine can take.

A `serve` source for an ASP.NET API whose spec sits behind an internal key:

```json
{
  "setup": { "run": "dotnet build App.slnx -c Debug", "timeoutSeconds": 900 },
  "apis": [
    {
      "name": "b2c",
      "source": {
        "kind": "serve",
        "run": "dotnet run --no-build --no-launch-profile --project src/Api",
        "url": "http://127.0.0.1:{port}/swagger/v1/swagger.json",
        "ready": "http://127.0.0.1:{port}/hc",
        "env": { "ASPNETCORE_URLS": "http://127.0.0.1:{port}", "ASPNETCORE_ENVIRONMENT": "Development" },
        "headers": { "X-Internal-Api-Key": "${INTERNAL_API_KEY}" },
        "timeoutSeconds": 180
      }
    }
  ]
}
```

| `serve` key | Meaning |
| --- | --- |
| `run` | shell command that starts the app and keeps running; working directory is the materialised ref |
| `url` | where the running app serves the spec |
| `ready` | optional URL polled until 2xx before `url`, for example a health check |
| `env` | extra environment variables for the app |
| `headers` | sent with every request; `${VAR}` reads the environment, a missing variable fails the layer, values are never printed |
| `timeoutSeconds` | from the start of the app until the spec is fetched; default 180, maximum 7200 |

`{port}` in `run`, `url`, `ready`, `env` and `headers` is replaced by a free port picked for each side, so the base
and revision apps run in parallel without clashing; the app also gets it as `COMPAT_PORT`, next to `COMPAT_SIDE`,
`COMPAT_REF` and `COMPAT_COMMIT`. The report names the spec by its `url` with `{port}` kept and any query redacted.
When the spec never arrives, the error names the last answer of the URL (`HTTP 401`, `connection refused`, ...)
and the end of the app output; an app that exits early is reported with its exit code. Each API with a `serve`
source starts its own app. `init` proposes a disabled `serve` source for every `*.csproj` that references
`FastEndpoints.Swagger`, `NSwag.AspNetCore` or `Swashbuckle.AspNetCore` when the repository has no committed spec.

### sql-migrations

Classifies the migrations that exist in the revision but not in the base: the ones the deploy will run. A migration
that the base already had and the revision edits is `migration-modified`, one the revision deletes is
`migration-removed` (both `needs-action`: production already ran the old version).

```json
{
  "sources": [
    { "name": "app", "dialect": "postgres", "kind": "folder", "path": "drizzle", "include": ["**/*.sql"] },
    {
      "name": "legacy",
      "dialect": "sqlserver",
      "kind": "ef-script",
      "path": "src/Db/Scripts/migrations.sql",
      "historyTable": "__EFMigrationsHistory",
      "accept": [{ "id": "insert-explicit-id", "migration": "20261005073152_AddMissingPetBreeds", "object": "Breeds", "reason": "production max(Id) is 417" }]
    }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `name` | unique source name |
| `dialect` | `postgres` or `sqlserver` |
| `kind: "folder"` | every file under `path` matching `include` (default `["**/*.sql"]`) is one migration, identified by its path relative to `path` |
| `kind: "ef-script"` | `path` is an EF Core idempotent script (`dotnet ef migrations script --idempotent`); each `MigrationId` guard block is one migration. `historyTable` defaults to `__EFMigrationsHistory` |
| `accept[]` | `{ id, migration, object?, reason }`; `migration` is the EF migration id or the file path relative to the folder; `object` is `table` or `table.column` as the report shows it |

Rules and classes:

| Class | Rule ids |
| --- | --- |
| `safe` | `create-schema`, `create-table`, `add-column`, `create-index` |
| `needs-action` | `add-unique-index`, `add-constraint`, `drop-default`, `update-data`, `delete-data`, `merge-data`, `insert-explicit-id`, `object-redefined`, `migration-modified`, `migration-removed` |
| `rollback-risk` | `drop-not-null`, `enum-value-added` |
| `breaking` | `add-required-column`, `drop-table`, `drop-column`, `drop-object`, `rename-table`, `rename-column`, `move-table`, `change-column-type`, `alter-column`, `set-not-null`, `enum-value-renamed`, `truncate` |

Statements on a table created by the same set of new migrations are `safe`. `insert-explicit-id` reports the id
range and the precondition (for example "production `max(Id) < 418`").

### seed

Seed scripts that run on every deploy are compared row by row: per table and row key, across all files of a source.
The row key is the `ON CONFLICT (...)` target, else the `MERGE ... ON` pairs, else the first column.

```json
{
  "sources": [
    {
      "name": "db",
      "dialect": "postgres",
      "files": ["db/seed.sql", "db/seed/*.sql"],
      "accept": [{ "id": "row-changed", "object": "EmailTemplates", "reason": "copy fix, approved" }]
    }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `name`, `dialect` | as for `sql-migrations` |
| `files` | globs of the seed scripts; a source whose globs match no file in the revision fails the layer |
| `accept[]` | `{ id, object?, reason }`; `object` is the table as the report shows it, or the file path for `seed-file-removed` |

| Class | Finding ids |
| --- | --- |
| `safe` | `row-added`, `row-removed`, `seed-file-removed`, `insert-query-added` |
| `needs-action` | `row-changed`, `row-change-ignored`, `row-added-skipped`, `row-deleted`, `insert-unguarded`, `upsert-query`, `update-data`, `delete-data`, `truncate`, `unreadable-write` |

Dynamic SQL (`EXEC(N'...')`, `EXECUTE format(...)`), `COPY` and `BULK INSERT` are not read.

### persisted-enums

Enum members stored in the database must stay readable by both builds. The layer parses C# and TypeScript enums
(`.cs`, `.ts`, `.tsx`, `.mts`, `.cts`) at both refs.

```json
{
  "sources": ["src/**/*.cs"],
  "enums": [
    { "kind": "named", "name": "OrderStatus", "storage": "int", "file": "src/Domain/OrderStatus.cs" },
    { "kind": "discover", "files": "**/*DbContext.cs", "pattern": "ConfigureEnum<(?<name>[\\w.]+)>", "storage": "string" }
  ],
  "accept": [{ "id": "enum-member-added", "enum": "NotificationType", "member": "TermsChange", "reason": "no rollback below 2.3.4" }]
}
```

| Key | Meaning |
| --- | --- |
| `sources` | glob or globs of the files that declare enums |
| `enums[]` `named` | an enum by `name`; `file` pins the declaration when several files declare that name |
| `enums[]` `discover` | every enum whose name the regex `pattern` captures in `files` (named group `name`, else the first group) |
| `storage` | `string` (stored by name or string value) or `int` (stored by number) |
| `accept[]` | `{ id, enum, member?, reason }` |

| Finding id | Class |
| --- | --- |
| `enum-member-added` | `rollback-risk`: once a row holds it, the base build cannot read that row |
| `enum-member-removed` | `breaking` |
| `enum-member-renamed` | `breaking` for string storage; `needs-action` for int storage (the number is unchanged) |
| `enum-member-renumbered` | `breaking` (int storage: existing rows change meaning) |
| `enum-member-unresolved` | `needs-action`: the stored number cannot be computed without a compiler |
| `enum-added` | `safe` |
| `enum-removed` | `needs-action` |

### config

Reports configuration keys the revision needs that production may not have.

```json
{
  "sources": [
    { "kind": "compose" },
    { "kind": "dotenv", "valuesAreDefaults": true },
    {
      "kind": "regex",
      "name": "dotnet-required",
      "files": ["src/**/*Settings.cs"],
      "pattern": "public required [\\w<>?]+ (?<member>\\w+) \\{",
      "enclosing": "class (?<section>\\w+?)Settings\\b",
      "key": "{section}__{member}",
      "comments": "slash"
    }
  ],
  "accept": [{ "key": "SHOP_API_KEY", "id": "config-key-added-required", "reason": "set in the production vault" }]
}
```

| Source | Reads |
| --- | --- |
| `compose` | `${VAR}` interpolation in compose files (default `files`: `**/{docker-compose,compose}{,.*}.{yml,yaml}`); `${VAR:-x}` has a default, `${VAR}` and `${VAR:?msg}` are required |
| `dotenv` | keys of `.env` examples (default `files`: `**/.env.{example,sample,template,dist}`, `**/{example,sample}.env`); with `valuesAreDefaults: false` (the default) every key is required, with `true` a key with a value has a default |
| `regex` | your own pattern over `files`: named group `key` and an optional `default`; `flags` from `i`, `m`, `s`, `u`; `comments` `none`, `hash` or `slash` blanks comments first. `key` builds the key from several named groups instead, e.g. `"{section}__{member}"`; a group can also come from `enclosing`, a pattern whose nearest match before the key lends its groups (the settings class around a member). A placeholder nothing fills stays empty |

Every source has an optional unique `name` (`compose` and `dotenv` default to their kind; `regex` requires one)
and an optional `prefix` prepended to each of its keys, for a source that reads one section only (`"prefix": "Shop__"`).

Keys are normalized before they are compared (`"keyMatching": "normalized"`, the default): they are split on
`:`, `__`, `.`, `_`, `-` and case changes and joined in upper snake case, so `Shop:BaseUrl`, `Shop__BaseUrl`,
`SHOP_BASE_URL`, `shop.base_url` and the .NET member `ShopBaseUrl` are one key, `SHOP_BASE_URL`. A finding names
the normalized key, every source that reads it, and the original spellings when they differ.
`"keyMatching": "exact"` compares keys as written. `accept[].key` may use any spelling.
Keys are compared file by file for files present at both refs. A source fails the layer when it matches no file,
loses its files or all its keys in the revision, or (dotenv and regex) finds no key. Default values are never printed.
`accept[]` entries are `{ key, id, reason }`.

`presence` (optional) resolves the keys that need a value in production by asking the target environment for its
key names, never its values. `run` is a shell command that prints the names, one per line; `timeoutSeconds`
defaults to 60.

```json
"presence": { "run": "gh secret list --env prod --json name --jq '.[].name'", "timeoutSeconds": 60 }
```

Other stores work the same way: `op environment read <id> | cut -d= -f1`, `doppler secrets --only-names`,
`aws ssm get-parameters-by-path --path /prod --query 'Parameters[].Name' --output text | tr '\t' '\n'`.
The command runs once, in the repository's working directory (not a checked-out ref), and only when a
`config-key-added-required` or `config-key-default-removed` finding exists. Names are normalized like every
other key. A listed key turns the finding `safe` ("present in the target environment"); a missing key stays
`needs-action` and says so. A line `KEY=value` is cut to `KEY` before anything is kept: values are never logged,
stored or written to the report, and errors never quote the command's output. A failing command adds a note and
leaves the findings as they were.

| Finding id | Class |
| --- | --- |
| `config-key-added-required` | `needs-action`: the value must exist in production before the deploy |
| `config-key-default-removed` | `needs-action` |
| `config-key-added-optional` | `safe` |
| `config-key-default-changed` | `safe` |
| `config-key-removed` | `safe` |

### dependencies

Reports runtime package upgrades: a library upgrade can change behaviour both builds rely on without any contract
change (a new retry policy in a messaging client, a new default in an ORM).

```json
{
  "sources": [{ "kind": "nuget" }, { "kind": "npm", "sections": ["dependencies"] }],
  "watch": [
    {
      "name": "SOFTURE.*",
      "class": "needs-action",
      "releaseNotes": "https://github.com/SOFTURE/MessageBroker/releases"
    }
  ],
  "ignore": ["Microsoft.CodeAnalysis.*", "*.Analyzers", "xunit*", "Microsoft.NET.Test.Sdk"],
  "accept": [{ "id": "dependency-upgraded", "name": "Npgsql", "reason": "release notes reviewed, no behaviour change" }]
}
```

| Source | Reads |
| --- | --- |
| `nuget` | MSBuild files (default `files`: `**/*.{csproj,fsproj,vbproj,props,targets}`): `PackageVersion` (central package management), `PackageReference` and `GlobalPackageReference` with `Include` or `Update` and a version (`VersionOverride`, `Version` attribute or element); `$(Property)` is resolved from the same file; a reference without a version takes it from `Directory.Packages.props` |
| `npm` | `package.json` (default `files`: `**/package.json`); `sections` from `dependencies` (default), `devDependencies`, `peerDependencies`, `optionalDependencies` |

`sources` defaults to both kinds; files under `node_modules`, `bin` and `obj` are skipped. Packages are compared by
name over all files of a ref (NuGet names case-insensitively); a range compares by its lower bound (`^1.2.3`,
`[1.2,2.0)`). When projects declare several versions of one package, a version that went down anywhere is a
downgrade, otherwise the jump from the lowest base version to the highest revision version decides the class. The
layer fails when no dependency file matches at either ref or a `package.json` is not valid JSON.

`watch[]` entries are `{ name, class?, releaseNotes? }`: every finding of a matching package gets at least `class`,
and `releaseNotes` is printed with it (nothing is fetched). `ignore[]` lists packages that produce no finding.
Names in both are globs (`*`, `?`, `{a,b}`) matched case-insensitively. `accept[]` entries are `{ id, name, reason }`.

| Finding id | Class |
| --- | --- |
| `dependency-upgraded` | `safe` for a patch or minor upgrade; `needs-action` for a major upgrade, a minor upgrade below 1.0 or any upgrade below 0.1 |
| `dependency-downgraded` | `needs-action` |
| `dependency-changed` | `needs-action`: the declared version is not a version number at one ref (`latest`, a git URL, an unresolved `$(Property)`) |
| `dependency-added` | `safe` |
| `dependency-removed` | `safe` |
### message-contracts

Messages that wait in a broker queue during a deploy are produced by one build and consumed by the other. The layer
parses the C# contracts of both refs at source level (no build) and compares them the way MassTransit with
System.Text.Json reads them, and compares the queue names your patterns find.

```json
{
  "sources": [
    { "name": "internal", "language": "csharp", "files": "src/PETSEO.Contract.Internal.Messages/**/*.cs" }
  ],
  "queues": [
    { "kind": "regex", "name": "consumers", "files": "**/ConsumerGroups.cs", "pattern": "\"(?<queue>PETSEO\\.[\\w.]+)\"" }
  ],
  "accept": [{ "id": "message-property-added", "subject": "PETSEO.Messages.OrderPlaced.Total", "reason": "consumers deployed first" }]
}
```

| Key | Meaning |
| --- | --- |
| `sources[]` | `{ name, language: "csharp", files, enumStorage? }`; `enumStorage` is `string` (default, MassTransit writes enum names) or `int` |
| `queues[]` | `{ kind: "regex", name, files, pattern, flags?, comments? }`: named group `queue`, else the first group; `flags` from `i`, `m`, `s`, `u`; `comments` `slash` (default), `hash` or `none` |
| `accept[]` | `{ id, subject, reason }`, matching the finding subject exactly |

What counts: every public, non-static `class`, `record`, `record struct`, `struct` and `interface` (nested ones too),
identified by its full name (`Namespace.Outer+Inner`, generic arity as `` `1 ``) or its `[MessageUrn]`. Its wire
properties are the public instance properties with a public getter and the positional parameters of a record; fields,
static and computed (`=>`) properties, methods and `[JsonIgnore]` members are not. `[JsonPropertyName]` sets the wire
name; names are compared case-insensitively. Properties of base types declared in the sources are inherited. Public
enums follow the [`persisted-enums`](#persisted-enums) rules under `enumStorage`.

| Finding id | Class |
| --- | --- |
| `message-added` | `safe` |
| `message-removed` | `needs-action`: drain its queues before the deploy |
| `message-renamed` | `breaking`: a new full name or namespace changes the message URN; paired by simple name, else by an identical wire shape |
| `message-entity-name-changed` | `breaking`: `[EntityName]` changed, the builds publish to different exchanges |
| `message-base-added` | `safe` |
| `message-base-removed` | `breaking`: consumers of the base type or interface stop receiving it |
| `message-property-added` | `safe` when nullable (`T?`) or initialized (`= null!` and `= default` do not count); `rollback-risk` otherwise; `breaking` when `required` or `[JsonRequired]` |
| `message-property-removed` | `breaking` |
| `message-property-type-changed` | `breaking` (`System.` qualifiers, `global::`, `Nullable<T>` and type aliases are normalized first) |
| `message-property-nullability-changed` | `rollback-risk`: only `?` changed |
| `message-property-required` | `breaking`: an existing property became `required` or `[JsonRequired]` |
| `queue-added` | `safe` |
| `queue-removed` | `needs-action`: drain it before the deploy |
| `enum-member-added`, `enum-member-removed`, `enum-member-renamed`, `enum-member-renumbered`, `enum-member-unresolved`, `enum-added`, `enum-removed` | as in `persisted-enums` |

The layer fails, keeping its findings, when a source or queue source matches no file at either ref or loses all its
files in the revision, when a source declares no public type or a queue source finds no queue, and when a
declaration cannot be read: a `#if` in a type body, unbalanced brackets, an unrecognised public member, a
`[JsonPropertyName]`, `[MessageUrn]` or `[EntityName]` without a constant string literal (an interpolated string
does not count), a type declared twice without `partial`, or a declaration-looking line outside comments that the
parser did not reach (a line inside a multi-line string counts too). It does not follow base types outside the
sources, custom `[JsonConverter]`s, or serializer settings other than MassTransit's defaults. A removed type and an
added one with the same unique wire shape are paired as a rename, reported as `breaking` even when the two messages
are unrelated.

## What it does not check yet

The v1 acceptance case is the PETSEO 2.2.4 → 2.3.4 release. The tool reproduces its HTTP contract, schema, data
migration, seed, persisted enum, configuration and dependency findings (covered by `test/e2e/acceptance.test.ts`), and
its message contracts and queues (`test/e2e/message-contracts.test.ts`). It does not yet check query-string binding
changes, messaging library behaviour beyond the version change, push payloads opened by old app versions, or
behaviour of refactored code. Those layers are planned in
[`context/backlog/later-layers.md`](context/backlog/later-layers.md).

## Releasing (maintainers)

Releases are automatic: merging a version bump to `master` releases it. Nobody runs `npm publish` or pushes a tag.

```sh
npm version minor --no-git-tag-version   # or patch / major / 0.2.0-rc.1; in a pull request
```

Every push to `master` runs [`.github/workflows/release.yml`](.github/workflows/release.yml). It runs every gate with
a real oasdiff, tests the packed CLI and packs the tarball; when the `package.json` version is not released yet, it
then:
1. publishes `@softure-ai/compat` to **npmjs.com** with provenance;
2. publishes `@softure/compat` to **GitHub Packages** (GitHub requires the scope to match the org);
3. creates the tag `vX.Y.Z` on the released commit and the **GitHub Release** with generated notes and the tarball.

A version with a prerelease suffix (`0.2.0-rc.1`) goes to the `next` dist-tag and is marked as a prerelease. A
version already on a registry is skipped, so re-running the workflow (Actions → *SOFTURE COMPAT - RELEASE* → *Run
workflow* on `master`) only fills in what is missing. A push that does not change the version only validates.

npm authentication, once per repository:
1. **First version:** add the repository secret `NPM_TOKEN` (an npm granular access token with read and write access
   to the `@softure-ai` scope; *bypass 2FA* enabled), then run the workflow on `master`. Without the secret the run
   publishes nothing and warns that the token is missing.
2. **Afterwards:** configure trusted publishing on npmjs.com, in the package settings: publisher GitHub Actions,
   organization `SOFTURE`, repository `COMPAT`, workflow `release.yml`. npm then authenticates the workflow over
   OIDC and the `NPM_TOKEN` secret can be deleted; the workflow does not change.

Ways to install a release:

| Source | Command |
| --- | --- |
| npm | `npm i -D @softure-ai/compat` |
| GitHub Release (no auth) | `npm i -D https://github.com/SOFTURE/COMPAT/releases/download/vX.Y.Z/softure-ai-compat-X.Y.Z.tgz` |
| GitHub Packages | `npm i -D @softure/compat` with `@softure:registry=https://npm.pkg.github.com` and a token with `read:packages` |

## License

MIT
