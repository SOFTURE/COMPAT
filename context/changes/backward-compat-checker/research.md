# Research: backward-compat-checker

Written 2026-10-07, from one PETSEO session: a manual compatibility analysis of `2.2.4` (production) against `2.3.4`
(DEV), plus a web search for existing tools. Facts about PETSEO carry evidence paths at tag `2.3.4`. Facts about
other repositories come from a quick scan of `~/Documents/repos` and are marked as such.

## 1. The problem in one example (PETSEO 2.2.4 → 2.3.4)

Production ran server and mobile build `2.2.4`. DEV ran `2.3.4`: 120 commits, 342 backend files (shop, feature flags,
terms-change broadcast, 79 breeds, a worker refactor). The question: can the server ship before the mobile app passes
store review, while builds 2.0.x–2.2.4 keep calling it?

Answering took: generating OpenAPI specs from both tags, running oasdiff, and three read-only agents (B2C contracts
used by the old app, DB migrations and seeds, worker/messaging/infra). Every layer below produced at least one finding
that a single tool would not have caught. These findings are the **acceptance fixtures** for the tool: run on PETSEO
`2.2.4..2.3.4`, it must report each of them with the given class.

| # | Layer | Finding | Expected class | Evidence |
|---|---|---|---|---|
| F1 | HTTP API | 15 endpoints added (`/api/shop/*`, `GET /api/feature-flags`), none removed, no response change | `safe` (info) | oasdiff changelog on specs exported from both tags |
| F2 | HTTP API | `daysOfWeek` in `POST /api/pets/{petId}/medications` and `PUT .../{MedicationId}` became not nullable | `breaking` by contract, **false positive in reality**: the old app always sends an array, and the handler does `?? []` | oasdiff `request-property-became-not-nullable`; `AddMedicationCommand.cs:22`, `UpdateMedicationCommand.cs:23`; app `2.2.4:app/(protected)/pet/medication-history/[id].tsx:192` |
| F3 | HTTP binding | query number parser changed from `NumberStyles.Any` to `NumberStyles.Float` for double/float/decimal | `safe` for existing clients (only lat/lon, JS always prints `.`) | `SHARED/PETSEO.API.Common/Binding/InvariantNumberParser.cs` |
| F4 | DB schema | only new schema/tables (`system.FeatureFlags`, `notifications.NotificationBroadcasts`), no drop/rename/NOT NULL on existing tables | `safe` | `SHARED/PETSEO.DB.Upgrade/Scripts/migrations.sql:2916-3179` |
| F5 | DB data migration | 79 breeds inserted with explicit IDs 418–496 | `needs-action` (precondition: production `max(Id)` is 417) | `Migrations/20261005073152_AddMissingPetBreeds.cs` |
| F6 | Seed | 3 new `TermsChange` templates, `ON CONFLICT DO UPDATE`, nothing updated or deleted | `safe` | `seed.sql:493-511` |
| F7 | Persisted enum | `NotificationType.TermsChange` added; the enum is stored as a string (`ConfigureEnum`) | `rollback-risk`: once a row exists, `2.2.4` throws on `Enum.Parse` (500 on the notification list) | `PetseoDbContext.cs:188` |
| F8 | Messages | no existing message contract changed; 3 new messages; new queue `PETSEO.Worker.Sync.Broadcast` | `safe` (info) | `SHARED/PETSEO.Contract.Internal.Messages/NotificationBroadcasts/`, `Worker.Sync/Common/Messaging/ConsumerGroups.cs` |
| F9 | Messaging runtime | `SOFTURE.MessageBroker.Rabbit` 0.4.0 → 1.2.0 changes the retry policy to a single `Immediate(10)` | `needs-action` (know it) | `APP/Directory.Packages.props` |
| F10 | Config | new required settings `Shop__BaseUrl`, `Shop__ApiKey` (`required` + Ansible assert) | `needs-action`: the secret must exist in the production environment | `ApiSettings.cs:42`, `VPS/ANSIBLE/roles/petseo-app/tasks/main.yml:29-30` |
| F11 | Push payload | new push with `data.url = https://petseo.pl/terms`; the old app opens it externally | `safe` | `OnNotificationBroadcastRecipientMessageConsumer.cs:42` |
| F12 | Behaviour | worker jobs refactored to specifications; same selection and run policy | `safe`, provable only by tests or by reading line by line | `Worker.Sync/Infrastructure/Jobs/*` |

What took the time: F2, F3, F7, F11 and F12. No contract-diff tool decides them; they need knowledge of what the old
clients actually send and receive, or a behavioural test.

## 2. Existing tools (web search 2026-10-07)

| Layer | Tool | Licence / distribution | Fit |
|---|---|---|---|
| OpenAPI diff | **oasdiff** (github.com/oasdiff/oasdiff) | Apache-2.0, Go binary, Docker `tufin/oasdiff`, GitHub Action `oasdiff/oasdiff-action/breaking` | Best open-source option: 755 classified checks, `breaking` / `changelog` / `summary`, `--fail-on WARN`, `--flatten-allof`, per-check severity overrides. **Verified in this session**: it found F1 and F2 on PETSEO specs. Not on npm: wrap the binary (download a pinned release with checksum, or use Docker). |
| OpenAPI diff | openapi-diff (OpenAPITools) | Java | Fallback only. |
| OpenAPI diff | Optic | archived 2026-01-12 (acquired by Atlassian in 2024) | Dead. |
| OpenAPI diff | SpecShield, ApiNotes, Bump.sh | SaaS | Not needed. |
| Postgres migrations | **Squawk** (github.com/sbdchd/squawk) | npm `squawk-cli`, pre-commit hook | Lints SQL: `adding-required-field`, dropped/renamed columns, unsafe locks, `ADD COLUMN ... DEFAULT`, `SET NOT NULL`, non-concurrent indexes. Postgres only. |
| Postgres migrations | Atlas `migrate lint` | `destructive` and `incompatible` analyzers; since v0.38 (Oct 2025) lint needs the paid Pro plan | Too costly for the gain. |
| Postgres migrations | MigrationPilot | npm `migrationpilot`, claims 112 rules | Unverified alternative to Squawk. |
| SQL review | Bytebase | 200+ rules, 8 engines, a platform | Too heavy; it is a product, not a library. |
| .NET contracts | **Microsoft.DotNet.ApiCompat.Tool** | dotnet global tool | Compares two assemblies. Catches renamed or moved message types (MassTransit routes by type URN), removed members, changed types. Needs both refs built. |
| EF Core | `dotnet ef migrations script --idempotent` | built in | Produces the SQL that Squawk can lint. EF has no destructive-operation flag (dotnet/efcore#31319, open). |
| Consumer-driven contracts | **Pact** + Pact Broker `can-i-deploy` | open source plus broker | The only thing that knows which client versions run in production and what each one really uses. Needs contract tests in every client and a broker. Too much for now; a lighter substitute is in §4 (client usage). |
| Database pattern | expand–contract | practice | The rule the checks enforce: old and new app versions must both work on the migrated schema, and rollback must still read it. |

FastEndpoints (PETSEO) can export the spec without serving it: `ExportSwaggerJsonAndExitAsync` (FastEndpoints
ClientGen extensions). Swashbuckle has `swagger tofile` (Swashbuckle.AspNetCore.Cli).

## 3. SOFTURE projects the tool must serve (quick scan, unverified beyond file listings)

| Project | Backend | DB / migrations | API description | Messaging | Clients |
|---|---|---|---|---|---|
| PETSEO | .NET 10, FastEndpoints | EF Core + Postgres/PostGIS; idempotent `migrations.sql` + `seed.sql` + `custom-scripts.sql`, run by a one-shot `petseo-db-upgrade` container | FastEndpoints.Swagger (NSwag), served at `/swagger/v1/swagger.json`, hidden on production | MassTransit via `SOFTURE.MessageBroker.Rabbit` | RN app with a generated TS client (`petseo.client.ts`), B2B/ADMIN web deployed with the API |
| CRM_SOLTUM | .NET (`CRM.sln`) | EF Core **SQL Server** | Swashbuckle | MassTransit, `SOFTURE.MessageBroker.Rabbit` | to check |
| CABB | .NET (`CABB.sln`) | EF Core **SQL Server** | to check | MassTransit.RabbitMQ, `SOFTURE.MessageBroker.Rabbit` | to check |
| MENEDZER_PEPSI | .NET (`ManagerPepsi.sln`) | EF Core **SQL Server** | to check | — | to check |
| FIRE_TRACKER | Next.js | drizzle (Postgres), `drizzle/` | to check | — | web |
| REELCHEF | Node backend + mobile | `backend/migrations/` (type to check) | to check | — | mobile |
| SOFTURE/AI apps | Next.js | `@softure-ai/db` migration ledger `softure.migrations` | — | — | web |

Consequences: SQL Server is a first-class dialect, and Squawk covers only Postgres. The SQL Server rules must be our
own (a parser such as `node-sql-parser` with `transactsql`, or an MSSQL-aware rule set). Two OpenAPI generators
(NSwag, Swashbuckle) must be supported through one "how to get the spec" adapter.

**Overlap with `@softure-ai/deploy`** (`SOFTURE/AI/tools/deploy`): it already does `release-report` between two
tags and `schema-guard` (checksums of applied migrations against the image's migration folder, refuses an image older
than the ledger). Neither one judges backward compatibility, but the report is the natural place to print this tool's
verdict.

## 4. Design sketch (input for `softure-plan`, not decided)

```
npx <cli> check --base 2.2.4 --revision 2.3.4 [--config compat.config.json] [--format md|json] [--fail-on breaking]
```

- **Refs, not servers.** The tool extracts both refs with `git archive` into a temp dir. It never builds inside the
  consumer's working tree.
- **Layers as adapters**, each enabled and configured in `compat.config.json`. An adapter returns findings
  `{ layer, id, class, message, evidence: { ref, path, line } }`.
  1. `openapi`: gets one spec per API and per ref from a file in the repo at that ref, an export command (FastEndpoints
     `--exportswaggerjson`, `swagger tofile`) or a URL. It runs oasdiff `breaking` + `changelog` and maps oasdiff
     levels to the four classes. A per-repo allowlist (`accept: [{ check, path, reason }]`) records reviewed false
     positives such as F2.
  2. `client-usage` (optional, the cheap Pact substitute): for each live client ref (e.g. mobile builds
     `2.0.0..2.2.4`), it reads the client's generated API code (an NSwag/openapi-typescript client) and limits
     `breaking` to operations and fields that client actually calls. This would have turned F2 into `safe` with
     evidence.
  3. `sql-migrations`: takes only the migrations new in `revision` (EF idempotent script diff, EF `Migrations/`
     folder, drizzle folder, plain SQL folder). For Postgres it runs `squawk-cli`. For SQL Server it runs its own
     rules. Shared own rules: drop/rename of table or column, type change, NOT NULL without default on an existing
     table, an insert with explicit IDs (emits a precondition, F5).
  4. `seed`: scripts that run on every deploy. It flags `UPDATE`/`DELETE`/`TRUNCATE` outside `ON CONFLICT` / `MERGE`
     guards, and a removed upsert.
  5. `persisted-enums`: given the list of enums persisted as strings or ints (PETSEO: every `ConfigureEnum<T>`), it
     marks a removed/renamed member as `breaking`, a renumbered member (int storage) as `breaking`, and an added
     member as `rollback-risk` (F7).
  6. `message-contracts` (.NET): ApiCompat on the configured contract assemblies (PETSEO:
     `PETSEO.Contract.Internal.Messages`). It also lists new consumer endpoints and queues.
  7. `config`: new keys in compose `${VAR}` and in required settings. A new required key without a default is
     `needs-action` (F10). Own implementation: no dependency on `@softure-ai/*`.
  8. `behaviour` (optional, slow): runs the base ref's black-box test suite against the revision's stack through a
     configured command. PETSEO: `SCRIPTS/rebuild-integration-stack.sh` from revision, then the `PETSEO.Integration.Tests`
     project from base. This is the only layer that proves F12-type claims.
- **Output:** a Markdown report (GitHub Release body, PR comment, `@softure-ai/deploy` release report) and JSON.
  Exit code: non-zero when any finding is at or above `--fail-on`.
- **Packaging:** a stack-agnostic core plus adapters in one package first. Split into plugins only if .NET tooling
  (dotnet SDK, ApiCompat) makes the install heavy for Node-only consumers. External binaries (oasdiff, dotnet) are
  detected and a missing one is reported as `skipped`, never as `safe`.

## 5. PETSEO-side follow-ups the tool would need (separate PETSEO changes later)

- Export the spec at build time (`ExportSwaggerJsonAndExitAsync`) or commit `openapi/<api>.json` on every release,
  so the `openapi` adapter does not have to run the API. In this session the 2.2.4 spec was obtained by
  `git archive` + `dotnet run --no-launch-profile` + `curl /swagger/v1/swagger.json`, because production hides it.
- A `compat.config.json` in PETSEO: 4 APIs (B2C, B2B, ADMIN, Internal), Postgres, `migrations.sql` + `seed.sql`,
  `ConfigureEnum` list, message contract assembly, live mobile refs, integration-test command.
- A step in `deploy-prod.yml` (or a manual pre-deploy step) that runs the check against the currently deployed tag.

## 6. Open questions

1. ~~Repository~~ **Decided 2026-10-07:** a new standalone repository in the SOFTURE GitHub organisation, not part
   of `SOFTURE/AI`; it shares only the npm scope.
2. ~~Repository, npm and binary name~~ **Decided 2026-10-07:** `SOFTURE/COMPAT`, `@softure-ai/compat` (free on
   npm, the `softure-ai` organisation already exists), binary `softure-compat`.
3. **oasdiff distribution:** download a pinned binary (needs checksums per OS/arch) or require Docker?
4. **Which layers are v1:** the minimum that would have saved this session is `openapi` + `sql-migrations` + `seed` +
   `persisted-enums` + `config`. `client-usage`, `message-contracts` and `behaviour` could follow.
5. **SQL Server rules:** own parser rules, or a mature MSSQL linter (none found in this search; needs a second look)?
6. **How the tool learns which client versions are live:** a static list in the config, or the store or
   Sentry release data?
