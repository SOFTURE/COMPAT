# Plan review: persisted-enums-layer

Reviewed: plan.md @ 2026-10-07. Mode: deep (independent read-only reviewer; zod 4.6.5 `.extend()` on a refined
strict object, `git cat-file` versus `git grep` cost and the draft parser probed in a scratch directory).
Verdict: ready after fixes.
Findings: 1 critical, 6 warning, 3 suggestion.
Grounding: 9/9 paths, 8/9 symbols (the gate lives in `src/model/gate.ts`, not `finding.ts`), 3/3 commands.

## Lenses
| Lens | Result |
| --- | --- |
| Coverage and end state | FAIL (C1), WARN (W1) |
| Slicing | PASS |
| Verifiability | WARN (W1) |
| Data and migrations | PASS (not applicable) |
| Classification rules | WARN (W2, W3, S3) |
| Tests | WARN (C1, W2, W3, W5) |
| Security | PASS with S2 (config is repo-controlled, same trust as the openapi `command` source) |
| Performance | WARN (W4) |
| Lean | PASS |
| Fit | WARN (W5) |
| Scope | PASS |
| Reuse | PASS |
| Lessons | PASS (none recorded) |
| Progress format | PASS; workflow state WARN (W6) |

## Findings

### C1: C# preprocessor directives in an enum body silently empty the enum
- **Severity:** CRITICAL. **Effort:** low. **Lens:** Coverage, Tests. **Where:** phase 1 steps 1-2.
- **Problem:** `#region`/`#if` lines were not handled and a member segment that does not start with an identifier
  was skipped, so `enum E { #region G A = 1, ... }` parsed as an empty enum: a silent miss.
- **Fix:** drop non-conditional directives in the tokenizer; make `#if` branches, unreadable segments and unclosed
  bodies a per-enum failure; test them.
- **Decision:** Fix now (applied: `ParsedEnums.failures`, tests in `parse-enums.test.ts`).

### W1: F7 cannot exit 1 under the default gate
- **Severity:** WARNING. **Effort:** low. **Lens:** Verifiability. **Where:** Goal, Done-when 2.2.
- **Problem:** a single `rollback-risk` finding passes `--fail-on breaking`.
- **Fix:** state `--fail-on rollback-risk` in the Goal, tests and 2.2; assert exit 0 under the default gate.
- **Decision:** Fix now (applied).

### W2: Int storage swaps and middle insertions could produce duplicate findings
- **Severity:** WARNING. **Effort:** low. **Lens:** Classification rules. **Where:** Key decisions on rename and renumber.
- **Problem:** the plan text did not say that the rename rule is suppressed for renumbered members.
- **Fix:** suppress it; add the swap and middle-insertion tests with exact lists.
- **Decision:** Fix now (the code already suppressed it; tests added).

### W3: Unknown values pollute the int value-set diff
- **Severity:** WARNING. **Effort:** medium. **Lens:** Classification rules. **Where:** Key decisions on unknown values.
- **Problem:** a member whose value turns unknown could also read as removed (breaking) or added.
- **Fix:** skip value-based removal or addition when the name exists on the other side with an unknown value; treat a
  TS string member under int as unresolved; decide the class of an unknown member's removal.
- **Decision:** Fix now (applied; `needs-action` recorded under Decisions (auto); tests added).

### W4: The `enum` prefilter still spawns one `git cat-file` per source file
- **Severity:** WARNING. **Effort:** low. **Lens:** Performance. **Where:** Key decisions "Reading files".
- **Problem:** 3000 spawns took 6.4 s; `git grep -l -w -e enum <commit>` took 0.19 s.
- **Fix:** select candidates with one `git grep` per side from the layer; read only those and pinned files.
- **Decision:** Fix now (applied).

### W5: Discovery false matches make the layer fail
- **Severity:** WARNING. **Effort:** low. **Lens:** Fit. **Where:** Key decisions "Discovery".
- **Problem:** the helper `ConfigureEnum<T>(...)` itself matches the pattern and discovers `T`, declared nowhere.
- **Fix:** a discovered name declared at neither ref is a note; non-identifier captures are skipped with a note;
  put the helper in the F7 fixture.
- **Decision:** Fix now (applied).

### W6: change.md status was `new` and phase 1 code existed before the review
- **Severity:** WARNING. **Effort:** low. **Lens:** Workflow state.
- **Problem:** the status was not moved by the plan step; the parser was drafted while the review ran.
- **Fix:** set the status; re-check the draft against the amended phase 1.
- **Decision:** Fix now (status `plan_reviewed`; the draft was amended for C1, W3, S1 and re-tested).

### S1: The BigInt evaluator can throw and ignores the underlying type
- **Severity:** SUGGESTION. **Effort:** low. **Lens:** Classification rules.
- **Problem:** `1 << 10000000000` throws `RangeError`.
- **Fix:** cap shift counts and width; treat overflow as unknown.
- **Decision:** Fix now (64-bit cap; underlying-type wrapping not modelled, both refs agree).

### S2: The discovery regex has no flags and no size guard
- **Severity:** SUGGESTION. **Effort:** low. **Lens:** Security.
- **Problem:** anchors only match at file edges; an empty-matching pattern loops with `exec`.
- **Fix:** iterate with `matchAll`; document narrow `files`.
- **Decision:** Fix now (`matchAll` with `gm`; empty captures are skipped with a note). A `flags` field: skipped
  (no consumer needs it yet).

### S3: String-storage rename pairing order
- **Severity:** SUGGESTION. **Effort:** low. **Lens:** Classification rules.
- **Problem:** many-to-many pairing order was undefined.
- **Fix:** one to one, first by name, then by number in declaration order; test two removals and two additions.
- **Decision:** Fix now (the code already paired this way; tests added).
