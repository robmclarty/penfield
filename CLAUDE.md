# CLAUDE.md

@AGENTS.md

The line above imports [AGENTS.md](./AGENTS.md), the contract every agent in this repository follows. Claude Code-specific notes go below it.

## Building with plumbbob

Each stage is built with plumbbob from the spec's §8: `/plumbbob:plan docs/specs/first-spec/penfield_first_spec.md`, keeping the stage's ranges as the build ranges. The [playbook](./docs/specs/first-spec/playbook.md)'s §2 names the model seats per range and the steps to mark as pauses. Steps that need a live node (searle) run from the laptop against `192.168.1.90`; everything else runs against the fake servers in `test/helpers/`.
