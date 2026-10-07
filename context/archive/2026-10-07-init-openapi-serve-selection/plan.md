# Plan: init-openapi-serve-selection

Input: change.md, issue #44, `src/commands/init.ts`, `src/layers/openapi/config.ts`. Complexity: small.

## Goal
A project gets a proposed `serve` source only when it is executable and, if any candidate registers a spec in its
own sources, it is one of them; two or more APIs listed by one solution get `setup` with `dotnet build` and
`--no-build` runs. Every project left out is named in the summary with the reason.

**Out of scope:** a different spec URL for `MapOpenApi` (`/openapi/v1.json`); following `ProjectReference` to
find spec registrations in shared libraries; committed-spec detection (unchanged).

## Approach
**Starting point:** `detectServedOpenapi` took every `*.csproj` with a Swagger package reference and emitted one
`dotnet run` serve source per project.

**Chosen:** three filters in order.
1. Executable: `Microsoft.NET.Sdk.Web` anywhere in an `Sdk` attribute, or `<OutputType>Exe</OutputType>`.
   Others are left out as "class library".
2. Spec call: the `.cs` files owned by the project (its folder, minus folders of nested projects) contain
   `SwaggerDocument(`, `AddSwaggerGen(`, `AddOpenApiDocument(` or `MapOpenApi(`. When at least one executable
   candidate has a call, the rest are left out as "no spec registration found". When none has one, the
   registration probably lives in a shared library, so all executable candidates stay and the summary says so.
3. Shared build: with two or more APIs, the deepest `*.sln`/`*.slnx` whose folder contains every API project and
   whose text names every project file gives `setup: { run: "dotnet build <solution> -c Debug" }`, and each run
   gets `--no-build`.

**Key decisions:**
| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| No candidate calls a spec method | keep all executable candidates, with a note | registration may sit in a referenced library; dropping all would lose real APIs | plan |
| Solution choice | deepest folder containing all API projects, naming each `.csproj`; ties by path order | the closest solution builds the least and is the one the APIs belong to | plan |
| Single API | keep `dotnet run` without setup | one build per side already; issue asks for setup only with several APIs | issue #44 |
| Setup timeout | layer default (600 s) | matches the issue's proposal; user tunes it on review | issue #44 |

## Phase 1: Detector, tests, README
1. `init.ts`: executable check, spec-call check, solution lookup, summary notes.
2. `test/commands/init.test.ts`: class library left out; executable without a call left out; fallback when no
   candidate calls; shared solution setup with `--no-build`; no setup for one API; no setup when no solution names
   all projects.
3. README `init` section, if it describes the serve proposal.

## Risks and rollback
- A web project registering its spec only through a shared extension is kept only by the fallback; if another
  candidate calls directly, it is left out, and the note names it so the user can add it back.
- Rollback: revert the commit; `init` output only, no runtime behaviour changes.

## Progress
### Phase 1: Detector, tests, README
- [x] Detector (Web SDK via `Sdk=` attribute or `<Sdk Name=...>` element)
- [x] Tests
- [x] README
