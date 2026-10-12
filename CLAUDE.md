# Claude Code instructions

Use [`AGENTS.md`](./AGENTS.md) as the repository's primary instruction file.

The managed delivery workflow is available as `/deliver <requirement>` and is
mirrored between `.opencode/` and `.claude/`. Keep both platform trees
semantically synchronized whenever agents, skills, commands, or workflow
behavior changes; update both mirrors in the same change.

Do not commit changes. Generated workflow artifacts belong under `.tmp/` and
must use unique UTC-timestamped filenames.
