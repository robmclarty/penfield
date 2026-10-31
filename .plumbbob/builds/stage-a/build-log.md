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

**Current step:** 6 — feat(probe): liveness, readiness, breaker and incidents (spec step 7)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status; CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint:
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(config): zod schema, loader and check-config (spec step 2)
- ☑ 2. feat(log): open penfield.db with its tables, WAL and a boot id (spec step 3)
- ☑ 3. feat(cli): serve boots, binds the LAN address and answers /healthz (spec step 4)
- ☑ 4. feat(catalogue): discover Ollama and OpenAI-compatible nodes (spec step 5)
- ☑ 5. feat(catalogue): merge overlays, pins and slots into snapshot (spec step 6)
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

- [x] pnpm 11 ignores .npmrc save-exact=true: pnpm add wrote ^ ranges for zod and yaml, pinned by hand; C17 wants it in pnpm-workspace.yaml (saveExact)
- [x] a router rule naming a profile no profiles: entry defines (the spec's stt rule) is not a D41 load check; step 9 decides: refuse at load, or a refused route
- [x] system_matches is written with PCRE (?i), which JS RegExp rejects; step 9 must turn a leading (?i) into the i flag, and nothing checks at load that the pattern compiles
- [x] api_key_env may name any env var, a subscription one included; C2 hardening would refuse CLAUDE_* names in the schema before step 4 reads the key
- [x] decisions has no column for Decision.policy (max_privacy, prefer, busy), so step 12's 'the row equals the response' cannot hold; step 12's seam lacks log/db.ts to add one
- [ ] the readiness ping omits keep_alive, so Ollama resets the pinged model's expiry to OLLAMA_KEEP_ALIVE: a model loaded with keep_alive -1 drops to the default; the Q2 spike should compare expires_at in /api/ps before and after a ping

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

- 2026-10-31, at range 1 of 8's stop: 5 parked ideas, classified.
- **tangent**: park 1 · pnpm 11 ignores .npmrc save-exact=true: pnpm add wrote ^ ranges for zod and yaml, pinned by hand; C17 wants it in pnpm-workspace.yaml (saveExact) → hand-pinning works, and `saveExact: true` in `pnpm-workspace.yaml` is a one-line fix at any boundary
- **tangent**: park 2 · a router rule naming a profile no profiles: entry defines (the spec's stt rule) is not a D41 load check; step 9 decides: refuse at load, or a refused route → the house file has no `stt` rule, and step 9's rule rung can refuse a profile that does not exist
- **tangent**: park 3 · system_matches is written with PCRE (?i), which JS RegExp rejects; step 9 must turn a leading (?i) into the i flag, and nothing checks at load that the pattern compiles → step 9's twenty-request table hits it on the classify row, and `route/rungs/rule.ts` can turn a leading `(?i)` into the `i` flag
- **blocker**: park 4 · api_key_env may name any env var, a subscription one included; C2 hardening would refuse CLAUDE_* names in the schema before step 4 reads the key → C2 (no-subscription-credential) is held only by the ast-grep rule on names in code, and the file can point step 4 at any env var
- **blocker**: park 5 · decisions has no column for Decision.policy (max_privacy, prefer, busy), so step 12's 'the row equals the response' cannot hold; step 12's seam lacks log/db.ts to add one → step 12's done-when says the row equals the response, and `Decision.policy` has no column to hold it

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

- 2026-10-31 — step 1 checkpointed · 72d9b5520 — feat(config): zod schema, loader and check-config (spec step 2) (1 drift, 7m)
- 2026-10-31 — step 2 checkpointed · 90987f05a — feat(log): open penfield.db with its tables, WAL and a boot id (spec step 3) (1m)
- 2026-10-31 — step 3 checkpointed · 0335cfc7c — feat(cli): serve boots, binds the LAN address and answers /healthz (spec step 4) (1 drift, 3m)
- 2026-10-31 — range 1 of 8's stop recorded — review the zod schema in `config/schema.ts` and `deploy/penfield.example.yaml` before anything reads them: this is spec range 1's look at the schema, and every later step's types come from it

  **Summary**: The service now has its spine. The zod schema covers all of spec §5.1 and loads `penfield.yaml` with every default applied. Any failure prints as `file:line:col path: message`, and `penfield check-config` prints the merged file. `penfield.db` opens in WAL mode with the three tables and a fresh instance id per boot. `penfield serve` takes the D29 (laptop-overrides) flags, refuses every-interface binds per C5 (lan-and-tokens), prints its banner and answers `/healthz` with each node `unknown`. Coverage is 96 %.

  1. Steps 1 and 3 landed a hair off, and only for the lockfile
  2. The schema carries every knob a later step reads, because no later seam includes it
  3. Every issue lands on the line an editor would jump to
  4. The `--allow-any-interface` pass is proven by a unit test, not by binding every interface
  5. The bin runs in-process under test

  **Readout**:

  ```text
  steps        3 of 3 landed
               - 1 72d9b55 · 2 90987f0 · 3 0335cfc
  check        green: 3 of 9 checks, 3 landings · without 6 others
  done-when    met
  decisions    honored: 6
  constraints  17 of 17 honored
  seam         strayed: 2 paths outside 2 steps' seams
               - step 1: pnpm-lock.yaml
               - step 3: pnpm-lock.yaml
  diff         +2061 -17 across 25 files
               - deploy/penfield.example.yaml +83 -0
               - fallow.toml +1 -0
               - packages/penfield/package.json +8 -0
               - packages/penfield/src/__tests__/penfield.test.ts +0 -7
               - packages/penfield/src/cli.ts +175 -5
               - packages/penfield/src/config/__tests__/load.test.ts +280 -0
               - packages/penfield/src/config/defaults.ts +58 -0
               - and 18 more
  spent        11 min · green first run at every landing · 2 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Harvested**: 5 of 5 parked ideas open

  | Park | What it is | Why it matters | Lean |
  | --- | --- | --- | --- |
  | P1 · pnpm ignores save-exact | pnpm 11 ignores .npmrc save-exact=true: pnpm add wrote ^ ranges for zod and yaml, pinned by hand; C17 wants it in pnpm-workspace.yaml (saveExact) | every later dependency add lands a caret unless the builder pins it, against C17 (pnpm-release-age) | tangent: hand-pinning works, and `saveExact: true` in `pnpm-workspace.yaml` is a one-line fix at any boundary |
  | P2 · Rules naming missing profiles | a router rule naming a profile no profiles: entry defines (the spec's stt rule) is not a D41 load check; step 9 decides: refuse at load, or a refused route | a typo in a rule's profile would fail at request time, not at boot | tangent: the house file has no `stt` rule, and step 9's rule rung can refuse a profile that does not exist |
  | P3 · PCRE case flag in rules | system_matches is written with PCRE (?i), which JS RegExp rejects; step 9 must turn a leading (?i) into the i flag, and nothing checks at load that the pattern compiles | JS RegExp rejects `(?i)`, so the house file's classify rule cannot compile as written | tangent: step 9's twenty-request table hits it on the classify row, and `route/rungs/rule.ts` can turn a leading `(?i)` into the `i` flag |
  | P4 · Refuse Claude env names | api_key_env may name any env var, a subscription one included; C2 hardening would refuse CLAUDE_* names in the schema before step 4 reads the key | an `api_key_env` naming a subscription variable makes the gateway read the credential C2 forbids | blocker: C2 (no-subscription-credential) is held only by the ast-grep rule on names in code, and the file can point step 4 at any env var |
  | P5 · Decision policy column | decisions has no column for Decision.policy (max_privacy, prefer, busy), so step 12's 'the row equals the response' cannot hold; step 12's seam lacks log/db.ts to add one | step 12 cannot meet its done-when, and its seam lacks `log/db.ts` to add the column | blocker: step 12's done-when says the row equals the response, and `Decision.policy` has no column to hold it |

  **Recommendation**: Read `config/schema.ts` against section 2's list, then reply `looks good` to fold P4 and P5. P4 adds to step 4's done-when and seam: an `api_key_env` whose name starts with `CLAUDE_` fails at load, with `config/schema.ts` in the seam. P5 adds to step 12's: a `policy` JSON column on `decisions`, with `log/db.ts` in the seam and a `user_version` bump. The schema is what every later step types against, and those two gaps are the only places where a later step's done-when or a constraint fails as written.

  **1.** Steps 1 and 3 landed a hair off, and only for the lockfile

  Both steps added a dependency (zod and yaml, then fastify), so `pnpm-lock.yaml` changed outside their seams. pnpm also wrote `^` ranges despite `.npmrc`'s `save-exact`, so I pinned all three exactly by hand (P1). Before step 1 would enter, `plumbbob build` refused the glob seams in `intent.md` (`fixtures/config/*.yaml` and three like it in steps 6, 8 and 18). I rewrote all four as directory grants, which changes no step's meaning.

  **2.** The schema carries every knob a later step reads, because no later seam includes it

  No step after this one may touch `config/schema.ts`, so these calls were made now and are the ones to read at this stop:

  - URL nodes (ollama, openai_compatible) have no `privacy` default, since a cloud URL that quietly read as `lan` would fail open.
  - `claude_decision` and `anthropic_api` are fixed to `cloud`.
  - `claude_decision` models are limited to haiku, sonnet and opus.
  - `probe` gains `open_after: 3` and `half_open_ms: 30000` for spec §6's breaker.
  - `ready_prompt` defaults to false until Q2 (readiness-ping-cost) is measured.
  - `slots` is `{default}` plus a count per model.
  - `busy`, `stall_ms` and `deadline_ms` take per-profile keys, and a key that names no profile fails as unknown.
  - A caller defaults to `max_privacy: lan`.
  - `auto` exists when the file has no `aliases:`.
  - A candidate's text before its first `/` is always a node (your call at planning).

  **3.** Every issue lands on the line an editor would jump to

  An unknown key points at the key itself and a bad scalar at its value. A missing key points at its parent's key, as D40 (yaml-line-counter) says. A record name with capitals points at the name. All issues print, in line order, rather than just the first. The four fixtures assert exact lines and columns, and so do the static candidate checks: an unknown node, a model or effort a hand-listed node lacks, and a bare model no node could ever have.

  **4.** The `--allow-any-interface` pass is proven by a unit test, not by binding every interface

  The e2e proves the refusal from a config on `0.0.0.0` and from `--listen 0.0.0.0:0` and `[::]:0`. The opt-in pass is a `check_bind` unit test, because binding every interface in a local test can trigger the macOS firewall prompt. The e2e boots from `deploy/penfield.example.yaml` with the D29 (laptop-overrides) flags rather than a test fixture, since that is the file the live checks run.

  **5.** The bin runs in-process under test

  `run_cli` takes argv, env, the output streams and a stop signal as values, so the e2e drives `serve` and `check-config` through the bin's own entry with no build step. That puts `cli.ts` at 91 % coverage instead of the 0 % a spawned binary would give. By hand, the built `dist/cli.js` served `/healthz` on the laptop and exited cleanly on SIGTERM.

- 2026-10-31 — step 4 checkpointed · 98dc0ce57 — feat(catalogue): discover Ollama and OpenAI-compatible nodes (spec step 5) (1 drift, 5m)
- 2026-10-31 — step 5 checkpointed · 8c4fe77f2 — feat(catalogue): merge overlays, pins and slots into snapshot (spec step 6) (4m)
