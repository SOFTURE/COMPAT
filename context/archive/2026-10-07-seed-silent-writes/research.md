# Research: seed-silent-writes

Input: change.md, roadmap v2 CMP-7, backlog `context/backlog/later-layers.md:10`. Depth: quick.
Snapshot: 23b243c on master, 2026-10-07.

## Summary
- `readPiece` (`src/layers/seed/seed-statements.ts`) reads a statement as a write when `readWrite` recognises its
  head (`INSERT`, `MERGE`, `UPDATE`, `DELETE`, `TRUNCATE`), else as `unknown-write` when `WRITE_WORD` matches the
  text with literals masked. A write inside a string literal (`EXEC(N'INSERT ...')`, `EXECUTE 'UPDATE ...'`) is
  masked away, and `COPY` holds no write word: both produce no statement and no finding.
- `BULK INSERT t FROM '...'` already contains `INSERT` outside literals and reads as `unknown-write`; there is no test.
- Postgres `DO` bodies are already unwrapped by `readDoBlock` with `MAX_NESTING = 3`; the nested sequence keeps the
  outer file's lines by counting newlines up to the body. A dynamic-SQL literal can be unwrapped the same way:
  `''` unescaping keeps newlines, so lines stay true.
- When the `DO` nesting limit is reached the body is dropped silently (`readDoBlock` returns).
- T-SQL `IF NOT EXISTS (...) EXEC(N'...')` already reaches `readPiece` with the guard as `inlineGuard`, because
  `readIf` lists `EXEC`/`EXECUTE` as statement starts; `findNextTsqlStatement` splits lines starting with `EXEC`.
- `classify.ts` compares non-row statements by normalised text and reports only added ones, so an unchanged
  `unknown-write` present in base and revision gives no finding; unwrapped rows are diffed like any other rows.
- README `### seed` ends with "Dynamic SQL ..., `COPY` and `BULK INSERT` are not read." (`README.md:431`).

## Forms to handle
| Dialect | Form | Today | Wanted |
| --- | --- | --- | --- |
| sqlserver | `EXEC(N'...')`, `EXECUTE ('...')` | silent | unwrap |
| sqlserver | `EXEC sp_executesql N'...'[, params]`, `@stmt = N'...'`, `sys.`/`dbo.` prefix | silent | unwrap |
| sqlserver | `EXEC(@sql)`, `EXEC(N'...' + @x)`, `EXEC sp_executesql @sql` | silent | `unknown-write` |
| sqlserver | `EXEC dbo.SomeProc` | silent | unchanged (not dynamic SQL) |
| sqlserver | `BULK INSERT` | `unknown-write` | unchanged, add test |
| postgres (in `DO`) | `EXECUTE '...'`, `EXECUTE $q$...$q$`, optional `USING`/`INTO` | silent | unwrap |
| postgres (in `DO`) | `EXECUTE format(...)`, `EXECUTE 'a' \|\| b`, `EXECUTE v_sql` | silent | `unknown-write` |
| postgres (top level) | `EXECUTE plan(...)` (prepared statement) | silent | unchanged (the `PREPARE` body is already `unknown-write`) |
| postgres | `COPY t FROM ...` | silent | `unknown-write` |
| postgres | `COPY t TO ...`, `COPY (query) TO ...` | silent | unchanged (reads only) |

## Open points
- psql's `\copy` meta-command has no `;` and merges with the next statement in `splitStatements`; it is out of scope
  (a client command, not SQL) and goes to the backlog.
