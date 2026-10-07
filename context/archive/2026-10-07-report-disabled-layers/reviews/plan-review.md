# Plan review: report-disabled-layers

Verdict: approved.

- Goal is testable end to end: the issue's PETSEO case (openapi disabled, gate PASS) maps to the check test.
- Keeping inactive layers out of `LayerResult` avoids touching every layer and the refinement contract.
- `--require` overriding `--allow-incomplete` is a deliberate tightening; documented in the README so it is not a surprise.
- JSON stays schema version 1: the new entries carry `findings` and `notes`, so readers that iterate them keep working.
  Readers that assumed `layers` holds only layers that ran must filter on `status`; three tests in this repo did.
- Conflict risk with #42 (header line in `markdown.ts`, report fields): limited to one header expression and two
  `Report` fields.
