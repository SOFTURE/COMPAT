# Plan review: compose-scanning-gaps

Verdict: approved.

- W1 (addressed): changing the shared `stripComments` would alter dotenv, regex and message-contracts readers; the plan
  adds a compose-only YAML masker instead.
- W2 (addressed): an `environment: *alias` would hide pass-through entries defined under an `x-` extension key; the
  plan resolves aliases and merge keys inside `environment`.
- S1 (kept): explicit block indentation indicators (`|2`) and tab indentation are not modelled. Compose files rarely
  use them; a header with an indicator still opens a block scalar whose end is found by dedent, which is correct for
  ordinary files.
- S2 (kept): an `environment` key outside `services` (an extension field) is read too. It can only add keys, so the
  miss direction is fail-closed and `accept` records it.
