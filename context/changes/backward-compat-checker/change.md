---
change_id: backward-compat-checker
title: "An npm CLI tells, for two git refs, whether the new server release is backward compatible with what runs in production"
status: plan_reviewed
roadmap_item: CMP-1
branch: null
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Intent
Before a server release goes to production, the owner runs one command with two git refs (the one in production and
the candidate) and gets a verdict per layer (HTTP API, database migrations and seeds, persisted enums, message
contracts, configuration, behaviour). Each finding is classified as `safe`, `needs-action`, `rollback-risk` or
`breaking`, with evidence. The command exits non-zero on `breaking`, so it can gate CI and the deploy workflow. The
main use case: deploying the server ahead of a mobile app that is still waiting for store review, while older app
builds keep calling the API.

The tool is a new SOFTURE package published on npm, usable in every SOFTURE project, not only in PETSEO. PETSEO is
the first consumer and the acceptance case.

## Context
Origin: the owner's request on 2026-10-07, after a manual analysis of PETSEO `2.2.4` (production) against `2.3.4` (DEV).
The owner wanted 100% certainty that the server could ship before the B2C app passes review. The analysis took one
long session: oasdiff on locally generated OpenAPI specs, plus three agents reading the migrations, the worker and
messaging, and every contract the 2.2.4 app uses. The owner then asked for an internet search for existing tools and
for a CLI, based on Swagger and SQL, so the next release does not need a manual analysis. Requests, translated from Polish:

> Do some research on whether there is a tool that verifies backward compatibility. Maybe we can rely on
> verifying the database scripts and the newly delivered endpoints. Maybe we can build a CLI that verifies this
> kind of solution in the future. The tool could rely, for example, on Swagger and on the SQL we have in the
> database, and verify that way whether we are backward compatible.

> I would like this to be a new package in the SOFTURE project, compatible with the other projects. (...) A new
> project in this organisation: https://github.com/SOFTURE. For now save the change here locally on the PC; later we
> will create folders in the right directories and you will move the whole analysis of this tool there. I would
> like it to be an npm tool, available from npm.

What is known today is in `research.md`: the tool landscape, the stacks of the SOFTURE projects, the PETSEO
2.2.4 → 2.3.4 findings that serve as acceptance fixtures, and a first design sketch.

## Constraints
- **Home:** the repository `SOFTURE/COMPAT`. The change was drafted in PETSEO on 2026-10-07 and moved here the
  same day; nothing of it stays in PETSEO. PETSEO is the first consumer and the acceptance case (`research.md` §1),
  not the place where the tool is built.
- **Public repository** (owner's decision, 2026-10-07), so any project can use it. It never holds secrets.
  `research.md` names PETSEO paths and secret *names* (no values) as acceptance fixtures; that is intended.
- **Distribution:** an npm package with a `bin`, Node >= 22. Follow the SOFTURE npm conventions of
  `@softure-ai/skills` and `@softure-ai/deploy`: `type: module`, `publishConfig.access: public`,
  `provenance: true`, MIT.
- **Stack-agnostic core.** Stack-specific checks (EF Core, FastEndpoints/NSwag, Swashbuckle, MassTransit, drizzle,
  SQL Server, Postgres) are adapters selected by a config file in the consumer repo. The core must not assume .NET.
- **Works from git, never from production.** Inputs are two refs of the consumer repo. Nothing connects to a
  production server or database. Live endpoints are optional inputs only (for example a DEV Swagger URL).
- **A standalone repository and CLI, separate from SOFTURE AI** (owner's decision, 2026-10-07). It is not a
  `tools/*` workspace in `SOFTURE/AI` and does not depend on `@softure-ai/*` packages. `@softure-ai/deploy` may call
  it later as an ordinary external CLI; nothing more is shared.
- **Names:** package `@softure-ai/compat` (the scope is only a namespace, as for `@softure-ai/skills` in its own
  repository), binary `softure-compat`, repository `SOFTURE/COMPAT`.

## Notes
- 2026-10-07: research written from the PETSEO 2.2.4 → 2.3.4 analysis.
- 2026-10-07: names decided and the folder moved from PETSEO into `SOFTURE/COMPAT`. Next step: `softure-plan`.
- 2026-10-07: the owner handed the project over for autonomous delivery. The intent above is the product goal of
  roadmap v1 (`context/foundation/roadmap.md`). This change delivers its first item, CMP-1: the core command
  (config, git refs, finding model, reports, exit codes) and the `openapi` layer. The other v1 layers are
  CMP-2 to CMP-5, release readiness is CMP-6, and the later layers wait in `context/backlog/later-layers.md`.
