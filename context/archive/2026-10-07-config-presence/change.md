# Change: config-presence

Source: issue #20. Layer: `config`.

`config-key-added-required` and `config-key-default-removed` always end as "the value must exist in production
before the deploy", a manual check every release. Most secret stores can list key names without values.
An optional `presence` command prints the key names of the target environment; listed keys become `safe`,
missing keys stay `needs-action` and say so. Values never reach logs, storage or the report.

**Out of scope:** `chains` (#19), reading secret values, connecting to production in any other way.
