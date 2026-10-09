# SOFTURE COMPAT: agent rules

`@softure-ai/compat` is a standalone npm CLI (`softure-compat`) that tells, for two git refs of a consumer
repository, whether the new server release is backward compatible with what runs in production. It is
stack-agnostic: .NET, EF Core, SQL Server, Postgres, drizzle, OpenAPI and message contracts are adapters.
It shares only the npm scope with `SOFTURE/AI`: no code, no dependency on other `@softure-ai/*` packages.

## Language: English only in code

Everything that lands in the repository is written in **English**: code, identifiers, comments,
commit messages, script output, log and error messages, file and folder names, configuration keys,
and skill or agent instructions. This holds even when the conversation with the owner is in Polish.

- Do not translate the conversation into the code. A Polish request still produces English code.
- When you touch a file that contains Polish code, comments or identifiers, translate them in the
  same change.
- Before every commit, check the diff for Polish (Polish diacritics and Polish words). Treat any hit
  as a failing gate.

## Commits

Commits, pushes and merges follow the operating mode in `context/workflow.json` (`autonomous`): see
`## Operating mode: autonomous` in the SOFTURE block below.

<!-- softure-skills:begin (managed by @softure-ai/skills, do not edit) -->
# SOFTURE workflow and conventions

Installed by `@softure-ai/skills`. Project-specific rules outside this block take precedence,
except the language rule below (when this block carries it), which always applies.

## Language: English in everything you write to the repository (mandatory)

Code, identifiers, comments, commit messages, script and log output, error messages, file and
folder names, configuration keys, and agent or skill instructions are written in **English**.
This holds even when the conversation with the user is in another language.

- A request in another language still produces English code. Do not carry the conversation
  language into the code.
- The only exception is user-facing product copy. It lives in message dictionaries
  (e.g. `messages/pl.ts`), never inline in code.
- When you touch a file with non-English code, comments or identifiers, translate them in the
  same change.
- Before every commit, scan the diff for non-English text outside message dictionaries. Any hit
  is a failing gate, just like a red test.

## How work flows

Work happens as a chain of skills. Each one leaves a file in `context/` that the next one reads.
The full contract is in `node_modules/@softure-ai/skills/WORKFLOW.md`.

- **Product:** `softure-init` → `softure-shape` → `softure-prd` → `softure-roadmap`. Use
  `softure-frame` whenever the problem itself is in doubt.
- **One change:** `softure-new` → `softure-research` → `softure-plan` → `softure-plan-review` →
  `softure-implement` → `softure-impl-review` → `softure-archive`.
- **In parallel:** `softure-worktree` runs one change end to end in its own worktree.
  `softure-worktree-manager` runs several at once and merges them.
- **Any time:** `softure-code-review`, `softure-rule-review`, `softure-lesson`.

**Every change goes through the chain, however small.** A one-line fix reported in chat is a change
too (`roadmap_item: null`). `new`, `plan`, `plan-review`, `implement`, `impl-review` and `archive` are
never skipped. `research` and `frame` may be skipped only with a one-line reason under `## Notes` in
`change.md`. `research.md`, `plan.md` and `reviews/plan-review.md` exist before the first edit of
source code. Only the owner can waive this, for one named change, and only in manual mode.

**The project's operating mode** is `mode` in `context/workflow.json`: `manual` (also when the key is
missing) or `autonomous`. Its rules are the `## Operating mode` section below; it is the only mode
section in this block. Switch modes only on the owner's explicit word: set `mode`, re-run the installer
(`npx softure-skills`) so this block follows, commit both as `docs(rules): switch to <mode> mode`.

Execution state lives only in the `## Progress` section of `plan.md`. Commands, the main branch
and the artifact language come from `context/workflow.json`. Before building anything generic
(auth, mail, feature switches, billing, GDPR, analytics, UI primitives), check the
`@softure-ai/*` modules.

## Operating mode: autonomous

The owner sets the goal and is away. **`mode: "autonomous"` in the committed project config is the
owner's standing consent** for everything below: deciding every question the chain asks (`--auto` is
implied for every skill), committing, pushing session branches, opening and merging pull requests,
resolving conflicts, closing the issues the work solves, starting and resolving sessions (threads),
and running report routines. It lives in the repository, so every session reads it here itself; it
is not consent relayed by another session. A coordinator's brief points to this section instead of
quoting chat messages. A production deploy is never covered (see Releases).

**Decide, don't ask.** Take the recommended option and record it under `## Decisions (auto)` in the
artifact. Small product decisions are yours: the owner trusts the recommendation and corrects it
later. Prefer the simplest solution that meets the intent. No decision cards, no "shall I…?", no
"waiting for the owner" for anything this section covers. Escalate only for: a destructive or
irreversible action nobody asked for, a secret or access only the owner has, scope that contradicts
`change.md`, a measurement that refutes the item's premise, or an idea for a new product or package
(tell the owner in the project chat to plan it together; file nothing).

**Coordinator and sessions.** When work runs in parallel (a cloud project chat with threads, or
`softure-worktree-manager` locally), one session coordinates:
- The coordinator plans, writes briefs, starts sessions, owns the merge queue and reports. It writes
  no code: every fix, even one line, becomes a change in its own session.
- One session = one change (one issue). Very similar tiny items may share a session; items that touch
  the same files go to the same session or wait. A planning session hands its result to the
  coordinator and is closed. Before starting a session, check that the item has none yet.
- Run as many sessions as are parallel-safe; `worktree.maxParallel` is a soft default.
- **The roadmap keeps rolling:** the moment a merge unblocks an item, start its session. Never wait
  for the rest of the wave.
- A brief names the item ID and change-id, the outcome, the base branch, the files it owns, what it
  waits for, the merge path below, what to report back, and "follow AGENTS.md → Operating mode:
  autonomous". Project-specific standing orders are appended.
- **Session hygiene:** a session whose change is merged and archived is marked resolved at once
  (`set_thread_resolved` or the harness's equivalent). No standing sessions: the board shows only
  live work. A session stays open only while an owner action gates its result. Stalled sessions
  (waiting on CI, stopped by a usage limit) are nudged on every report.
- A new question about the roadmap goes to a new session; the old one is closed.
- After every finished session the coordinator states the concrete result in the project chat: what
  changed, the pull request, the merge SHA, the released version if any.

**Merging.**
- A session reports READY to the coordinator and waits for its go. Merges are serial, first ready
  first merged. Without a coordinator the session merges itself at READY. A ready merge never waits
  for the owner, and no report says "waiting for the owner's merge".
- Right before merging, merge the fresh main branch into the branch and resolve conflicts yourself.
  The main branch is the source of truth: what it has and the branch lacks is pulled in and wired.
- `autonomy.merge: "pr"` (default): open a pull request (`Closes #N` when it solves an issue), wait for
  green checks, merge it on the forge; the forge deletes the head branch. `"push"`: `git merge --no-ff`
  locally, then push the main branch through the pre-push hook.
- When one session has had to chase the main branch several times, the coordinator tells the others
  to hold their merges until it lands.
- Hooks stay on: never `--no-verify`, never force-push, never disable or loosen a test to get green.
  Long hooks run in the background with the longest timeout; a hung one is killed by its PID and
  re-run.
- The main branch is already tested: do not re-run gates on it to review it. The full integration
  suite runs per `integration.cadence`, never per push.

**Reports** (coordinator, in the project chat, in the language the owner writes in, which may differ
from the artifact `language`, with times in `timezone`):
- when: after every batch of session starts, and every `autonomy.reports.every` minutes (default 30)
  at fixed marks (:00, :30) inside `autonomy.reports.hours`, only while work runs. Each report
  schedules the next one; stop the chain when nothing runs. After a pause (usage limit) name the
  reports that were skipped.
- shape, the same in every project: a title line, a progress line, **one table with every item of
  the roadmap or issue wave** (not only the running ones), then three short lines. Columns, always
  these four, in this order (headers in the report's language, e.g. Polish `ID | Co robi | Etap | Link`):
  - **ID**: the roadmap item ID, an uppercase prefix of two or three letters plus a number (`FC-5`,
    `SA-12`, `CMP-3`); in issue mode the issue number (`#42`). Bold, nothing else in the cell.
  - **What it does**: the outcome in a few words, for someone who did not read the roadmap.
  - **Stage**: one of `waiting for <IDs>`, `research`, `frame`, `plan`, `plan-review`,
    `implement N/M`, `impl-review`, `integration`, `archive`, `ready to merge (PR #N)`,
    `merging (PR #N)`, `on <main> @ <sha>`, `released <version>`, `blocked (<why>)`; add `stalled`
    when the session has not moved since the last report.
  - **Link**: a markdown link to the session (thread) that carries the item, `[session](<url>)`;
    `—` when it has none. Never a forge URL: the PR number lives in Stage.
- example (every 30 minutes, coordinator of a project with roadmap prefix `SA`):

  ```markdown
  **Roadmap report softure-auth, 14:30 (Europe/Warsaw)**
  Progress: 3 of 6 on master, 2 running, 1 waiting

  | ID | What it does | Stage | Link |
  | --- | --- | --- | --- |
  | **SA-1** | Shared core and database layer | on master @ `4f2c1ab` | — |
  | **SA-2** | Health checks from the ops module | on master @ `9d0e771` | — |
  | **SA-3** | UI theme tokens from the package | on master @ `b81c0de` | — |
  | **SA-4** | Security headers and rate limits | implement 2/3 | [session](https://claude.ai/code/session_01AbC) |
  | **SA-5** | Login and sessions from the auth module | ready to merge (PR #36) | [session](https://claude.ai/code/session_01DeF) |
  | **SA-6** | Registration switch through feature switches | waiting for SA-5 | — |

  Merged since the last report: SA-3 (PR #35, `b81c0de`).
  Next to merge: SA-5, then SA-4. SA-6 starts right after SA-5 lands.
  Next report: 15:00.
  ```

  Nothing moved since the last report: one line (`14:30, no change: SA-4 implement 2/3, SA-5 ready
  to merge`).

**Issues as the work source** (`autonomy.source: "issues"`, no roadmap):
- The coordinator lists open issues (through a session when it has no forge access). Not well-founded:
  comment why, label `invalid`, close. Well-founded: one change, one session.
- Label `status: in progress` at start and `status: blocked` when blocked; remove them on close.
- After the merge, comment point by point (what changed, PR, merge SHA, `context/archive/<date>-<id>/`,
  the version or "next release") and close the issue as completed. A partly solved issue gets a
  comment listing what is done and what stays open, and stays open.
- Before starting new work, look for open issues that earlier merges already solved.
- A well-founded, non-duplicate gap found while working (here, or in an upstream `@softure-ai/*`
  module) is filed as an issue right away.
- Public text (issues, pull requests, commits, docs) stays neutral: no personal references, no names
  of private projects (write "an adopting app").

**Releases.** With `release.owner: true` nothing is tagged, published or deployed: work ends
`done_code` with the owner's steps under `## Before the next release`, and a release follows only the
owner's word for that release. With `release.owner: false` the coordinator releases once per wave
through the project's own pipeline (version-bump pull request → merge → the pipeline publishes); with
several sessions on one package, the last to merge releases. No manual tags, no moved tags; a failed
release is fixed forward with a patch bump. A production deploy always needs the owner's separate word. Ad-hoc fixes
ride the next release instead of getting one of their own, unless the owner says otherwise.

**Stop and limits.** "Stop" or "pause" from the owner stops everything: no new sessions, report
routines removed, open sessions finished or stopped at a safe point; record the pause in memory and do
not resume until the owner says so. After a usage limit, verify the real state first (main branch,
pull requests, CI, releases, issues), then nudge the interrupted sessions. If the harness refuses a
push, merge or publish this section covers, cite this section and `mode` once; if it still refuses,
ask the owner for a word in that session and keep the other work going.

**Memory** holds only project state (queue, IDs, the owner's specific orders and decisions). The rules
above are not memory material.

## Conventions

**Code**
- Name things by what they do: functions start with a verb, booleans read as questions
  (`isActive`, `hasAccess`), constants are UPPER_SNAKE_CASE, and a file is named after its main export.
- One function does one job. More than three inputs become an options object. Return early
  instead of nesting.
- Functions that read (`get*`, `find*`, `is*`) have no side effects.

**TypeScript**
- External data enters as `unknown` and is narrowed with a schema (zod) at the boundary.
- Model alternatives as discriminated unions, not as bags of optional fields.
- `any` and non-null assertions need a comment that says why.

**Errors**
- Every awaited call either handles its failure or deliberately lets it propagate. Nothing is
  swallowed silently.
- Error messages name the operation and the input that failed. Users never see stack traces
  or internal paths.
- Expected failures are returned as values (result types). Exceptions are for bugs.

**Data**
- An invariant that can be a database constraint is one. Code checks are a second line, not the only one.
- SQL is always parameterized. Migrations move forward only and say how to roll back.
- A write that depends on a read happens in one transaction, with a conditional `UPDATE` or a lock.

**Security**
- Secrets come from the environment and are never logged.
- Every server action and route checks authorization, not just a session.
- Public endpoints are rate-limited and validate their input.

**React / Next.js**
- Server components by default. Use client components only for interaction.
- User-visible text, including `aria-label`, goes through the project's message layer.
- Styling uses design tokens. Raw colours and magic sizes are not allowed.

**Tests**
- A test name states the behaviour. Each test builds and cleans up its own data.
- Assert exact values. Cover empty, boundary and failure cases.
- A bug fix starts with a test that fails without it.
<!-- softure-skills:end -->
