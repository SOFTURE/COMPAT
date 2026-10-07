# Plan review: seed-silent-writes

Reviewed: plan.md @ 2026-10-07. Mode: quick (self-review; single-file reader change). Verdict: ready.
Findings: 0 critical, 1 warning (fixed in the plan), 0 suggestion.
Grounding: 5/5 paths, 6/6 symbols (`readPiece`, `readDoBlock`, `readSequence`, `MAX_NESTING`, `WRITE_WORD`,
`NOT_A_WRITE`), 3/3 commands.

| Lens | Result |
| --- | --- |
| Coverage and end state | PASS: every form in research "Forms to handle" has a test case |
| Slicing | PASS: one phase, one file of production code |
| Verifiability | PASS |
| Tests | PASS: lines, guard, nesting limit and the read-only cases (`COPY ... TO`, procedure call) are covered |
| Security | PASS: reads text only, no evaluation |
| Lean | PASS: no change in `classify.ts`; unwrapped statements reuse the existing diff |
| Scope | PASS: CTE row parsing and `\copy` stay out |

### W1 [WARNING] The nesting limit drops nested SQL silently
`readDoBlock` returns without a statement at `MAX_NESTING`; dynamic SQL would inherit that and stay silent.
Fixed in the plan: the limit pushes an `unknown-write` for both `DO` bodies and dynamic SQL.
