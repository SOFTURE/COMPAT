# Plan: report-disabled-layers

Input: change.md, issue #43. Complexity: small (1 phase; config, gate, report, CLI).

## Goal
- A config with `openapi` disabled reports a `| openapi | disabled | - | - | - | - |` row and
  `Not checked: openapi (disabled)` under the gate; JSON lists `{ "layer": "openapi", "status": "disabled" }`.
- A known layer missing from the config shows as `not configured` (JSON `status: "not-configured"`).
- `--require openapi` fails the gate (exit 1) when `openapi` is disabled, not configured, skipped or failed.
- `--require nope` is exit 2 naming the known layers.

## Research (summary)
- `parseConfig` drops disabled and absent layers silently; it is the only place that knows both sets.
- `evaluateGate` sees only results of enabled layers; the report has no notion of the registry.
- `LayerResult` is consumed by every layer (`results` for refinements), so a new status there would ripple through
  all layers. Inactive layers get their own type next to the gate instead.
- #42 edits `check.ts` and `report/*` next; keep the edits there small and local.

## Key decisions
| Decision | Choice | Why |
| --- | --- | --- |
| Model | `InactiveLayer = { layer, status: "disabled" \| "not-configured" }` in `model/gate.ts`, `CompatConfig.inactive` | no change to `LayerResult` and the layers that read it |
| Disabled vs absent | two statuses | `enabled: false` is a decision, a missing key may be an oversight; the reader should tell them apart |
| Gate without `--require` | unchanged: inactive layers never fail it | the issue asks for visibility; failing on every disabled layer would break every `init` config |
| `--require` scope | the layer must have `ran`; `--allow-incomplete` does not excuse a required layer | "require" means the contract was checked; a skipped required layer checked nothing |
| `--require` syntax | comma-separated, repeatable is not needed; unknown names exit 2 | a typo must not silently require nothing |
| Table order | ran layers first (registry order), then inactive ones (registry order) | keeps the checked layers on top; no index merging |
| JSON | inactive entries in `layers` with `verdict` = status, `findings: []`, `notes: []`; `required` at top level; schema version stays 1 | additive; consumers that read `findings` keep working |
| Markdown header | `, required: \`openapi\`` after the fail-on text when set | the reader sees why the gate is stricter |

## Progress

> `- [ ]` pending, `- [x]` done.

### Phase 1: inactive layers and --require

#### Automated
- [x] 1.1 `config.test.ts`: `inactive` lists disabled and absent layers in registry order
- [x] 1.2 `gate.test.ts`: inactive layers never fail the gate; `required` fails on disabled, not-configured, skipped and failed (also with `allowIncomplete`)
- [x] 1.3 `report.test.ts`: Markdown rows and `Not checked:` line, header shows required; JSON `status`/`verdict`/`required`
- [x] 1.4 `check.test.ts` + `main.test.ts`: issue acceptance (disabled layer row, `--require` exit 1, unknown name exit 2, usage lists the flag)
- [x] 1.5 Gates green (typecheck, lint, test); README documents `--require` and the not-checked layers
