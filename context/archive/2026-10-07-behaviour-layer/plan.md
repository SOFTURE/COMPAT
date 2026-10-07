# Plan: behaviour-layer

Input: change.md, issue #22, `src/process/*`, `src/layers/openapi/serve-spec.ts`. Complexity: medium (one new
layer folder, one registry line, README section).

## Goal
With `layers.behaviour` in `compat.config.json`, `softure-compat check` starts the revision's stack, runs the base
ref's test command against it, reads JUnit XML or TRX results, always stops the stack, and reports every failed
base test as `base-test-failed`, `breaking`.

**Out of scope:** rerunning only the failed tests (the test command is opaque, so a retry reruns the whole command);
detecting the stack from `init` (nothing in a repository says how it starts; `init` writes the layer disabled with
example commands, since its test requires a starter entry per layer); result formats other than JUnit XML and TRX.

## Approach
**Starting point:** `startBackgroundProcess`/`findFreePort`/`pollUrl` (issue #11), `runTreeCommand` (openapi),
`RefTree.materialize()`.

**Chosen:**
- `config.ts`: strict schema `{ start?, test, stop?, retries, baseline, accept? }`.
- `xml.ts`: a small dependency-free XML reader (elements, attributes, text, CDATA, comments, entities); a malformed
  document is an error with a line number.
- `test-results.ts`: JUnit (`testcase` with `failure`/`error`/`skipped`) and TRX (`UnitTestResult` outcome, names
  completed from `TestDefinitions`) into `{ name, scope, outcome, message, file }`; a filesystem walk finds result
  files by glob in the materialized test tree.
- `stack-run.ts`: one cycle: free port, `start`, test attempts with retries, `stop` + background stop in `finally`.
- `behaviour-layer.ts`: optional baseline cycle (all commands at the test side), main cycle, findings, accept.

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| `start` kinds | a script run to completion (default, e.g. `docker compose up -d`), or `background: true` for a long-running app, with an optional `ready` URL polled until 2xx | the issue's script and the fixture's tiny server both need to work |
| Port | one free port per cycle; `{port}` in every `run` and in `ready`, plus `COMPAT_PORT` | tests need to reach a background app; same convention as `serve` sources |
| Environment | `COMPAT_SIDE`, `COMPAT_REF`, `COMPAT_COMMIT` of the command's own tree, `COMPAT_PORT` | same as other consumer commands |
| Default sides | `start`/`stop`: revision, `test`: base | the issue |
| Timeouts | `start` 1800 s, `test` 3600 s, `stop` 600 s, each max 86400 | the issue's example values |
| Test exit code | ignored when results exist (failing tests exit non-zero); no result file after the run is a layer error with exit code and output tail | a crash must not read as "all passed" |
| Stale results | files matching `results.path` are deleted before each attempt | the baseline and retries reuse the same materialized tree |
| Retries | rerun the whole command up to `retries` times (0 to 5, default 0) while tests fail; a test that passes in any attempt passes, with a note | integration stacks are flaky on the first run |
| Baseline | `baseline: true` runs a full cycle with every command at the test side first; tests failing there are dropped with a note | filters tests already red or flaky at base |
| Accept | `{ test, reason }`, `test` matched against the full test name, `*` matches any run of characters | the issue; unused entries get a note like other layers |
| Stop failure | the layer fails, keeping its findings | a stack left running must be visible |
| Finding | id `base-test-failed`, scope class name (else `tests`), subject full test name, message first lines of the failure, evidence the result file at the test side | |

## Phase 1: Results
1. `xml.ts`, `test-results.ts`.

**Tests:** XML entities, CDATA, comments, namespaces, malformed input; JUnit failure/error/skipped/duplicate names;
TRX outcomes and names; file walk by glob.

## Phase 2: Layer
1. `config.ts`, `stack-run.ts`, `behaviour-layer.ts`, registry line.
2. README section, backlog item, "What it does not check yet".

**Tests:** config schema; e2e fixture with a tiny HTTP server and a test suite where the revision changes a response
→ `base-test-failed`, `breaking`; `stop` runs after a `test` timeout and the background app is gone; retries pass a
flaky test; baseline drops a test already red at base; accept; missing results fail the layer.

## Risks and rollback
- The materialized trees are shared with other layers in the same run; the layer only writes inside them through
  the consumer's own commands and deletes only files matching `results.path`.
- Rollback: revert the commit; no other layer changes.

## Progress
### Phase 1: Results
- [x] XML reader
- [x] JUnit and TRX parsing, result file walk
### Phase 2: Layer
- [x] Config schema
- [x] Stack cycle and layer, registry
- [x] README, backlog
- [x] Tests (typecheck, lint, full suite green)
