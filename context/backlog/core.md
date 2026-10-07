# Core follow-ups

- [x] 2026-10-07 backward-compat-checker impl review (done in sql-migrations-layer): `RefTree.readFile` decodes UTF-8 only; detect UTF-16 (BOM) for SQL Server scripts before the sql-migrations layer parses them (warning) src/git/ref-tree.ts
