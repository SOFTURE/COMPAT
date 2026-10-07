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
| [`behaviour`](#behaviour) | the base ref's black-box tests, run against the revision's running stack |

## Install

```sh
npm install --save-dev @softure-ai/compat
```

Node.js 22 or newer and `git` are required. The `openapi` layer uses **oasdiff v1.33.0**. You do not have to
install it: the CLI looks for oasdiff in `layers.openapi.oasdiff.path`, the `SOFTURE_COMPAT_OASDIFF` environment
variable and `PATH`, and when none has it, downloads the pinned v1.33.0 release for your OS and CPU from
[github.com/oasdiff/oasdiff/releases](https://github.com/oasdiff/oasdiff/releases). The archive is checked against
a SHA-256 shipped inside this package before it is used, and the binary is cached, so later runs work offline.

| Topic | Details |
| --- | --- |
| Platforms | macOS (Intel and Apple silicon), Linux x64 and arm64, Windows x64 and arm64 |
| Cache | `SOFTURE_COMPAT_CACHE_DIR`, else `$XDG_CACHE_HOME/softure-compat` or `~/.cache/softure-compat` (`%LOCALAPPDATA%\softure-compat` on Windows) |
| Turn it off | `--no-download`, `SOFTURE_COMPAT_NO_DOWNLOAD=1`, or `"oasdiff": { "download": false }` |
| Behind a proxy | Node.js reads `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set |

A download that fails or does not match the checksum fails the `openapi` layer; it never passes unchecked. With
downloading turned off and no oasdiff found, the layer is skipped, and a skipped layer fails the gate unless you
pass `--allow-incomplete`. The report notes which oasdiff ran and where it came from. To install oasdiff yourself:

```sh
go install github.com/oasdiff/oasdiff@v1.33.0
```

## Quick start

```sh
npx softure-compat init    # writes compat.config.json from the files committed at HEAD
npx softure-compat check   # compares the refs in its "check" section; Markdown report on stdout, exit code for CI
```

`init` looks at the files committed at `HEAD` and writes every layer into `compat.config.json`. A layer whose inputs
it found is enabled; any other layer is written with `"enabled": false` and an example, so you can see what to fill
in. Review the file, adjust it, and remove `"enabled": false` from the layers you want. `init` never overwrites an
existing file unless you pass `--force`.

`init` also writes the refs `check` compares by default (see [Configuration](#configuration)). It reads the
repository's GitHub deployments (with the token and repository the [resolvers](#finding-the-production-ref) use):
the two environments with the most recent successful deployments become `base` and `revision`, the one named like
`prod` being the base, otherwise the one deployed less recently. A single deployed environment is compared with
`HEAD`. With no successful deployment, or when GitHub cannot be read, it writes `latest-tag` and `HEAD` and says why.

What `init` detects:

| Layer | Enabled when the commit has |
| --- | --- |
| `openapi` | `openapi*` or `swagger*` files (`.json`, `.yaml`, `.yml`); each becomes a `file` source |
| `sql-migrations` | `.sql` files mentioning `__EFMigrationsHistory` (EF Core idempotent scripts), or drizzle `meta/_journal.json` folders for PostgreSQL |
| `seed` | `.sql` files with `seed` in the name that are not migrations |
| `persisted-enums` | a `*DbContext.cs` calling `ConfigureEnum<T>()` (string storage) |
| `config` | compose files and `.env` examples at the default globs, without test and mobile app files; compose files the deploy tooling references win over the rest. Ansible templates (`KEY={{ var }}`), `lookup('env', 'KEY')`, `assert` tasks and workflow `env:` entries from `secrets.*` become `regex` sources joined in a `deploy` chain (the assert is `required`); a workflow `environment:` adds a `gh secret list` presence command |
| `dependencies` | MSBuild files and `package.json` files, without React Native and Expo apps; with NuGet, test packages (`Microsoft.NET.Test.Sdk`, `xunit*`, `nunit*`, `MSTest*`, `coverlet.*`, `*.Analyzers`, `Microsoft.CodeAnalysis.*`) are written as `ignore` |
| `message-contracts` | C# files under a folder whose name contains `Contract` or ends with `Messages`, one glob per such folder, kept when the folder name ends with `Messages` or `Events` or when an `IConsumer<T>`, `ConsumeContext<T>`, `IRequestClient<T>`, `Publish`/`Send<T>` or `Publish`/`Send(new T ...)` in the repository names one of its types; request DTO folders are left to `openapi`, and with none kept the layer is written disabled |
| `behaviour` | never: it is written disabled with example commands, since nothing in a repository says how its stack starts |

Folders named `node_modules`, `bin`, `obj` and `dist` are ignored. A test file is one under a `test`, `tests`,
`e2e`, `mocks` or `*.Tests` folder, or with such a word in its name (`docker-compose.integration-tests.yml`); a
mobile app is the folder of a `package.json` that depends on `expo` or `react-native`. Ansible files are those under
an `ansible`, `roles` or `playbooks` folder or next to an `ansible.cfg`; `stderr` lists every file `init` skipped. A SQL file is read as SQL Server when it has `GO`
batch lines or `[dbo]` names, otherwise as Postgres.

## Command line

```
softure-compat check [--base <ref>] [--revision <ref>] [options]
softure-compat init [--repo <dir>] [--config <file>] [--force]
```

| Option | Command | Meaning |
| --- | --- | --- |
| `--base <ref>` | check | git ref running in production, or a [resolver](#finding-the-production-ref) (default: `check.base` in the config) |
| `--revision <ref>` | check | git ref about to be released, or a [resolver](#finding-the-production-ref) (default: `check.revision` in the config) |
| `--repo <dir>` | both | repository directory (default: current directory) |
| `--config <file>` | both | config file (default: `<repo>/compat.config.json`) |
| `--format <md\|json>` | check | report format (default: `md`) |
| `--output <file>` | check | write the report to a file instead of stdout |
| `--fail-on <class>` | check | `breaking`, `rollback-risk`, `needs-action` or `never` (default: `check.failOn` in the config, then `breaking`) |
| `--allow-incomplete` | check | do not fail when a layer was skipped or failed |
| `--require <layer,...>` | check | fail the gate unless these layers ran: disabled, not configured, skipped or failed all fail it, even with `--allow-incomplete` |
| `--no-download` | check | never download oasdiff; the `openapi` layer is skipped when it is missing |
| `--force` | init | overwrite an existing config file |
| `-h`, `--help` | both | show the help |
| `-v`, `--version` | both | show the version |

**Exit codes:** `0` the gate passed (`init`: the config was written), `1` the gate failed, `2` the command could not
run (bad arguments, invalid config, a base or revision set neither on the command line nor in the config, unknown
ref, a resolver that found nothing, unreadable repository).

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
must be in the clone, so fetch the full history. The report header names both and where the value was set, e.g.
"Base github-deployment:prod → 2.2.4 `26b8973e1f0a` (config)" or "(--base)" when the flag set it; the JSON report
carries `"source": "config"` or `"flag"`. A branch literally named `latest-tag` has to be passed as
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
(unless `--allow-incomplete`). A failed layer still reports the findings it produced.

A layer that is `"enabled": false` (`disabled`) or missing from the config (`not configured`) does not fail the gate,
but the report never hides it: it gets a row in the summary table, a `Not checked: openapi (disabled), ...` line under
the gate, and an entry with `status` `disabled` or `not-configured` in the JSON `layers`. A pass without `openapi` says
nothing about the HTTP contract, so a pipeline that relies on a layer names it with `--require` (e.g.
`--require openapi,sql-migrations`).

Each layer accepts known findings with an `accept` list: every entry needs a `reason`, accepted findings stay in the
report under "Accepted", and an entry that matched nothing is reported as a note so stale entries get cleaned up.

### In CI

The GitHub Action runs the check, writes the report to the job summary and keeps one comment with the report on the
pull request, updated on every push. `needs-action` findings do not fail the default gate, so the comment is where the
person merging the release sees them.

```yaml
on: pull_request

permissions:
  contents: read
  deployments: read      # github-deployment:<environment>
  actions: read          # github-workflow:<file>
  pull-requests: write   # the report comment

jobs:
  compat:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # both refs must be in the clone
      - uses: SOFTURE/COMPAT@v0   # base, revision and fail-on come from "check" in compat.config.json
```

`@v0` follows the latest `0.x` release; pin `@v0.3.0` to stay on one version. The action runs the CLI version released
from the same commit, so the action and the CLI never drift apart.

| Input | Default | Meaning |
| --- | --- | --- |
| `base` | `check.base` | `--base`: a git ref or a resolver |
| `revision` | `check.revision` | `--revision` |
| `fail-on` | `check.failOn`, then `breaking` | `--fail-on` |
| `config` | `compat.config.json` | `--config`, relative to `working-directory` |
| `working-directory` | `.` | the repository directory |
| `args` | | extra CLI arguments, split on whitespace (`--allow-incomplete --no-download`) |
| `comment` | `true` | create or update the report comment on pull requests |
| `comment-key` | `default` | one comment per key, for several checks on one pull request |
| `package` | the released version | npm package spec of the CLI to run instead (a version or a tarball path) |
| `node-version` | `22` | Node.js set up for the CLI; empty keeps the job's Node.js |
| `github-token` | `github.token` | token for the resolvers and the comment |

Outputs: `exit-code` (0 passed, 1 gate failed, 2 could not run) and `report` (path of the Markdown report). The step
fails when the gate fails, after the summary and the comment are written. Without `pull-requests: write` (for example
on a pull request from a fork) the comment is skipped with a warning and the summary still has the report.

Without the action, run the CLI yourself. The check needs both refs in the clone, so fetch the full history (or at
least the production tag):

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm ci
- run: npx softure-compat check --base github-deployment:production --revision HEAD --output compat-report.md
  env:
    GH_TOKEN: ${{ github.token }}
```

The job needs `permissions: { contents: read, deployments: read, actions: read }` for the GitHub resolvers. A
literal ref (`--base "$PRODUCTION_TAG"`) works too.

No Go toolchain is needed: the first run downloads the pinned oasdiff (see [Install](#install)). Cache
`~/.cache/softure-compat` with `actions/cache` to skip the download, or pass `--no-download` on runners without
internet access and provide oasdiff yourself.

`--format json` gives a machine-readable report with the same content.

## Configuration

`check` and `init` use `compat.config.json` in the `--repo` directory (default: the current directory), or the
file `--config` names. Unknown keys are errors, so a
typo never silently disables a check. Every layer is optional; a configured layer runs unless it has
`"enabled": false`. All paths and globs are relative to the repository root; globs support `**`, `*`, `?` and
`{a,b}`.

The optional `check` section holds the defaults of `check`: `base`, `revision` (a git ref or a
[resolver](#finding-the-production-ref)) and `failOn`. Each command-line flag overrides its key, so `softure-compat
check` needs no flags once they are set; a base or revision set in neither place is exit code `2`.

```json
{
  "check": { "base": "github-deployment:prod", "revision": "github-deployment:dev", "failOn": "breaking" },
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
| `oasdiff.download` | `false` never downloads the pinned oasdiff (default `true`) |
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

### client-usage

oasdiff judges the contract, not what deployed clients do. This layer reads what the live builds of each client
call and send, and re-classifies the `openapi` findings of that client's API and the
[`enum-member-exposed-added`](#exposed-enums) findings of `persisted-enums`. It runs after both and needs at least one
of them enabled; it adds no findings of its own.

```json
{
  "clients": [
    {
      "name": "mobile",
      "api": "b2c",
      "refs": { "tags": "mobile-2.*", "since": "2.0.1" },
      "generatedClient": { "kind": "typescript", "path": "APP/MOBILE/B2C/services/api/petseo.client.ts" },
      "sources": ["APP/MOBILE/B2C/{app,components,services,hooks}/**/*.{ts,tsx}"]
    }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `clients[].name` | unique name (letters, digits, `.`, `_`, `-`), shown in reasons as `mobile@2.0.1` |
| `clients[].api` | the `openapi` API name this client calls |
| `clients[].refs` | the live client builds: a list of entries, or one selector on its own (see below) |
| `clients[].generatedClient` | `{ kind: "typescript", path }`: the generated client, read at every client ref |
| `clients[].sources` | optional globs of the client's own code; an operation then counts as called only when its client function is referenced there |

An entry of `refs` is one of:

| Entry | Resolves to |
| --- | --- |
| a git ref, e.g. `"2.2.4"` | that ref |
| a [resolver](#finding-the-production-ref): `"github-deployment:<environment>"`, `"github-workflow:<file>"`, `"latest-tag[:<glob>]"` | one ref, as for `--base`; a web client deployed with the server is `"github-deployment:prod"` |
| `{ "tags": "<pattern>", "since"?: "<version>" }` | local tags matching the `git tag --list` pattern, at or above the `since` version |
| `{ "workflowRuns": "<file>", "since"?: "<version or YYYY-MM-DD>" }` | the head commit of every successful run of that workflow, labelled by the run's tag or branch (the newest run per label); `since` keeps labels at or above a version, or runs created on or after a date |

For a mobile client built by a workflow on its tags, `{ "workflowRuns": "eas-prod.yml", "since": "2.0.1" }` lists
exactly the shipped builds, even when server tags are interleaved with them. The GitHub entries use the token and
repository of the `--base` resolvers, and more than 1000 successful runs need a date `since`. A resolver that finds
nothing, or a resolved commit missing from the clone, fails the layer. The layer notes name what each resolver
resolved to, e.g. `client "mobile": workflowRuns:eas-prod.yml since 2.0.1 → 2.0.1, 2.0.2, 2.1.1, 2.1.2, 2.2.4`.

What changes, per `openapi` finding of the client's API that is not accepted and not `safe`, for an operation
(`METHOD /path`):

- No client ref calls the operation → `safe`, reason `not called by mobile@2.0.1, 2.1.1, 2.2.4`.
- `request-property-became-required`, `new-required-request-property` or `request-property-became-not-nullable`, and
  every calling ref always sends the property (the typed body parameter is not optional and the property is declared
  without `?`, or without `null` for the not-nullable rule) → `safe`, with the declarations as evidence.
- Otherwise the class stays, the message names the refs that call the operation (or may omit the property), and the
  calls are added as evidence.

A re-classified finding keeps its rule id and shows `reclassified from <class> by client-usage: <reason>`; the JSON
report carries `reclassified: { from, by, reason }` and evidence with `side: "client"`.

The TypeScript reader understands NSwag, swaggie, orval, axios or fetch style clients (a path literal plus
`method: "POST"`, `.post(...)` or `request("post", ...)`) and openapi-typescript `paths`. Template holes, nested
template literals included (`` `/api/pets/${encodeURIComponent(`${petId}`)}` ``), read as path parameters. It fails
closed: a client ref missing from the clone (fetch tags, `fetch-depth: 0`), a generated client that is absent or
yields no operation, a URL string (`const url = ...`, `url: ...`) the reader could not turn into an operation, or
`sources` that match no file fail the layer and refine nothing. A path whose HTTP method cannot be read counts as
called with every method.

For an `enum-member-exposed-added` finding of an enum exposed through an API with clients, the layer scans the
`sources` of every live ref for code that branches on the exposed fields:

- No ref branches → `safe`, reason `no live client ref branches on NotificationDto.type: mobile@2.2.4`.
- A ref branches → the class stays, the message names the refs, and the branch sites are added as evidence.
- A client without `sources`, or an exposing API with no client, cannot prove the absence of a branch: the class
  stays and the message says why.

A branch is a `switch` over the property (the last segment of the field, compared case-insensitively) or the enum,
an equality (`===`, `!==`, `==`, `!=`) with an operand ending in the property or naming the enum, `case Enum.X`,
`Record<Enum, ...>` or `Record<Dto["property"], ...>`, `[key in Enum]`, or an index access `map[x.property]`. A
line that looks like a branch and holds the property or enum name where the scanner read no code (inside a template
literal, after a literal it lost) counts as a branch too, so a scanner miss never reads as "does not branch".

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

Dynamic SQL with a literal body (`EXEC(N'...')`, `EXEC sp_executesql N'...'`, `EXECUTE '...'` inside a `DO` body)
is unwrapped and its statements are compared like any other, with the lines of the outer file. Dynamic SQL without a
literal body (`EXEC(@sql)`, `EXECUTE format(...)`, concatenation), `COPY ... FROM` and `BULK INSERT` are reported as
`unreadable-write`. psql's `\copy` is a client command and is not read.

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
| `enums[]` `named` | an enum by `name`; `file` pins the declaration when several files declare that name; `exposed` lists where clients receive it (below) |
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
| `enum-member-exposed-added` | `needs-action`, only for an enum with `exposed` (below) |

#### Exposed enums

Many APIs send an enum to clients as a plain `string` DTO field, so the spec has no `enum` list and `openapi` cannot
see a new value. A named entry declares those fields:

```json
{
  "kind": "named",
  "name": "NotificationType",
  "storage": "string",
  "exposed": [{ "api": "b2c", "fields": ["NotificationDto.type"] }]
}
```

`api` is the API name used by `openapi` and `client-usage`; each field is `Type.property`. Every added member then
also gets `enum-member-exposed-added` (`needs-action`: old clients receive an unknown value in that field), with the
same subject and evidence as `enum-member-added`. It can be accepted like any other finding, and
[`client-usage`](#client-usage) re-classifies it by whether live client builds branch on the field.

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
| `compose` | `${VAR}` interpolation in compose files (default `files`: `**/{docker-compose,compose}{,.*}.{yml,yaml}`); `${VAR:-x}` has a default, `${VAR}` and `${VAR:?msg}` are required. Block scalars (`\|`, `>`) and multi-line quoted scalars are read, a `#` inside them is text. Pass-through `environment` entries (`- KEY`, `[KEY]`, `KEY:`, `KEY: ~`, also through `*alias` and `<<: *alias`) are required: the host supplies the value |
| `dotenv` | keys of `.env` examples (default `files`: `**/.env.{example,sample,template,dist}`, `**/{example,sample}.env`); with `valuesAreDefaults: false` (the default) every key is required, with `true` a key with a value has a default |
| `regex` | your own pattern over `files`: named group `key` and an optional `default`; `flags` from `i`, `m`, `s`, `u`; `comments` `none`, `hash` or `slash` blanks comments first. `key` builds the key from several named groups instead, e.g. `"{section}__{member}"`; a group can also come from `enclosing`, a pattern whose nearest match before the key lends its groups (the settings class around a member). A placeholder nothing fills stays empty |

Upgrading from 0.2.x: the `compose` source now also reads block scalars, multi-line quoted scalars and pass-through
`environment` entries, so a check that passed before may report keys it missed; record intended ones in `accept`.

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

`chains` compares sources with each other in the revision: in a chain, every key present in one source must be
present in all the others (matched after normalization), so a key added to `deploy-dev` but not to `deploy-prod`,
or to the compose file but not to the Ansible assert, is reported as `config-chain-missing`.

```json
"chains": [
  { "name": "app-env", "sources": ["compose", "ansible-template", "deploy-prod"], "required": ["ansible-assert"] },
  { "name": "dev-prod-parity", "sources": ["deploy-dev", "deploy-prod"] }
],
"accept": [{ "key": "DEBUG_TOOLBAR", "chain": "dev-prod-parity", "reason": "DEV only" }]
```

| Chain field | Meaning |
| --- | --- |
| `name` | unique chain name, shown as the finding scope `chain <name>` |
| `sources` | names of sources in the chain; together with `required` at least two |
| `required` | sources whose missing key is `breaking` (e.g. the assert that guards the deploy); a miss elsewhere is `needs-action` |
| `class` | overrides the class of every finding of the chain |
| `scope` | `changed` (default): only keys whose declarations differ between the refs in some source of the chain (added, removed, default changed); `all`: every key, for an audit |

A chain with a source that failed to scan is skipped with a note. Chain `accept[]` entries are
`{ key, chain, reason }` for an intentional asymmetry.

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
| `config-chain-missing` | `breaking` when a `required` source misses the key, else `needs-action`; `class` overrides |

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
| `nuget` | MSBuild files (default `files`: `**/*.{csproj,fsproj,vbproj,props,targets}`): `PackageVersion` (central package management), `PackageReference` and `GlobalPackageReference` with `Include` or `Update` and a version (`VersionOverride`, `Version` attribute or element); `$(Property)` is resolved from the same file; a reference without a version takes it from `Directory.Packages.props`; lockfile: `packages.lock.json` (versions 1 and 2) in the folder of a matched file |
| `npm` | `package.json` (default `files`: `**/package.json`); `sections` from `dependencies` (default), `devDependencies`, `peerDependencies`, `optionalDependencies`; lockfile: the nearest `package-lock.json` (versions 1 to 3) or `pnpm-lock.yaml` (5.x, 6.x, 9.x) in the manifest folder or above that installs it (workspaces), `package-lock.json` first |

`sources` defaults to both kinds; files under `node_modules`, `bin` and `obj` are skipped. Packages are compared by
name over all files of a ref (NuGet names case-insensitively). With a lockfile, a direct dependency compares by the
version the lockfile resolves, so `npm update` that moves `^4.1.0` from 4.1.0 to 4.9.0 in the lockfile only is
reported, and a `watch` package installed only as a dependency of another one is reported when its version changes
(the message says `resolved from lockfile` or `transitive, resolved from lockfile`; evidence points at the
lockfile entry). Other transitive packages are not read. When a lockfile resolves a package at a ref, its declared
versions at that ref are not compared. Without a lockfile, or with `lockfiles: false` on a source, a range compares
by its lower bound (`^1.2.3`, `[1.2,2.0)`). When projects declare several versions of one package, a version that went down anywhere is a
downgrade, otherwise the jump from the lowest base version to the highest revision version decides the class. The
layer fails when no dependency file matches at either ref, a `package.json` is not valid JSON, or a lockfile cannot
be read or has a version this list does not support (set `lockfiles: false` on the source to skip lockfiles).

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
| `queues[]` | `{ kind: "regex", name, files, pattern, flags?, comments?, report? }`: named group `queue`, else the first group; `flags` from `i`, `m`, `s`, `u`; `comments` `slash` (default), `hash` or `none`; `report: false` for a source that only feeds a `composed` one |
| `queues[]` | `{ kind: "composed", name, template, parts }`: names built at runtime, see below |
| `accept[]` | `{ id, subject, reason }`, matching the finding subject exactly |

Some brokers build queue names at runtime, for example `SOFTURE.MessageBroker.Rabbit` 1.x names a consumer group
queue `{Rabbit:Name}{GroupSeparator}{group}`. A `composed` source builds those names from what `regex` sources find
and compares them like any other queue source:

```json
{
  "queues": [
    { "kind": "regex", "name": "rabbit-endpoint", "files": "**/appsettings.json", "pattern": "\"Name\":\\s*\"(?<queue>[^\"]+)\"", "report": false },
    { "kind": "regex", "name": "group-separator", "files": "**/appsettings.json", "pattern": "\"GroupSeparator\":\\s*\"(?<queue>[^\"]+)\"", "report": false },
    { "kind": "regex", "name": "consumer-groups", "files": "**/ConsumerGroups.cs", "pattern": "const string \\w+ = \"(?<queue>\\w+)\"", "report": false },
    {
      "kind": "composed",
      "name": "group-queues",
      "template": "{endpoint}{separator}{group}",
      "parts": {
        "endpoint": "rabbit-endpoint",
        "group": "consumer-groups",
        "separator": { "source": "group-separator", "default": "." }
      }
    }
  ]
}
```

Every `{part}` of the template has an entry in `parts`: the name of a `regex` queue source, or `{ source?, default? }`.
A part takes every name its source finds at that ref, its `default` when the source finds none, or only `default`
without a source. The source gives one queue per combination of part values, and fails above 1000 of them. Its
evidence points at the last part, in template order, that came from a source. A `report: false` source gives no
finding and may find nothing at a ref; the `composed` source fails when it builds no name at either ref. A separator
that only lives inside a library (not in your configuration) is a `default`, so a library upgrade that changes it is
reported by [`dependencies`](#dependencies), not here.

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
| `message-property-nullability-changed` | `rollback-risk`: only `?` changed; the message says what a null does to a value type (fails to deserialize or reads as a default), to a reference type (deserializes, then throws where code dereferences it) or, for a type declared outside the sources, both |
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

### behaviour

Some changes no static layer can see: refactored code that must behave the same, query-string binding, payloads
opened by old app versions. The layer starts the revision's stack, runs the **base** ref's black-box tests against
it and reports every base test that fails there. It knows no stack: it runs your commands, each inside the
materialized tree of its side.

```json
{
  "start": { "run": "SCRIPTS/rebuild-integration-stack.sh", "timeoutSeconds": 1800 },
  "test": {
    "run": "dotnet test APP/API/TESTS/PETSEO.Integration.Tests --logger trx",
    "results": { "kind": "trx", "path": "**/TestResults/*.trx" }
  },
  "stop": { "run": "docker compose -f VPS/DOCKER/TESTS/docker-compose.integration-tests.yml down -v" },
  "retries": 1,
  "baseline": true,
  "accept": [{ "test": "PETSEO.Integration.Tests.Legacy.*", "reason": "asserts the old paging on purpose" }]
}
```

| Key | Meaning |
| --- | --- |
| `start` | `{ side?, run, background?, ready?, timeoutSeconds? }`, optional. `side` is `revision` (default) or `base`. A script runs to completion (default timeout 1800 s, a non-zero exit fails the layer); with `background: true` the command is a long-running app, kept alive during the tests and stopped with its whole process group afterwards, and `ready` (an http(s) URL) is polled until it answers 2xx within `timeoutSeconds` |
| `test` | `{ side?, run, results: { kind, path }, timeoutSeconds? }`. `side` is `base` (default) or `revision`; `kind` is `junit` (JUnit XML) or `trx`; `path` is a glob or list of globs relative to the tree root; default timeout 3600 s |
| `stop` | `{ side?, run, timeoutSeconds? }`, optional; `side` defaults to `revision`, timeout to 600 s. It always runs, also after a failed `start`, a test timeout or unreadable results |
| `retries` | 0 (default) to 5: the test command reruns while tests fail; a test that passes in any attempt passes, with a note |
| `baseline` | `true` runs a whole cycle with every command at the test side first (base tests against the base stack); tests failing there are not reported |
| `accept[]` | `{ test, reason }`; `test` is the full test name, `*` matches any run of characters |

Every command runs through the shell with `COMPAT_SIDE`, `COMPAT_REF` and `COMPAT_COMMIT` of its own tree and
`COMPAT_PORT`, a free TCP port picked for the cycle; `{port}` in `run` and `ready` is replaced by it, so tests can
reach a background app. The exit code of the test command is ignored when result files exist (failing tests exit
non-zero); files matching `results.path` are deleted before each attempt. A test name is `classname.name` in JUnit
XML and the full method name in TRX.

| Finding id | Class |
| --- | --- |
| `base-test-failed` | `breaking`: the base test failed (or errored, or timed out) against the stack; the message holds the first lines of its failure |

The layer fails, keeping its findings, when `start` fails or the app is not ready in time, when the test command
times out, cannot start, writes no result file or results without any test case, when a result file is not valid
JUnit XML or TRX, and when `stop` fails (the stack may still be running). `init` writes it disabled with example
commands: nothing in a repository says how its stack starts. The materialized trees are shared with the other layers of the run.

## What it does not check yet

The v1 acceptance case is the PETSEO 2.2.4 → 2.3.4 release. The tool reproduces its HTTP contract, schema, data
migration, seed, persisted enum, configuration and dependency findings (covered by `test/e2e/acceptance.test.ts`), and
its message contracts and queues (`test/e2e/message-contracts.test.ts`). Query-string binding changes, push payloads
opened by old app versions and behaviour of refactored code are caught only by your own black-box tests through the
[`behaviour`](#behaviour) layer; messaging library behaviour beyond the version change is not checked. Further layers
are planned in
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
4. moves the major tag (`v0`) to that commit, so `uses: SOFTURE/COMPAT@v0` runs the new release (not for a
   prerelease).

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
