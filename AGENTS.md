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
- **Any time:** `softure-code-review`, `softure-rule-review`, `softure-lesson`, `softure-doctor`.

`context/state.json` is the machine-readable state of the project (WORKFLOW §12). Only scripts write
it (`wt-roadmap.py`, and `context_state.py write --staged` in `softure-archive` and `softure-roadmap`),
in the same commit as the markdown; never edit it by hand. CI runs `npx softure-skills doctor` in the job `context-doctor` (keep that name), on `pull_request` and on `push` to
the main branch with no paths filter and no condition, which fails on drift in `context/` and on a `context-doctor`
job that misses pushes to the main branch (`ci-doctor-trigger`): fix the file it names, never the check.

**Every change goes through the chain, however small.** A one-line fix reported in chat is a change
too (`roadmap_item: null`). `new`, `plan`, `plan-review`, `implement`, `impl-review` and `archive` are
never skipped. `research` and `frame` may be skipped only with a one-line reason under `## Notes` in
`change.md`. `research.md`, `plan.md` and `reviews/plan-review.md` exist before the first edit of
source code. Only the owner can waive this, for one named change, and only in manual mode.

**The project's operating mode** is `mode` in `context/workflow.json`: `manual` (also when the key is
missing) or `autonomous`. Its rules are the `## Operating mode` section below; it is the only mode
section in this block. Switch modes only on the owner's explicit word: set `mode`, re-run the installer
(`npx softure-skills`) so this block follows, commit both as `docs(rules): switch to <mode> mode`.

**Project files and evidence (WORKFLOW §11).** No screenshot, frame grab or recording enters git
(visual-regression baselines next to their tests excepted). Save each with `softure-evidence` to the
store in `workflow.json` → `evidence`, named `<change-id>/<NN>-<what>-<before|after>-<width>-<theme>.webp`,
and link the stored files from the Progress item they prove. Owner material (briefs, real data, designs)
stays in the project files (`<project-slug>/briefs|data|design/`, listed in `INDEX.md`) and is referenced
by path, never copied into the repository.

**Infrastructure and deploy work (WORKFLOW §14), in both modes:** survey the server read-only before writing an
inventory, a deploy config or a server step; treat a server that runs other apps as shared; give the owner only
commands copied from the pinned package README, run with `--check` first; keep verify on public paths and every
public path in the Access bypass list; give the owner one complete list; stop and report on a failed step.

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
owner's word** (see Releases). Nothing in this section needs to be told to a fresh session again;
a hosted project's coordinator that does not run inside a checkout gets one pointer to it in the
project instructions (WORKFLOW §8.5). A thread whose project instructions lack that pointer tells the
coordinator in its first message, with the snippet filled in; the coordinator then reads this block
and `context/workflow.json` from the main branch at once and follows them for the rest of the run,
without waiting for the paste (WORKFLOW §8.5, Bootstrap).

**Decide, don't ask.** Take the recommended option and record it under `## Decisions (auto)` in the
artifact. Small product decisions are yours: the owner trusts the recommendation and corrects it
later. Prefer the simplest solution that meets the intent. No decision cards, no "shall I…?", no
"waiting for the owner" for anything this section covers. Escalate only for: a destructive or
irreversible action nobody asked for, a secret or access only the owner has, scope that contradicts
`change.md`, a measurement that refutes the item's premise, or an idea for a new product or package
(tell the owner in the project chat to plan it together; file nothing).

**Verify, never leave checks for the owner.** Never leave items for the owner's manual verification:
they come back to the agent anyway. The run verifies them itself, closes them, archives and
releases. A plan criterion is *Manual* only when no agent-runnable evidence can settle it; otherwise
the plan names the evidence (a test, a script or local check, a screenshot or frame grab the agent
looks at, the pipeline run and health check, CI logs, a schema or `ffprobe` check), the run produces
it and records it on the Progress item (command and result, SHA, link). No item ends `waiting: owner
check`, and `## Owner decisions and checks` holds no checks the run could do. Only four things are
genuinely the owner's: a paid provider call that needs the owner's yes, a secret, account or
connector only the owner has, a release or production deploy (Releases), and a taste judgement the
owner reserved for themselves in `change.md` or the PRD. Each becomes a tracked item with the exact
step and its reason (an `Owner step:` handoff line that `wt-roadmap.py done` writes to the roadmap,
or an issue), never a free-floating checkbox list. After an owner-approved deploy the run performs
the checks it can reach (pipeline run, health endpoint, logs) and closes the item; only a check the
container truly cannot reach becomes a tracked item naming why. A report never lists manual checks as
the owner's to-do.

**Know your role.** Work in parallel has one coordinator and its threads:
- **Coordinator**: the session in the project's main chat (the channel the owner talks to), or
  `softure-worktree-manager` locally. It plans, briefs, starts threads, gives the go to merge, and is
  the only one that talks to the owner.
- **Thread**: a session started by the coordinator with a brief (an item ID, a change-id, "follow
  AGENTS.md → Operating mode: autonomous"). It carries one change and talks only to the coordinator.
- A session started by the owner directly, with no coordinator, does both jobs itself.

**One item = one change = one thread.** This holds however the work starts: a new roadmap, the owner's
go on an existing roadmap, an owner-word issue, an issue from the queue, a resumed run. "Item by item"
means one thread per item, never one thread that carries several items in a row. Serial order comes
from starting the next item's thread after the previous merge (the startable set, below), never from
queueing items in one thread. A thread never starts a second item in the same session.

**Start of a run.** A coordinator that wakes with no run in flight (a fresh or cleared session, or a
hosted project's main-chat session on its first message) starts the run itself, without waiting for
the owner's "go":
0. **owner-word issues first:** list the open issues labelled `owner-word` in this project's repository
   (through a thread when the coordinator has no forge access) and act on each before starting any other
   thread (Owner-word issues, below);
1. read `context/workflow.json` and the roadmap (or the issue queue) on the main branch; outside a
   checkout, read them, and this block, from the repository first. Then read the project's memory and
   its own coordinator conventions (the project's `AGENTS.md` outside this block). When memory lacks
   the run state (the serial merge queue holder, the report routine id, the lanes, which forge events
   do not reach the threads), write it there before starting threads;
2. adopt what is already in flight: roadmap rows `in_progress` or `ready_to_merge`, the harness's open
   threads, open pull requests (`softure-worktree-manager` M0.1); give the go to every READY thread;
3. start a thread for every startable item (below), items with no prerequisites included, whatever
   lane they sit in;
4. create the report routine and post the first roadmap report.
Only a "stop" or "pause" from the owner, recorded in memory, holds it back.

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
- One thread = one change = one roadmap item or one issue (One item = one change = one thread, above).
  Items that touch the same files wait for each other; they never share a thread. A planning thread
  hands its result over and is closed. Before starting a thread, check that the item has none yet.
- **A new roadmap is two steps, never one thread.** When the owner hands over a new roadmap (or a
  revision), brief one roadmap thread that only shapes, records, commits and merges `roadmap.md`
  **and** opens the change of every new item (`context/changes/<change-id>/change.md`, with the item
  block and the findings gathered for it) in the same pull request, then ends. Once it is merged,
  start one thread per ready item, as for any run; each item thread starts from its change, not
  from the roadmap row. Never brief a single thread to record a roadmap and implement its items, or
  to implement a whole roadmap.
- Runs as many threads as are parallel-safe; `worktree.maxParallel` is a soft default for how many
  threads run at once, each with its own item, never a number of items for one thread.
- **The roadmap keeps rolling: recompute the startable set on every merge result and every report.**
  Read `roadmap.md` on `origin/<main>`; every item that is not done, has no thread, and whose
  prerequisites are all `done` or `done_code` on `<main>` (or has none) gets a thread now, within the
  parallel-safe limit. Never derive it only from the thread that just merged or from its lane
  successor: an item with no prerequisites is never "unblocked by a merge", and an item a sloppy
  merge round missed must still be picked up. `softure-worktree/scripts/wt-startable.py` prints the
  set (`START` rows; `WAIT` rows name the missing prerequisites). Never wait for the rest of the wave.
  Take no new items beyond the roadmap or the issue queue without the owner.
- A brief names exactly one item ID and one change-id (check this before sending it: a brief that
  names two items, a lane or a whole roadmap is rewritten as one brief per item), the outcome, the base branch, the files it owns, what it
  waits for, the merge path, how to report back (condensed, to the coordinator's session), and "follow
  AGENTS.md → Operating mode: autonomous". Project-specific standing orders are appended.
- **Gives the go itself.** A thread with a green pull request, no conflicts, inside the approved scope
  gets "go" from the coordinator right away (`message_thread` or the equivalent), never after asking
  the owner. **Check every thread waiting for your go on every report and every wake-up**: give the go
  or say what blocks it. A green PR that sits unmerged because nobody said "go" is the coordinator's
  failure.
- **Stale go:** a thread that got its go and has sent no merge SHA within 30 minutes is nudged at once
  (what is it waiting for, CI or a conflict?), not at the next report.
- Posts every thread's result in the main chat as it arrives (condensed, decision first).
- **Checks open `owner-word` issues on every report and every wake-up**, before the startable set, and
  acts on new ones (Owner-word issues, below).
- **Makes sure finished threads are closed.** On every merge result, and whenever a thread with a
  one-off job hands its result over (a planning thread, the report routine setup thread once it sends
  the routine id back, a report thread), check that the thread is resolved and resolve it yourself
  (`set_thread_resolved` or the equivalent) if it is not. Never close a thread whose pull request is
  still open.
- Nudges stalled threads (waiting on CI, stopped by a usage limit) on every report: every working
  thread silent for 45 minutes or more gets a nudge in that firing.
- A new question about the roadmap goes to a new thread; the old one is closed.
- **Open owner checks are work, not a to-do for the owner.** When the roadmap still holds open check
  entries (under `## Owner decisions and checks`, or rows `done_code (…; waiting: owner check …)`),
  start a thread that verifies them, closes the entries and rows, archives and, when code changed
  and the owner's release word exists, releases. Never list them in a report for the owner.

**Thread duties:**
- Run the whole chain for its change (`softure-worktree`), deciding by the rules above.
- **One item per thread, even when the brief says otherwise.** A brief that names more than one item
  (several IDs, a lane, a whole roadmap, "item by item") is a coordinator mistake: carry only the
  first item, tell the coordinator at once that every other item needs its own thread, and resolve
  after your one merge. Never start a second item in the same session.
- **Check the coordinator's bootstrap** in a hosted project: at session start, look for the WORKFLOW
  §8.5 pointer (or any reference to this repository's `AGENTS.md`) in the project instructions the
  session was given. When it is missing, the first message to the coordinator says so, carries the
  snippet with `<owner>/<repo>` filled in, and asks the coordinator to tell the owner where to paste
  it. Then carry on with the change.
- At READY (green PR, the main branch merged in when Merging below says it is needed): send the
  condensed result to the coordinator and wait for its go. Never write that it waits for the owner.
  Without a coordinator, merge at READY.
- After the go: merge (below), then record the roadmap state on the main branch
  (`wt-roadmap.py done <change-id>`) and send the merge result to the coordinator.
- **Watch your own CI when PR events cannot reach you.** At session start, check whether pull request
  activity can reach the thread (the subscription succeeds, the forge app has access to the
  repository). If not, after every push check the pull request's checks yourself until they finish:
  a scheduled wake-up every few minutes, for at most about 60 minutes, then report what is still
  pending. Never end the turn waiting for an event that cannot arrive.
- **Close the thread only when the work is really done: its pull request is merged into the main
  branch** (`set_thread_resolved` or the equivalent). A thread with an open pull request stays open,
  READY included. It stays open also while an owner action gates its result.

**Merging.**
- Merges are serial, first ready first merged: one merge at a time across the threads, each thread
  merging its own one item. Serial merges never mean several items in one thread. A ready merge never
  waits for the owner.
- **The roadmap state lives on the main branch, never on a change branch.** Branches do not edit
  `roadmap.md`: `wt-roadmap.py` writes every stage on the main branch (`open`, `stage`, `ready`), and
  the thread runs `wt-roadmap.py done <change-id>` right after its merge; it takes the `## Done`,
  owner-step and release lines from the archived `change.md` (`softure-archive --handoff`). In this
  mode it refuses `Owner check:` lines and `waiting: owner check`: verify them, then re-run it with
  `--verified "<evidence>"`. Only `worktree.cloudState: "branch"` keeps the old flow, where the
  branch carries its own row.
- **Merge the main branch in only when needed** (`autonomy.remergeMain: "when-needed"`, the default).
  After the go, run `softure-worktree/scripts/wt-merge-check.py`. `merge-as-is` (the forge reports the
  pull request mergeable, and since the branch last merged it the main branch brought no migration, no
  dependency change and no file the branch also changes): merge the pull request as it is; its checks
  were green at READY. `remerge`: merge the fresh main branch in, resolve conflicts yourself, run the
  `RUN` lines it prints, push. The main branch is the source of truth: what it has and the branch lacks
  is pulled in and wired. `"on-conflict"`: `merge-as-is` unless the merge would conflict (the forge
  reports the pull request not mergeable: pass `--not-mergeable`; or the script's trial merge
  conflicts); overlap, migrations and dependency changes alone do not force a merge of the main
  branch, so the merged result is first tested on the main branch and in the release gate.
  `"always"`: merge the main branch in before every merge.
- **A merge of the main branch re-runs only what it can break:** every gate except the test gate, plus
  `autonomy.relatedTests` for the files the branch changes. The full suite runs again only when the
  incoming changes add a migration or touch dependencies, test setup or config (`wt-merge-check.py`
  prints `GATES full`), and once per roadmap in the release gate.
- **Merge on green without polling.** When a merge has to wait for checks, enable the forge's auto-merge
  for the pull request at go time where it is available; poll the checks only where it is not.
- `autonomy.merge: "pr"` (default): open a pull request (`Closes #N` when it solves an issue), wait for
  green checks, merge it on the forge; the forge deletes the head branch. `"push"`: `git merge --no-ff`
  locally, then push the main branch through the pre-push hook.
- When one thread has had to chase the main branch several times, the coordinator tells the others
  to hold their merges until it lands. Under `remergeMain: "on-conflict"` the go never asks for
  "Update branch" or a merge of the main branch: the thread merges on `wt-merge-check.py`'s verdict.
- Hooks stay on: never `--no-verify`, never force-push, never disable or loosen a test to get green.
  Long hooks run in the background with the longest timeout; a hung one is killed by its PID and
  re-run.
- The main branch is already tested: do not re-run gates on it to review it. The full integration
  suite runs per `integration.cadence`, never per push.

**Roadmap reports** (coordinator, pasted into the main chat, times in `timezone`):
- When: after every batch of thread starts (an ad-hoc post), and every `autonomy.reports.every`
  minutes (default 60) on full hours inside `autonomy.reports.hours`, only while work runs.
  `hours: null` (the default) means around the clock, and that is the recommended setting for an
  autonomous run: the report routine is also the run's heartbeat (it recomputes the startable set,
  gives the go, nudges stalled threads), so a window that sleeps at night leaves the night
  unsupervised. Routines
  fire at most once an hour, on the full hour, so the schedule is `every` rounded up to a multiple of
  60 (60 → `0 * * * *`, 120 → `0 */2 * * *`; `wt_config.py --report-cron` prints it); a value below 60
  runs hourly. **One recurring routine** drives the reports: the roadmap heartbeat,
  `routines/roadmap-heartbeat.md` in the package. It runs in a **fresh session on every fire**
  (`create_new_session_on_fire`), never in the coordinator's session: it reads the repository and the
  forge, sends the coordinator the facts in one message (in issue mode also the new open issues) and
  ends; the coordinator posts the report and runs the heartbeat. The coordinator creates it when work
  starts and deletes it when the roadmap is archived (issue mode: after `autonomy.reports.idleHours`
  idle hours), or on the owner's "stop" or "pause". Never a chain of one-off wake-ups. **A coordinator
  without a scheduling tool** (a hosted project's main-chat session) starts one short setup thread with
  the brief in that file; the thread sends the routine id back and is closed. The coordinator records
  the id in memory and, at the end of the run or on "stop" or "pause", has a thread delete the routine
  by that id. Missing tools never mean skipped reports. After a pause (usage limit) name the reports that were skipped. A report produced in a thread of its own (a scheduled routine) is pasted into the main
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
     - **Stage**: `waiting for <IDs>` (the prerequisite IDs not yet on `<main>`; `waiting for
       predecessors` without IDs is invalid), `research`, `frame`, `plan`, `plan-review`, `implement N/M`,
       `impl-review`, `integration`, `archive`, `ready to merge (PR #N)`, `merging (PR #N)`,
       `blocked (<why>)`, `waits for the owner (<what>)`; add `stalled` when the thread has not moved
       since the last report. An item whose prerequisites are all on `<main>` but has no thread is a
       coordinator failure: start its thread in the same firing, before posting the report.
     - **Link**: a markdown link to the thread that carries the item, `[thread](<url>)`; `—` when it has
       none. Never a forge URL: the PR number lives in Stage;
  4. `Decision: …` when the owner has something to decide;
  5. one line with the times: next merge in line, deadlines that matter, next report.
- Headers and prose in `chatLanguage` (a Polish owner gets the header row `ID | Co robi | Etap | Link`).
  Example, shown in English (roadmap prefix `SA`):

  ```markdown
  **Roadmap report softure-auth, 14:00**
  Done: 47 of 50 on master (latest SA-31, SA-59).

  | ID | What it does | Stage | Link |
  | --- | --- | --- | --- |
  | **SA-33** | Registration behind a feature switch | blocked (SOFTURE/AI#301) | [thread](https://claude.ai/code/session_01AbC) |
  | **SA-35** | Password reset by email | implement 2/3 | [thread](https://claude.ai/code/session_01DeF) |
  | **SA-7** | Integration and release | waits for the owner (release) | — |

  Decision: SA-7 can be released after SA-35; waiting for your word.
  Times: SA-35 ready to merge around 15:30; next report 15:00.
  ```

  Nothing moved since the last report: one line (`15:00, no change: 47 of 50; SA-35 implement 2/3`).

**Bugs and gaps in SOFTURE packages.** A well-founded, non-duplicate bug or gap is filed right away as
an issue, without asking, in the repository that owns it:
- `@softure-ai/skills` (the skills, this managed block, `WORKFLOW.md`) → **SOFTURE/SKILLS**;
- every other `@softure-ai/*` package → **SOFTURE/AI**;
- this project's own scope → this project's repository.

Search the target for a duplicate first. When the harness scopes forge access to this project, attach
the owning repository first (read and issues) and only then decide you cannot file; if it is still out
of reach, put the issue text in the main chat for the owner. The work goes on around it; the item that
needs the fix is `blocked (<repo>#<N>)`.

**Owner-word issues.** An open issue labelled `owner-word` in this project's repository is the owner's
word in writing, equal to the same sentence in the main chat: one decision, its scope and any limit
("start the queued roadmap payments", "release after the last item", "drop SA-12"). The coordinator acts
on it like an order in the chat: a roadmap to start goes to a roadmap thread (`--promote`), a release
word is recorded where the release rules look for it (the roadmap header's `Release:` order, quoted with
the issue link), a "no" or "later" is recorded in the roadmap (`## Owner decisions and checks` or the
item's status). An issue whose body carries `<!-- owner-word: {"entry": "<id>", "answer": "yes|no|later"} -->`
answers the `owner_queue` entry with that `id` in `context/state.json`: settle that entry in its `source` file and cite
the issue (`yes`: carry it out and tick it `— done: #N`; `no`: tick it `— declined: #N` and record what follows;
`later`: leave it open with `(later: #N)`); an `entry` no longer in the queue gets a comment saying so (WORKFLOW §8.6).
Then it comments what it did (thread, PR, merge SHA, roadmap line), closes the issue as
completed, and names it in the next report. An issue it cannot act on (unclear, contradicts `change.md`
or a standing order) gets one comment with the question and stays open; the question also goes to the
owner in the main chat. Owner-word issues are not work items: they never get a thread of their own
unless the decision itself needs one, and they are not in `context/state.json`.

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

**Releases.** `release.owner` gates tagging, publishing and deploying only, never merging pull
requests into the main branch: merges always follow the coordinator's go (Merging). With
`release.owner: true` nothing is tagged, published or deployed: work ends
`done_code` with the owner's steps under `## Before the next release`, and a release follows only the
owner's word for that release. With `release.owner: false` the coordinator releases once per wave
through the project's own pipeline (version-bump pull request → merge → the pipeline publishes); with
several threads on one package, the last to merge releases. No manual tags, no moved tags; a failed
release is fixed forward with a patch bump. A production deploy always needs the owner's separate
word. Ad-hoc fixes ride the next release instead of getting one of their own, unless the owner says
otherwise. A roadmap ordered to be archived is closed before its release, and every release of it
(retries and redeploys included) reads the archived file (WORKFLOW §5.2). The session that sees a
release through settles the context right after the deploy's checks pass:
`wt-roadmap.py released <tag>` (softure-worktree) turns the rows that release carries from `waiting:
release` to `done`, ticks the owner entries it answered, closes a finished roadmap ordered to be
archived, and commits `context/state.json` with it, so no reader keeps showing a release word the
owner already gave. The package-update routine never runs it (it never releases).

**Stop and limits.** "Stop" or "pause" from the owner stops everything: no new threads, report
routines removed, open threads finished or stopped at a safe point; record the pause in memory and do
not resume until the owner says so. After a usage limit, verify the real state first (main branch,
pull requests, CI, releases, issues), then nudge the interrupted threads. If the harness refuses a
push, merge or publish this section covers, cite this section and `mode` once; if it still refuses,
ask the owner for a word in that session and keep the other work going.

**Memory** holds only project state (queue, IDs, counters, the owner's specific orders and decisions)
and the run state a fresh coordinator needs (the merge queue holder, the report routine id, the lanes,
which forge events do not reach the threads). The rules above are not memory material. **When the
owner has to explain or correct how the process runs** (a step that should have happened by itself, a rule that is missing or wrong), that is a gap in
these skills: the session that received it checks SOFTURE/SKILLS for a duplicate, files an issue right
away (neutral text, "an adopting app") and posts the link in the main chat. Memory keeps only the
project-specific order itself. The same holds when an audit finds a coordinator miss: record the
project-specific consequence in memory, file the generic gap.

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
