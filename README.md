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

Folders named `node_modules`, `bin`, `obj` and `dist` are ignored. A SQL file is read as SQL Server when it has `GO`
batch lines or `[dbo]` names, otherwise as Postgres.

## Command line

```
softure-compat check --base <ref> --revision <ref> [options]
softure-compat init [--repo <dir>] [--config <file>] [--force]
```

| Option | Command | Meaning |
| --- | --- | --- |
| `--base <ref>` | check | git ref running in production (required) |
| `--revision <ref>` | check | git ref about to be released (required) |
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
run (bad arguments, invalid config, unknown ref, unreadable repository).

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
- run: npx softure-compat check --base "$PRODUCTION_TAG" --revision HEAD --output compat-report.md
```

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
    "config": { "sources": [{ "kind": "compose" }, { "kind": "dotenv" }] }
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

| Key | Meaning |
| --- | --- |
| `apis[].name` | unique name (letters, digits, `.`, `_`, `-`) |
| `apis[].source` | where the spec comes from at each ref, see below |
| `apis[].accept[]` | `{ id, operation?, reason }`; `operation` is `METHOD /path` as oasdiff reports it |
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

| Finding id | Class |
| --- | --- |
| `config-key-added-required` | `needs-action`: the value must exist in production before the deploy |
| `config-key-default-removed` | `needs-action` |
| `config-key-added-optional` | `safe` |
| `config-key-default-changed` | `safe` |
| `config-key-removed` | `safe` |

## What it does not check yet

The v1 acceptance case is the PETSEO 2.2.4 → 2.3.4 release. The tool reproduces its HTTP contract, schema, data
migration, seed, persisted enum and configuration findings (covered by `test/e2e/acceptance.test.ts`). It does not
yet check query-string binding changes, message contracts and queues, messaging library behaviour, push payloads
opened by old app versions, or behaviour of refactored code. Those layers are planned in
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
