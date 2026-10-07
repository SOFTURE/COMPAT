# Change: report-disabled-layers

Source: issue #43. Area: `check` command, gate, Markdown and JSON reports.

`init` writes `openapi` disabled whenever the spec is served at runtime, and a `check` on that config reports
**Gate: PASS** with no `openapi` row at all. A disabled layer is invisible, while a skipped one fails the gate.
The report must list every known layer, say which ones were not checked, and `--require <layer,...>` must let a
pipeline fail when a layer it depends on did not run.

**Out of scope:** changing what `init` enables (#44), the ref source in the header (#42), a config-file `require`
key.
