<!--
build-log.md: your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time. CLI-maintained: `build`,
              `checkpoint`, and `revert` keep this mirror and the Current step line
              in sync with intent.md; you never hand-edit them.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /plumbbob:finish report, which rides the branch into the PR.
-->

# Build log: Stage A: auto by rules, any client

**Current step:** 1 — feat(config): zod schema, loader and check-config (spec step 2)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☐ 1. feat(config): zod schema, loader and check-config (spec step 2)
- ☐ 2. feat(log): open penfield.db with its tables, WAL and a boot id (spec step 3)
- ☐ 3. feat(cli): serve boots, binds the LAN address and answers /healthz (spec step 4)
- ☐ 4. feat(catalogue): discover Ollama and OpenAI-compatible nodes (spec step 5)
- ☐ 5. feat(catalogue): merge overlays, pins and slots into snapshot (spec step 6)
- ☐ 6. feat(probe): liveness, readiness, breaker and incidents (spec step 7)
- ☐ 7. feat(wire): caller auth, GET /catalogue and GET /v1/models (spec step 8)
- ☐ 8. feat(route): RouteInput from OpenAI chat and embeddings bodies (spec step 9)
- ☐ 9. feat(route): the explicit, alias, shape, rule and default rungs and the ladder (spec step 10)
- ☐ 10. feat(place): leases and placement (spec step 11)
- ☐ 11. feat(wire): request ids, the error envelope and fail-closed policy (spec step 13)
- ☐ 12. feat(wire): POST /route decides dry, logs the row, GET /decisions reads it (spec step 12)
- ☐ 13. feat(wire): the streaming proxy with stall, deadline and abort (spec step 14)
- ☐ 14. feat(wire): chat completions and embeddings end to end (spec step 15)
- ☐ 15. feat(wire): Zed's native agent on the gateway (spec step 16)
- ☐ 16. feat(ui): GET /leases and the status page (spec step 17)
- ☐ 17. feat(deploy): Dockerfile, compose, systemd unit and the office config (spec step 18)
- ☐ 18. feat(cli): replay re-runs the ladder over logged decisions, decisions lists them (spec step 19)
- ☐ 19. docs: README, decisions.md and the playbook as shipped (spec step 20)

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [ ] pnpm 11 ignores .npmrc save-exact=true: pnpm add wrote ^ ranges for zod and yaml, pinned by hand; C17 wants it in pnpm-workspace.yaml (saveExact)
- [ ] a router rule naming a profile no profiles: entry defines (the spec's stt rule) is not a D41 load check; step 9 decides: refuse at load, or a refused route
- [ ] system_matches is written with PCRE (?i), which JS RegExp rejects; step 9 must turn a leading (?i) into the i flag, and nothing checks at load that the pattern compiles
- [ ] api_key_env may name any env var, a subscription one included; C2 hardening would refuse CLAUDE_* names in the schema before step 4 reads the key

## Harvest  *(run `/plumbbob:harvest` at each step boundary, after green)*

Classify each parked item as exactly ONE. Naming it before acting is what keeps you
from sprawling across branches.

| Class            | Meaning                                   | Action                               |
| ---------------- | ----------------------------------------- | ------------------------------------ |
| **blocker**      | Plan was wrong/incomplete; can't proceed  | `/plumbbob:revert`, fold into intent |
| **tangent**      | A different path, not clearly better      | Defer or kill. Default here.         |
| **pivot signal** | Evidence the whole approach is wrong      | Stop. Replan deliberately.           |

> Reality check: almost everything that *feels* like a pivot is a tangent. Require a
> failed assumption, not a shinier idea, before you pivot.

Harvest results this boundary:

- (none yet)

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends an entry here
every time a step lands (via `/plumbbob:build` or `/plumbbob:verify`): the dated line,
and beneath it the pause as you approved it, so this fills in as you go, not at the
end, and an older step's detail is a scroll away. Add your own decision/event lines too: this is what
you point at to say "I did that: the LLM helped, but those were my calls."
`/plumbbob:finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*

- 2026-10-31 — plan committed · 7d541bfc1

  **Recommendation**: Approve it. The read checked every step's done-when against a test the fakes can run, every seam against the rules in `rules/` and the paths that exist today, every stop against a call Rob has to make, and found them sound; the three findings above change no step and no stop. Q7, Q8 and Q9 are settled on their leans as D39, D40 and D41, so range 1 builds through no open call; four questions stay open, each at the stop the spec names.

  **1.** Item 3's stop, after spec step 10, is a review the spec never asked for; it sits in `## Build ranges` only because the leases pause has to be a bare item

  plumbbob pauses mid-range only as a bare `/plumbbob:build N`, so the playbook's pause at spec step 11 (item 4) forces the span before it to end at spec step 10. The call written there, reading the twenty-request routing table as the Stage A routing policy, is real but small. Closing it means dropping that pause and folding items 3 to 5 into one `/plumbbob:build 8-12` span, which is Rob's call, not the plan's; the playbook asked for the pause.

  **2.** `cli.ts` collides with two existing checks: the 70 % coverage floor and oxlint's `no-console`

  `packages/penfield/src/cli.ts` sits under `src/`, so vitest's thresholds count it, yet an e2e that spawns the built binary covers none of it in-process. The first step's builder should keep `cli.ts` a shim (the shebang and one call) and put argument parsing and the subcommands in a tested function, which the seam allows but does not say. `.oxlintrc.json` sets `no-console` to `warn`; whether the lint slot fails on warnings is unconfirmed, and writing to `process.stdout` sidesteps the question. Neither changes a step or a stop.

  **3.** Plan step 13's "heap growth under 32 MB" is the one done-when a check may not measure reliably

  The number runs under v8 coverage instrumentation, on a shared CI runner, with no `--expose-gc`; it can flake without the proxy buffering anything. The same step's other assertion, the first chunk reaching the client before the fake has sent the last, is the robust proof of C4. If the heap number flakes, the builder should drop it rather than widen it, and say so at the pause.
