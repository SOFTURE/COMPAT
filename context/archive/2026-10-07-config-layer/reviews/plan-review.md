# Plan review: config-layer

Reviewed: plan.md @ 2026-10-07. Mode: deep (independent read-only reviewer; glob matcher, zod 4.6.5 defaults inside
a discriminated union and RegExp named groups verified in a scratch directory). Verdict: ready after fixes.
Findings: 1 critical, 4 warning, 4 suggestion.
Grounding: 9/9 paths, 10/10 symbols, 3/3 commands (gates match `workflow.json`). Verified: the default globs match
root-level and nested `.env.example`, `example.env`, `docker-compose.yml`, `compose.yaml` and
`docker-compose.prod.yml`; `.default()` and the unique-name `refine` see defaulted names; `superRefine` reports
`sources.1.pattern`; `buildConfigSchema`'s `.extend` works on the schema; a non-participating `default` group is
`undefined`; a `failed` layer exits 1 unless `--allow-incomplete` (`src/model/gate.ts:37`).

## Lenses
| Lens | Result |
| --- | --- |
| Coverage and end state | FAIL (C1, W3) |
| Slicing | PASS |
| Verifiability | WARN (W5) |
| Data and migrations | PASS (not applicable) |
| Tests | WARN (W2, W5) |
| Security | PASS (default values are never printed; evidence holds only path and line) |
| Lean | PASS |
| Fit | WARN (W4, S9) |
| Cost and defaults | WARN (S8) |
| Scope | PASS |
| Reuse | PASS |
| Lessons | PASS (none recorded) |
| Progress format | PASS (3/3 and 4/4 bullets to items, identical titles, gates last) |

## Findings

### C1: `.env` placeholders count as enforcement, which hides a removed default (fail open)
- **Severity:** CRITICAL. **Effort:** medium. **Lens:** Coverage. **Where:** Key decisions "Required at a ref".
- **Problem:** with every `.env.example` key required, a key documented there is required at both refs, so changing
  compose from `${Logging__Level:-Information}` to `${Logging__Level}` gave no finding.
- **Fix:** classify each source on its own and merge per key; documented keys added to the F10 `.env.example`.
- **Decision:** Fix now (applied: per-source verdicts merged per key, only the most severe class reported, so a
  documented default adds no `safe` noise next to a `needs-action`).

### W2: A source can go silent without failing
- **Severity:** WARNING. **Effort:** low. **Lens:** Coverage, Tests. **Where:** Key decisions, phase 2 tests.
- **Problem:** files that moved out of the globs in the revision read as removed keys (`safe`); a regex that
  matches no key at either ref reports nothing.
- **Fix:** both are `failed`; notes carry key counts.
- **Decision:** Fix now (applied).

### W3: F10 drops the .NET `required` evidence, and slash comments are never exercised end to end
- **Severity:** WARNING. **Effort:** medium. **Lens:** Coverage. **Where:** Goal, phase 2 step 4.
- **Fix:** `ApiSettings.cs` with a `slash` regex source and commented-out members in the fixture; the Goal states
  that it reports its own key until normalization lands.
- **Decision:** Fix now (applied).

### W4: The classification leaves the implementer to guess on three points
- **Severity:** WARNING. **Effort:** low. **Lens:** Fit. **Where:** phase 1 step 5, Key decisions "Evidence".
- **Fix:** defaults compared as sorted sets per source; evidence defined per id; scope = sources sharing the verdict.
- **Decision:** Fix now (applied).

### W5: Some e2e checks pass vacuously, and the redaction check covers only unit messages
- **Severity:** WARNING. **Effort:** low. **Lens:** Tests. **Where:** phase 2 tests, Done-when 1.2.
- **Fix:** the accept run uses `--fail-on needs-action`; an e2e test asserts no fixture default appears in the
  Markdown or JSON report.
- **Decision:** Fix now (applied).

### S6: The compose scanner has blind spots, and the risk names the wrong direction
- **Severity:** SUGGESTION. **Where:** Risks.
- **Fix:** risk restated as a false negative (block scalars, pass-through entries); backlog entry at archive.
- **Decision:** Fix now (applied).

### S7: An accept entry without an id keeps hiding future changes of the key
- **Severity:** SUGGESTION. **Where:** Key decisions "Accept".
- **Fix:** `id` required.
- **Decision:** Fix now (applied).

### S8: The default globs mix dev, override and fixture files into one namespace
- **Severity:** SUGGESTION. **Where:** Key decisions "Default globs".
- **Fix:** the per-source note lists the matched revision paths (at most 5), so noise is visible and `files`
  narrows it.
- **Decision:** Fix now (applied).

### S9: Work started before the review, and `comments.ts` breaks its own contract
- **Severity:** SUGGESTION. **Where:** `src/layers/config/comments.ts`.
- **Problem:** a backslash skipped a following newline, and YAML single quotes were treated as escaping.
- **Fix:** escapes only in `"` strings (and `'` for `slash`), never across a newline; tests added.
- **Decision:** Fix now (applied). The early draft was not committed before this review.

## Summary
The approach holds (globs, zod defaults with refine, registry-only change). C1 changed the classification to
per-source verdicts merged per key; W2 closed the remaining fail-open paths. Next: `softure-implement config-layer`.
