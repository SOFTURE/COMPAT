# Foundation

Documents that outlive any single change: shape notes, PRD, the active roadmap, queued roadmaps
and lessons. Each file is owned by the skill that writes it (softure-shape, softure-prd,
softure-roadmap, softure-lesson); edit them through those skills when possible.

- `roadmap.md` is the one active roadmap. Queued thematic roadmaps live in `roadmaps/roadmap-<slug>.md`.
- `lessons.md` holds numbered rules from real incidents (`L-NNN`). Numbers are never reused.

## Updating
Edit in place. A refined goal, a new requirement or a shifted milestone changes the existing
file (the PRD bumps its version); no dated copies next to it.

## Archiving
When a document is replaced rather than refined (a finished roadmap, a superseded PRD), move it
to `archive/<YYYY-MM-DD>-<name>.md` and write the successor at the original path. Same-day
collisions get `-2`, `-3`. Nothing reads the archive routinely.

## Not here
Anything tied to one change (its research, frame, plan, reviews) belongs in
`context/changes/<change-id>/`.
