# Backlog
Planned for later, never what is in flight. A topic lives in exactly one place: `backlog/`,
`changes/` or `archive/`.

- `roadmap-<slug>/`: entries of a queued roadmap (`foundation/roadmaps/roadmap-<slug>.md`):
  a README table and one `<change-id>/change.md` per entry with `status: backlog`.
  Taking an entry moves it into `changes/`; it is never copied.
- `<topic>.md`: deferred review findings and loose ideas, one line each:
  `- [ ] <YYYY-MM-DD> <source change-id or review>: <finding> (<severity>) <evidence path>`.
  `softure-roadmap` turns them into roadmap items.
