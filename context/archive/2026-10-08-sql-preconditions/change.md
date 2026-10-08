# Change: sql-preconditions

Issue #86. `insert-explicit-id` states a precondition on production data (`max(Id) < first id`) and stays
`needs-action` on every run. Add an optional `preconditions` command on a `sql-migrations` source, modelled on the
config layer's `presence`, whose output settles the finding.
