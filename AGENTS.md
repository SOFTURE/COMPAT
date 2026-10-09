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

## Language: English in the repository, `chatLanguage` in the chat (mandatory)

Two languages, kept apart in every project, manual and autonomous alike:

- **Everything written to the repository is English:** code, identifiers, comments, docstrings, tests
  and test names, commit messages, branch names, pull request titles and bodies, issue texts, script,
  log and error output, file and folder names, configuration keys, README and docs, `AGENTS.md` and
  skill instructions. This holds whatever language the owner writes in.
- **Everything said to the owner is in `chatLanguage`** from `context/workflow.json` (default:
  `language`): chat replies, questions, thread results, reports. English code is no reason to answer
  the owner in English, and a request in another language still produces English code.
- **Two narrow exceptions:** user-facing product copy lives in message dictionaries (e.g.
  `messages/pl.ts`), never inline in code; the prose of workflow artifacts under `context/` follows
  `language` (their headings stay English).
- When you touch a file with non-English code, comments or identifiers, translate them in the same
  change. Translating a whole codebase is a change of its own, never a side effect.
- Before every commit, scan the diff for non-English text outside message dictionaries and
  `context/` artifacts. Any hit is a failing gate, just like a red test.

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
resolving conflicts, closing the issues the work solves, filing issues, starting and resolving
sessions (threads), giving threads their go, and running report routines. It lives in the repository,
so every session reads it here itself; it is not consent relayed by another session. A brief points
to this section instead of quoting chat messages. **Only a production deploy or release waits for the
owner's word** (see Releases). Nothing in this section needs to be told to a fresh session again.

**Decide, don't ask.** Take the recommended option and record it under `## Decisions (auto)` in the
artifact. Small product decisions are yours: the owner trusts the recommendation and corrects it
later. Prefer the simplest solution that meets the intent. No decision cards, no "shall I…?", no
"waiting for the owner" for anything this section covers. Escalate only for: a destructive or
irreversible action nobody asked for, a secret or access only the owner has, scope that contradicts
`change.md`, a measurement that refutes the item's premise, or an idea for a new product or package
(tell the owner in the project chat to plan it together; file nothing).

**Know your role.** Work in parallel has one coordinator and its threads:
- **Coordinator**: the session in the project's main chat (the channel the owner talks to), or
  `softure-worktree-manager` locally. It plans, briefs, starts threads, gives the go to merge, and is
  the only one that talks to the owner.
- **Thread**: a session started by the coordinator with a brief (an item ID, a change-id, "follow
  AGENTS.md → Operating mode: autonomous"). It carries one change and talks only to the coordinator.
- A session started by the owner directly, with no coordinator, does both jobs itself.

**Messages to the owner and between sessions:**
- In `chatLanguage` (default: `language`), whatever language the artifacts use.
- **Condensed: the decision first, then what was done.** First line: `Decision: <what the owner has to
  decide, with your recommendation>` when there is one; then two to five lines of outcome with
  evidence (PR, merge SHA, version, run link). No narrative of the steps.
- **The content goes in the message itself.** No artifacts, report files or documents created just to
  be linked; tables go into the message as markdown.
- **Everything ends up in the main chat.** A thread never reports by replying in its own thread: it
  sends its result to the coordinator's session (`send_message` or the harness's equivalent), and the
  coordinator posts it in the project's main chat. This holds for finished work, a blocker, a
  decision, and every roadmap report.

**Coordinator duties:**
- Writes no code: every fix, even one line, becomes a change in its own thread.
- One thread = one change (one issue). Very similar tiny items may share a thread; items that touch
  the same files go to the same thread or wait. A planning thread hands its result over and is closed.
  Before starting a thread, check that the item has none yet.
- Runs as many threads as are parallel-safe; `worktree.maxParallel` is a soft default.
- **The roadmap keeps rolling:** the moment a merge unblocks an item, start its thread. Never wait for
  the rest of the wave. Take no new items beyond the roadmap or the issue queue without the owner.
- A brief names the item ID and change-id, the outcome, the base branch, the files it owns, what it
  waits for, the merge path, how to report back (condensed, to the coordinator's session), and "follow
  AGENTS.md → Operating mode: autonomous". Project-specific standing orders are appended.
- **Gives the go itself.** A thread with a green pull request, no conflicts, inside the approved scope
  gets "go" from the coordinator right away (`message_thread` or the equivalent), never after asking
  the owner. **Check every thread waiting for your go on every report and every wake-up**: give the go
  or say what blocks it. A green PR that sits unmerged because nobody said "go" is the coordinator's
  failure.
- Posts every thread's result in the main chat as it arrives (condensed, decision first).
- Nudges stalled threads (waiting on CI, stopped by a usage limit) on every report.
- A new question about the roadmap goes to a new thread; the old one is closed.

**Thread duties:**
- Run the whole chain for its change (`softure-worktree`), deciding by the rules above.
- At READY (green PR, fresh main branch merged in): send the condensed result to the coordinator and
  wait for its go. Never write that it waits for the owner. Without a coordinator, merge at READY.
- After the go: merge (below), then send the merge result to the coordinator.
- **Close the thread only when the work is really done: its pull request is merged into the main
  branch** (`set_thread_resolved` or the equivalent). A thread with an open pull request stays open,
  READY included. It stays open also while an owner action gates its result.

**Merging.**
- Merges are serial, first ready first merged. A ready merge never waits for the owner.
- Right before merging, merge the fresh main branch into the branch and resolve conflicts yourself.
  The main branch is the source of truth: what it has and the branch lacks is pulled in and wired.
- `autonomy.merge: "pr"` (default): open a pull request (`Closes #N` when it solves an issue), wait for
  green checks, merge it on the forge; the forge deletes the head branch. `"push"`: `git merge --no-ff`
  locally, then push the main branch through the pre-push hook.
- When one thread has had to chase the main branch several times, the coordinator tells the others
  to hold their merges until it lands.
- Hooks stay on: never `--no-verify`, never force-push, never disable or loosen a test to get green.
  Long hooks run in the background with the longest timeout; a hung one is killed by its PID and
  re-run.
- The main branch is already tested: do not re-run gates on it to review it. The full integration
  suite runs per `integration.cadence`, never per push.

**Roadmap reports** (coordinator, pasted into the main chat, times in `timezone`):
- When: after every batch of thread starts, and every `autonomy.reports.every` minutes (default 30) at
  fixed marks (:00, :30) inside `autonomy.reports.hours`, only while work runs. Each report schedules
  the next one; stop the chain when nothing runs. After a pause (usage limit) name the reports that
  were skipped. A report produced in a thread of its own (a scheduled routine) is pasted into the main
  chat and that thread is closed at once.
- Shape, the same in every project, nothing else:
  1. title: `Roadmap report <roadmap name>, <HH:MM>`;
  2. one sentence on what is done, with the **current** counter `X of N on <main>`. N is the number of
     roadmap items; X rises with every merged roadmap item. Work outside the roadmap and a merge that
     only sets an item to blocked do not count;
  3. one table with **only the items not done yet**, always these four columns in this order:
     - **ID**: the roadmap item ID, an uppercase prefix of two or three letters plus a number (`FC-5`,
       `SA-12`, `CMP-3`); in issue mode the issue number (`#42`). Bold, nothing else in the cell.
     - **What it does**: the outcome in a few words.
     - **Stage**: `waiting for <IDs>`, `research`, `frame`, `plan`, `plan-review`, `implement N/M`,
       `impl-review`, `integration`, `archive`, `ready to merge (PR #N)`, `merging (PR #N)`,
       `blocked (<why>)`, `waits for the owner (<what>)`; add `stalled` when the thread has not moved
       since the last report.
     - **Link**: a markdown link to the thread that carries the item, `[thread](<url>)`; `—` when it has
       none. Never a forge URL: the PR number lives in Stage;
  4. `Decision: …` when the owner has something to decide;
  5. one line with the times: next merge in line, deadlines that matter, next report.
- Headers and prose in `chatLanguage` (a Polish owner gets the header row `ID | Co robi | Etap | Link`).
  Example, shown in English (roadmap prefix `SA`):

  ```markdown
  **Roadmap report softure-auth, 14:30**
  Done: 47 of 50 on master (latest SA-31, SA-59).

  | ID | What it does | Stage | Link |
  | --- | --- | --- | --- |
  | **SA-33** | Registration behind a feature switch | blocked (SOFTURE/AI#301) | [thread](https://claude.ai/code/session_01AbC) |
  | **SA-35** | Password reset by email | implement 2/3 | [thread](https://claude.ai/code/session_01DeF) |
  | **SA-7** | Integration and release | waits for the owner (release) | — |

  Decision: SA-7 can be released after SA-35; waiting for your word.
  Times: SA-35 ready to merge around 15:30; next report 15:00.
  ```

  Nothing moved since the last report: one line (`14:30, no change: 47 of 50; SA-35 implement 2/3`).

**Bugs and gaps in SOFTURE packages.** A well-founded, non-duplicate bug or gap in an `@softure-ai/*`
package (or in this project's own scope) is filed right away as an issue in the repository that owns
the package (e.g. SOFTURE/AI), without asking. The work goes on around it; the item that needs the
fix is `blocked (<repo>#<N>)`.

**Issues as the work source** (`autonomy.source: "issues"`, no roadmap):
- The coordinator lists open issues (through a thread when it has no forge access). Not well-founded:
  comment why, label `invalid`, close. Well-founded: one change, one thread.
- Label `status: in progress` at start and `status: blocked` when blocked; remove them on close.
- After the merge, comment point by point (what changed, PR, merge SHA, `context/archive/<date>-<id>/`,
  the version or "next release") and close the issue as completed. A partly solved issue gets a
  comment listing what is done and what stays open, and stays open.
- Before starting new work, look for open issues that earlier merges already solved.
- Public text (issues, pull requests, commits, docs) stays neutral: no personal references, no names
  of private projects (write "an adopting app").

**Releases.** With `release.owner: true` nothing is tagged, published or deployed: work ends
`done_code` with the owner's steps under `## Before the next release`, and a release follows only the
owner's word for that release. With `release.owner: false` the coordinator releases once per wave
through the project's own pipeline (version-bump pull request → merge → the pipeline publishes); with
several threads on one package, the last to merge releases. No manual tags, no moved tags; a failed
release is fixed forward with a patch bump. A production deploy always needs the owner's separate
word. Ad-hoc fixes ride the next release instead of getting one of their own, unless the owner says
otherwise.

**Stop and limits.** "Stop" or "pause" from the owner stops everything: no new threads, report
routines removed, open threads finished or stopped at a safe point; record the pause in memory and do
not resume until the owner says so. After a usage limit, verify the real state first (main branch,
pull requests, CI, releases, issues), then nudge the interrupted threads. If the harness refuses a
push, merge or publish this section covers, cite this section and `mode` once; if it still refuses,
ask the owner for a word in that session and keep the other work going.

**Memory** holds only project state (queue, IDs, counters, the owner's specific orders and decisions).
The rules above are not memory material: when the owner corrects how the process runs, the fix belongs
in these skills, so say so in the main chat.

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
