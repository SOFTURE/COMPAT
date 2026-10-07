# Change: init-file-selection

Source: issue #46. Command: `init`.

`init` filled `config` and `dependencies` with local-dev, test and mobile files and missed the deploy chain. It now
leaves out test and mobile app files, prefers compose files the deploy tooling references, writes a default
`ignore` for test packages, and turns Ansible and GitHub workflow configuration into regex sources, one `deploy`
chain and a `presence` command.

**Out of scope:** compose parsing (CMP-8), openapi and message-contracts detection (#44, #45), `check` defaults (#42).
