# Changelog

Each release is cut with `/version`, which adds a section summarizing the commits since the previous one.

## v0.0.1 — 2026-10-30

Initial release: the workspace and its check gate, ready for the Stage A build. The service itself doesn't run yet.

### Added

- A pnpm workspace on Node 24, with the service package at `packages/penfield` laid out to the spec's seams.
- The `pnpm check` gate (checkride): types, oxlint, ast-grep structure rules, fallow dead code, vitest with coverage, markdownlint, links and cspell, run in CI with `--strict`.
- ast-grep rules for the spec's constraints: no Claude subscription credential anywhere in the code (C2); no classes, `this` or decorators (C6); no suppression comments (C7).
- The spec, playbook and options note in `docs/specs/first-spec/`, with AGENTS.md and CLAUDE.md pointing agents at its constraints and build plan.
- Lockstep releases with `/version`: every package bumped with the root, committed as `vX.Y.Z` and tagged.
