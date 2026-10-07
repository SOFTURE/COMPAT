# Plan: seed-silent-writes

Input: change.md, research.md. Complexity: low.

## Goal
A seed write hidden in dynamic SQL with a literal body is read and diffed like any other statement, with the outer
file's lines; dynamic SQL without a literal body and `COPY ... FROM` are `unreadable-write` `needs-action`.

**Out of scope:** row-level reading of CTE writes (rejected in roadmap v2); psql `\copy` (client meta-command, goes
to the backlog); stored-procedure calls (`EXEC dbo.Proc`), which are not dynamic SQL.

## Approach
**Chosen:** recognise dynamic SQL in `readPiece` before `readWrite`. A literal body is unescaped and read as a nested
sequence through the same path as a `DO` body (`readSequence` with `depth + 1`, inheriting the current guard), so
rows, guards and lines work without new code in `classify.ts`. Anything else is pushed as `unknown-write`.
Rejected: a separate pre-pass that rewrites the script text - it would lose offsets and guards.

**Key decisions:**
| Decision | Choice | Why |
| --- | --- | --- |
| Postgres `EXECUTE` scope | only inside a `DO` body (`depth > 0`) | top-level `EXECUTE` runs a prepared statement, not a string |
| Concatenated literals | `unknown-write` | per change.md; joining parts would break line mapping |
| `E'...'` literal body | `unknown-write` | backslash escapes can change the text and its lines |
| Dynamic SQL whose first literal starts with `GRANT`/`CREATE`/`ALTER`/... | silent, as the same plain statement is | keeps `EXECUTE format('CREATE INDEX ...')` from becoming noise |
| Guard | the nested reader starts with the current guard as an open block | `IF NOT EXISTS (...) EXEC(N'INSERT ...')` keeps mode `ignore` |
| Nesting limit reached (`DO` or dynamic SQL) | `unknown-write` instead of dropping | "never silent" |
| `COPY` | `COPY <table> ... FROM` is `unknown-write`; `TO` is a read | `COPY` loads rows the layer cannot see |

## Phase 1: Dynamic SQL, COPY and bulk loads in the seed reader
**Discipline:** TDD. **Files:** `src/layers/seed/seed-statements.ts`, `test/layers/seed/seed-statements.test.ts`,
`test/layers/seed/classify.test.ts`, `README.md`, `context/backlog/later-layers.md`

1. Tests first in `seed-statements.test.ts`: `EXEC(N'...')` multi-line insert unwrapped with outer lines;
   `EXEC sp_executesql N'...', N'@p int', @p = 1` and `@stmt =`; guarded `IF NOT EXISTS (...) EXEC(N'...')` keeps
   `ignore`; `EXEC(@sql)`, concatenation and `sp_executesql @sql` are `unknown-write`; `EXEC dbo.Proc` is nothing;
   `BULK INSERT` is `unknown-write`; `DO` body `EXECUTE '...'` (with `''`) and `EXECUTE $q$...$q$ USING` unwrapped
   with lines; `EXECUTE format(...)`, `EXECUTE v_sql`, `EXECUTE 'INSERT ...' || x` are `unknown-write`;
   `EXECUTE format('CREATE INDEX ...')` is nothing; `COPY t FROM STDIN` and `COPY t (a) FROM '/f'` are
   `unknown-write`, `COPY t TO` and `COPY (SELECT ...) TO` are nothing; nesting beyond the limit is `unknown-write`.
2. One classify test: a row changed inside `EXEC(N'...')` between base and revision is `row-changed` with the
   revision's outer line.
3. Implement in `seed-statements.ts`.
4. README `### seed`: replace the "not read" line with what is read and what is reported. Backlog line 10: mark done,
   add `\copy`.

**Done when:**
- Automated: every case above passes; gates green (typecheck, lint, test).

## Progress

> `- [ ]` pending, `- [x]` done. A phase ends with ` — <commit sha>` on its done items. Never rename items.

### Phase 1: Dynamic SQL, COPY and bulk loads in the seed reader

#### Automated
- [x] 1.1 Every listed case passes in `test/layers/seed/seed-statements.test.ts` and `classify.test.ts` — PENDING
- [x] 1.2 Gates green (typecheck, lint, test) — PENDING
