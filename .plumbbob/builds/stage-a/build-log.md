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

**Current step:** 14 — feat(wire): chat completions and embeddings end to end (spec step 15)
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
- ☑ 6. feat(probe): liveness, readiness, breaker and incidents (spec step 7)
- ☑ 7. feat(wire): caller auth, GET /catalogue and GET /v1/models (spec step 8)
- ☑ 8. feat(route): RouteInput from OpenAI chat and embeddings bodies (spec step 9)
- ☑ 9. feat(route): the explicit, alias, shape, rule and default rungs and the ladder (spec step 10)
- ☑ 10. feat(place): leases and placement (spec step 11)
- ☑ 11. feat(wire): request ids, the error envelope and fail-closed policy (spec step 13)
- ☑ 12. feat(wire): POST /route decides dry, logs the row, GET /decisions reads it (spec step 12)
- ☑ 13. feat(wire): the streaming proxy with stall, deadline and abort (spec step 14)
- ☐ 14. feat(wire): chat completions and embeddings end to end (spec step 15)
- ☐ 15. feat(wire): Zed's native agent on the gateway (spec step 16)
- ☐ 16. feat(ui): GET /leases and the status page (spec step 17)
- ☐ 17. feat(deploy): Dockerfile, compose, systemd unit and the office config (spec step 18)
- ☐ 18. feat(cli): replay re-runs the ladder over logged decisions, decisions lists them (spec step 19)
- ☐ 19. docs: README, decisions.md and the playbook as shipped (spec step 20)
- ☑ 20. fix(probe): readiness acts only on a hang, and the house file names searle's qwen3 4b tag (range 2's live run)
- ☑ 21. fix(place): a cold load never asks Ollama to evict beside a resident pin (range 4's P16)
- ☑ 22. fix(place): under `avoid`, a cold local load outranks a Claude decision ranked below it (range 5's P21)

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

- [x] pnpm 11 ignores .npmrc save-exact=true: pnpm add wrote ^ ranges for zod and yaml, pinned by hand; C17 wants it in pnpm-workspace.yaml (saveExact)
- [x] a router rule naming a profile no profiles: entry defines (the spec's stt rule) is not a D41 load check; step 9 decides: refuse at load, or a refused route
- [x] system_matches is written with PCRE (?i), which JS RegExp rejects; step 9 must turn a leading (?i) into the i flag, and nothing checks at load that the pattern compiles
- [x] api_key_env may name any env var, a subscription one included; C2 hardening would refuse CLAUDE_* names in the schema before step 4 reads the key
- [x] decisions has no column for Decision.policy (max_privacy, prefer, busy), so step 12's 'the row equals the response' cannot hold; step 12's seam lacks log/db.ts to add one
- [x] the readiness ping omits keep_alive, so Ollama resets the pinged model's expiry to OLLAMA_KEEP_ALIVE: a model loaded with keep_alive -1 drops to the default; the Q2 spike should compare expires_at in /api/ps before and after a ping
- [x] llama-swap on searle for one big model at a time and backends Ollama lacks (llama.cpp flags, mlx_lm, vLLM): it is an openai_compatible node today with residency unknown; a discoverer reading its running-model endpoint would keep pins and cold_load honest (Stage E, more nodes)
- [x] step 10's cold_load check should be memory-aware: a cold load goes ahead only when the model fits in the node's memory_gb beside its pinned and leased resident models (weights from discovery's size_bytes plus a KV allowance), else degrade or wait by the busy policy
- [x] the readiness ping sends /api/generate to every resident model, and an embedding model answers 400 'does not support generate', which the prober treats as a hang: unload_on_hang unloaded nomic-embed-text on searle and opened its breaker; readiness should count only a timeout as not ready, and ping an embedding model through /api/embed or not at all
- [x] the house file's classify and extract candidate qwen3:4b-instruct-2507 matches no tag on searle, which has qwen3:4b-instruct-2507-q4_K_M, so the gateway logs candidate_missing for both at every boot; rename it in deploy/penfield.example.yaml
- [x] a model whose readiness ping answers 4xx keeps the breaker it had (D45 counts it as nothing), so a model breaker opened by an earlier hang or 5xx stays open while every half-open ping answers 400; a 4xx in half-open might count as a success
- [x] the spec's §5.1 example and playbook §4's house config still name qwen3:4b-instruct-2507; step 19's playbook pass should carry searle's real tag qwen3:4b-instruct-2507-q4_K_M, and config/defaults.ts still says ready_prompt is off until Q2 is measured
- [x] OpenAI's metadata is a string-to-string map, so a typed SDK client (fascicle flows) cannot send metadata.penfield as an object; accept a JSON string there, or penfield.* string keys, beside the object form
- [x] the house file has no vision rule or profile, so an image routes to chat's first candidate, qwen3.6:35b-mlx, whether or not it reads images; a rule on attachments: images and a vision-capable candidate list would keep a picture off a text-only model
- [x] a system_matches pattern that does not compile is caught only when a request reaches its rule (refused then); compiling each pattern at load, (?i) included, would make it a D41 static check with a line
- [x] Ollama's eviction is not pin-aware and OLLAMA_MAX_LOADED_MODELS caps residency by count: a cold load that fits beside the pinned model by memory_gb can still make Ollama unload the pinned 27B when the count cap is hit or it picks the pinned one as least recent; a per-node max_loaded in placement, or keep_alive -1 on pinned models, would close it
- [x] searle's memory_gb is 48, but Metal's default GPU working-set limit on Apple Silicon sits below the full unified memory, so D44's fit may admit a load Ollama then splits to CPU or evicts for; set memory_gb to what Ollama reports usable, and check KV_ALLOWANCE (0.25) against /api/ps sizes on searle
- [x] the reaper and the proxy's own deadline timer both release at deadline_at, so a reaper tick landing first records the lease as orphaned rather than deadline; step 13 should give the reaper a grace past deadline_at, or log the outcome from the proxy whatever release returns
- [x] with max_loaded 2 and both the pinned 27B and the 35B resident on searle, D46 refuses every cold load there, an embedding model included, so /v1/embeddings with auto fails until one unloads; OLLAMA_MAX_LOADED_MODELS 3 on searle, or an embedding model kept resident, would leave room
- [x] prober.test.ts runs its hang cases at timeout_ms 300, which also times liveness and discovery against the local fake, so under a loaded gate (28 s against 6) /api/version or /api/tags can miss 300 ms, searle reads down, and 'a hung resident model ... is unloaded once' sees no generate at all; a fake-clock readiness timeout, or a longer liveness budget than the hang's, would keep it off the gate
- [x] under cold_load avoid a Claude decision counts as ready and ranks ahead of a cold local load, and penfield never loads a pin, so on an idle searle (/api/ps empty at range 5's live stop) every auto chat from a cloud caller goes to claude/sonnet, and nothing penfield does for rob or zed-native ever loads a chat model there; a cold local candidate could give way only to a ready local one ranked below it, never to a decision
- [ ] spec §6 says three stalls in five minutes open the node's breaker; the proxy writes each stall incident, but nothing counts them into the prober's breaker, so a node that stalls every request stays placeable
- [ ] the proxy sends no node key: an openai_compatible node with api_key_env (openrouter) would answer 401; plan step 14 or Stage D should pass the key the catalogue resolves from env, as discovery does
- [ ] upstream_prompt_tokens is read only from an event stream's last usage chunk; a stream: false chat and every /v1/embeddings answer carry usage in their JSON body and log null, which thins Q4's sample
- [ ] the forwarded body is the parsed body re-serialized with model swapped, so a number's spelling can change (1.0 goes up as 1, an integer past 2^53 loses digits); rewriting model in the raw bytes would hold C1 to the byte
- [ ] Fastify's default bodyLimit is 1 MiB, so a chat body past it (an image as base64, a long Zed thread with files) gets a 413 before routing; create_server could set bodyLimit, or server: could carry one

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
- 2026-11-01, at range 2 of 8's stop: 5 parked ideas, classified.
- **tangent**: park 6 · the readiness ping omits keep_alive, so Ollama resets the pinged model's expiry to OLLAMA_KEEP_ALIVE: a model loaded with keep_alive -1 drops to the default; the Q2 spike should compare expires_at in /api/ps before and after a ping → the spike showed a ping leaves a `keep_alive: -1` expiry untouched on Ollama 0.34.2, so there is nothing to fix
- **tangent**: park 7 · llama-swap on searle for one big model at a time and backends Ollama lacks (llama.cpp flags, mlx_lm, vLLM): it is an openai_compatible node today with residency unknown; a discoverer reading its running-model endpoint would keep pins and cold_load honest (Stage E, more nodes) → Ollama's own scheduler covers one big model at a time for now, and a llama-swap node is Stage E's more-nodes work
- **blocker**: park 8 · step 10's cold_load check should be memory-aware: a cold load goes ahead only when the model fits in the node's memory_gb beside its pinned and leased resident models (weights from discovery's size_bytes plus a KV allowance), else degrade or wait by the busy policy → step 10's done-when refuses a cold load that would evict a pinned model, and only a fit against `memory_gb` can tell when one would
- **blocker**: park 9 · the readiness ping sends /api/generate to every resident model, and an embedding model answers 400 'does not support generate', which the prober treats as a hang: unload_on_hang unloaded nomic-embed-text on searle and opened its breaker; readiness should count only a timeout as not ready, and ping an embedding model through /api/embed or not at all → with `ready_prompt` on, the gateway unloads searle's embedding model whenever a readiness tick finds it resident, so it becomes a fix step at the head of range 3
- **blocker**: park 10 · the house file's classify and extract candidate qwen3:4b-instruct-2507 matches no tag on searle, which has qwen3:4b-instruct-2507-q4_K_M, so the gateway logs candidate_missing for both at every boot; rename it in deploy/penfield.example.yaml → a one-line rename in the house file, riding P9's fix step
- 2026-11-01, at range 3 of 8's stop: 5 parked ideas, classified.
- **tangent**: park 11 · a model whose readiness ping answers 4xx keeps the breaker it had (D45 counts it as nothing), so a model breaker opened by an earlier hang or 5xx stays open while every half-open ping answers 400; a 4xx in half-open might count as a success → an embedding model's breaker opens only after a hang or 5xx, which its 400 from Ollama's capability check makes unlikely
- **tangent**: park 12 · the spec's §5.1 example and playbook §4's house config still name qwen3:4b-instruct-2507; step 19's playbook pass should carry searle's real tag qwen3:4b-instruct-2507-q4_K_M, and config/defaults.ts still says ready_prompt is off until Q2 is measured → step 19 rewrites the playbook as shipped from the house file, which now carries the tag, and the spec is a settled source
- **tangent**: park 13 · OpenAI's metadata is a string-to-string map, so a typed SDK client (fascicle flows) cannot send metadata.penfield as an object; accept a JSON string there, or penfield.* string keys, beside the object form → no client sends metadata.penfield yet, and every hint has a header today
- **tangent**: park 14 · the house file has no vision rule or profile, so an image routes to chat's first candidate, qwen3.6:35b-mlx, whether or not it reads images; a rule on attachments: images and a vision-capable candidate list would keep a picture off a text-only model → rules already match `attachments: images`, so a vision rule is a config edit you can make at any time
- **tangent**: park 15 · a system_matches pattern that does not compile is caught only when a request reaches its rule (refused then); compiling each pattern at load, (?i) included, would make it a D41 static check with a line → the ladder already refuses a broken pattern with its reason, so a load check only moves the error earlier
- 2026-11-01, at the step 10 boundary: 3 parked ideas, classified.
- **blocker**: park 16 · Ollama's eviction is not pin-aware and OLLAMA_MAX_LOADED_MODELS caps residency by count: a cold load that fits beside the pinned model by memory_gb can still make Ollama unload the pinned 27B when the count cap is hit or it picks the pinned one as least recent; a per-node max_loaded in placement, or keep_alive -1 on pinned models, would close it → step 10 promises a pinned model is never evicted, but Ollama picks what to unload, so the promise holds only for the memory fit; a fix step at the head of range 5 builds it on Opus beside the placement code, before step 14 sends real traffic
- **tangent**: park 17 · searle's memory_gb is 48, but Metal's default GPU working-set limit on Apple Silicon sits below the full unified memory, so D44's fit may admit a load Ollama then splits to CPU or evicts for; set memory_gb to what Ollama reports usable, and check KV_ALLOWANCE (0.25) against /api/ps sizes on searle → `memory_gb` is a number in the house file you can change at any time, and the usable figure needs a reading on searle, best taken at range 7's live stop when real loads run
- **blocker**: park 18 · the reaper and the proxy's own deadline timer both release at deadline_at, so a reaper tick landing first records the lease as orphaned rather than deadline; step 13 should give the reaper a grace past deadline_at, or log the outcome from the proxy whatever release returns → step 13's done-when says the lease is released exactly once and a deadline ends as `deadline`, but its seam lacks `place/reaper.ts`, which can take the release first; fold a grace past `deadline_at` into step 13 and add the reaper to its seam
- 2026-11-01, at range 5 of 9's stop: 3 parked ideas, classified.
- **tangent**: park 19 · with max_loaded 2 and both the pinned 27B and the 35B resident on searle, D46 refuses every cold load there, an embedding model included, so /v1/embeddings with auto fails until one unloads; OLLAMA_MAX_LOADED_MODELS 3 on searle, or an embedding model kept resident, would leave room → the cap is a number in the house file and on searle, and whether both chat models are resident at once is best read at range 7's live stop, beside P17
- **tangent**: park 20 · prober.test.ts runs its hang cases at timeout_ms 300, which also times liveness and discovery against the local fake, so under a loaded gate (28 s against 6) /api/version or /api/tags can miss 300 ms, searle reads down, and 'a hung resident model ... is unloaded once' sees no generate at all; a fake-clock readiness timeout, or a longer liveness budget than the hang's, would keep it off the gate → it fails only when the gate runs loaded and passed on the rerun, and the fix touches only step 6's test, small enough for any boundary
- **blocker**: park 21 · under cold_load avoid a Claude decision counts as ready and ranks ahead of a cold local load, and penfield never loads a pin, so on an idle searle (/api/ps empty at range 5's live stop) every auto chat from a cloud caller goes to claude/sonnet, and nothing penfield does for rob or zed-native ever loads a chat model there; a cold local candidate could give way only to a ready local one ranked below it, never to a decision → on an idle searle every `auto` chat from rob or Zed goes to Claude and nothing ever loads a local chat model, so the Frame's curl check and range 7's Zed chat cannot answer from searle; fold it as D48 and a fix step on Opus ahead of step 13

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
- 2026-10-31 — step 6 checkpointed · ed7d7697a — feat(probe): liveness, readiness, breaker and incidents (spec step 7) (1 drift, 7m)
- 2026-10-31 — step 7 checkpointed · 86d63084c — feat(wire): caller auth, GET /catalogue and GET /v1/models (spec step 8) (1 drift, 5m)
- 2026-11-01 — range 2 of 8's stop recorded — run the catalogue against searle with D29's laptop command and compare `/v1/models` and `/catalogue` with `ollama ps`; decide Q1 (set `OLLAMA_CONTEXT_LENGTH` on searle and record `context` in the overlay, or not); spike Q2 by timing the readiness ping on the resident MLX models and confirming nothing loaded that was not already resident

  **Summary**: The gateway now knows what searle has and what is loaded. Discovery reads `/api/tags` and `/api/ps` (or `/models` on an OpenAI-compatible node) and never throws: a node it cannot read is `down` with the reason. The catalogue merges the overlay, pins, slots and breakers into a plain-data snapshot and warns about any profile candidate no node has. The prober runs liveness, discovery and the readiness ping on each node's own interval, with a breaker per node and per model, and writes every transition to the `incidents` table. `penfield serve` reads the tokens file, refuses any request without a known caller except `/healthz`, and answers `/v1/models` and `/catalogue` by each caller's policy. All of it is proven against the fake Ollama and fake OpenAI servers. The live comparison with searle is yours, at this stop.

  1. Steps 4, 6 and 7 landed a hair off, for shared code and the `serve` wiring the live stop needs
  2. A node keeps its models through failed probes until its breaker opens
  3. `nomic-embed-text` names searle's `nomic-embed-text:latest`
  4. The live run against searle matched `ollama ps`, and found one bug
  5. Callers are refused before anything opens, and `/v1/models` names models as a client sends them

  **Readout**:

  ```text
  steps        4 of 4 landed
               - 4 98dc0ce · 5 8c4fe77 · 6 ed7d769 · 7 86d6308
  check        green: 3 of 9 checks, 4 landings · without 6 others
  done-when    met
  decisions    honored:
               - D10 (privacy-quality-speed-cost)
               - D13 (leases)
               - D14 (pinning)
               - D16 (hung-work-recovered)
               - D21 (every-request-has-caller)
               - D24 (one-yaml-entry-per-node)
               - D25 (health-where-plato-looks)
               - D27 (deps-when-first-imported)
               - D29 (laptop-overrides)
               - D30 (auth-arrives-with-models)
               - D34 (timers-injectable)
               - D38 (models-list-filters-auto)
               - D41 (candidate-two-tiers)
               - D42 (refuse-claude-env-names)
  constraints  17 of 17 honored
  seam         strayed: 14 paths outside 3 steps' seams
               - step 4: 3 paths
               - step 6: packages/penfield/src/catalogue/catalogue.ts and 2 others
               - step 7: packages/penfield/src/cli.ts and 7 others
  diff         +2778 -146 across 43 files
               - packages/penfield/src/catalogue/__tests__/catalogue.test.ts +141 -0
               - packages/penfield/src/catalogue/__tests__/discover.test.ts +159 -0
               - packages/penfield/src/catalogue/__tests__/merge.test.ts +254 -0
               - packages/penfield/src/catalogue/catalogue.ts +78 -5
               - packages/penfield/src/catalogue/discover_http.ts +37 -0
               - packages/penfield/src/catalogue/discover_ollama.ts +46 -0
               - packages/penfield/src/catalogue/discover_openai.ts +25 -0
               - and 36 more
  spent        26 min · green first run at every landing · 3 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Harvested**: 5 of 10 parked ideas open

  | Park | What it is | Why it matters | Lean |
  | --- | --- | --- | --- |
  | P6 · Readiness ping resets keep_alive | the readiness ping omits keep_alive, so Ollama resets the pinged model's expiry to OLLAMA_KEEP_ALIVE: a model loaded with keep_alive -1 drops to the default; the Q2 spike should compare expires_at in /api/ps before and after a ping | a ping could have shortened a model's stay in memory, and on searle it does not | tangent: the spike showed a ping leaves a `keep_alive: -1` expiry untouched on Ollama 0.34.2, so there is nothing to fix |
  | P7 · llama-swap as a searle backend | llama-swap on searle for one big model at a time and backends Ollama lacks (llama.cpp flags, mlx_lm, vLLM): it is an openai_compatible node today with residency unknown; a discoverer reading its running-model endpoint would keep pins and cold_load honest (Stage E, more nodes) | it opens backends Ollama lacks, but hides residency from placement unless penfield reads what it has loaded | tangent: Ollama's own scheduler covers one big model at a time for now, and a llama-swap node is Stage E's more-nodes work |
  | P8 · Memory-aware cold loads | step 10's cold_load check should be memory-aware: a cold load goes ahead only when the model fits in the node's memory_gb beside its pinned and leased resident models (weights from discovery's size_bytes plus a KV allowance), else degrade or wait by the busy policy | without it a load can push searle's pinned 27B out through Ollama's own eviction | blocker: step 10's done-when refuses a cold load that would evict a pinned model, and only a fit against `memory_gb` can tell when one would |
  | P9 · Readiness breaks embedding models | the readiness ping sends /api/generate to every resident model, and an embedding model answers 400 'does not support generate', which the prober treats as a hang: unload_on_hang unloaded nomic-embed-text on searle and opened its breaker; readiness should count only a timeout as not ready, and ping an embedding model through /api/embed or not at all | the `embed` profile's model is unloaded and its breaker opened, so placement would skip it | blocker: with `ready_prompt` on, the gateway unloads searle's embedding model whenever a readiness tick finds it resident, so it becomes a fix step at the head of range 3 |
  | P10 · House qwen3 4b tag mismatch | the house file's classify and extract candidate qwen3:4b-instruct-2507 matches no tag on searle, which has qwen3:4b-instruct-2507-q4_K_M, so the gateway logs candidate_missing for both at every boot; rename it in deploy/penfield.example.yaml | `classify` and `extract` lose a candidate on searle, and every boot logs it as missing | blocker: a one-line rename in the house file, riding P9's fix step |

  **Recommendation**: Approve, keeping Q2's ping on once P9's fix lands and leaving searle's context as it is. Q2's warm pings are 81 to 119 ms and load nothing, so `ready_prompt` stays true, but only after the fix: today the ping unloads embedding models. Q1 is answered by the 131072 the 35B already runs with; keep the overlay's `context: 65536` as the budget the router reads, and check `launchctl getenv OLLAMA_CONTEXT_LENGTH` on searle when convenient. P9 and P10 become one fix step at the head of range 3, P8 folds into step 10's done-when, and P6 and P7 close as tangents.

  **1.** Steps 4, 6 and 7 landed a hair off, for shared code and the `serve` wiring the live stop needs

  Step 4 added two shared files outside its seam: `catalogue/discover_http.ts` (the one GET both discoverers use) and `test/helpers/fake_http.ts` (the recording server under both fakes). It also excluded `src/**/__tests__` from the package `tsconfig.json`, because a unit test that imports `test/helpers/` broke `rootDir`. `tsconfig.test.json` still type-checks every test, and `dist/` no longer carries them.

  Step 6 added `src/clock.ts` (the `Clock` type that leases and the proxy will take too, per D34 (timers-injectable)). It also exported `discover_node` from the catalogue, so the prober reads one node at a time with its key resolved in one place.

  Step 7's seam had no `cli.ts`, but the live check runs `serve`, so `serve` had to load tokens and start the catalogue and the prober. That touched `cli.ts`, `wire/server.ts` and `wire/healthz.ts`, and step 3's tests. The serve e2e now boots a copy of the house config with searle on the fake Ollama. Otherwise it would have probed the real searle (readiness pings included) on every test run. No later step's seam names `cli.ts` until step 17, so expect strays there again.

  **2.** A node keeps its models through failed probes until its breaker opens

  Below `open_after`, a node that was up keeps its last models in the snapshot, so one slow probe on a busy searle does not empty placement for ten seconds. It shows `down`, and its candidates turn into `candidate_missing`, only once the breaker opens or when it was never up. A failed half-open probe re-opens the breaker without a new incident, so a night with searle off writes one `breaker_open`, not a row every 30 s. Readiness runs every sixth interval (60 s at the house's 10 s), or at once after a failed probe. The file has no key for that interval yet.

  **3.** `nomic-embed-text` names searle's `nomic-embed-text:latest`

  Ollama lists a bare pull as `name:latest`, and the house file says `nomic-embed-text` in the `embed` profile and in nurselog's `models:`. The catalogue treats `x` and `x:latest` as the same model for candidates, pins, slot keys and the overlay. Without that, `embed` would read as missing on searle and nurselog would see one model instead of two. `/v1/models` lists the tag as the node has it (`nomic-embed-text:latest`).

  **4.** The live run against searle matched `ollama ps`, and found one bug

  I ran D29's command from the laptop with a fresh `~/.config/penfield/tokens` (four callers, mode 600). The banner listed all four callers, and `/healthz` showed searle `up`. The resident models in `/v1/models` matched `/api/ps` exactly (`qwen3.6:35b-mlx`), and so did all 17 tags. Night-shift saw no `claude/*`, and nurselog saw only `qwen3.8:27b-mlx` and `nomic-embed-text:latest`. No token and a bad token were both 401.

  Q2: a cold load of the 35B took 3.6 s (21.9 GB in memory). Warm empty-prompt pings took 81, 119 and 89 ms and loaded nothing else. P6 does not hold on Ollama 0.34.2: after loading with `keep_alive: -1`, a ping without `keep_alive` left `expires_at` in 2319.

  Q1: the loaded 35B reports `context_length` 131072, so a 64k prompt reaches it whole. SSH to searle is refused, so I could not read whether that is `OLLAMA_CONTEXT_LENGTH` 65536 times `OLLAMA_NUM_PARALLEL` 2, or Ollama's own default.

  The bug (P9): loading `nomic-embed-text` for the embeddings fixture made it resident, and the next readiness ping sent it `/api/generate`. It answered 400 (`does not support generate`), which the prober read as a hang. Under `unload_on_hang` it unloaded the model, failed the reload the same way, and opened that model's breaker. The house profile name `qwen3:4b-instruct-2507` matches no tag on searle (P10), so `classify` and `extract` log `candidate_missing` at every boot. The pinned 27B is cold: a pin protects a resident model and loads nothing, so nurselog's first request will cold-load it.

  The fixtures for plan step 13 are in `packages/penfield/test/fixtures/ollama/`. They are a streamed chat with reasoning off (22 lines), the first 12 chunks and the last three events of a 9,385-token reasoning stream (the full capture was 1.9 MB), and one embeddings response. They are untracked and ride the next checkpoint. I unloaded the 35B afterwards, so searle is back to nothing loaded.

  **5.** Callers are refused before anything opens, and `/v1/models` names models as a client sends them

  A missing or malformed tokens file, or a line naming a caller `penfield.yaml` lacks, stops `serve` before it opens the state dir, with the line. An empty file boots, and the banner says every request but `/healthz` is refused. The auth hook is fail-closed: only `/healthz` is public, so an unknown path without a token is a 401, not a 404. In `/v1/models` a tag is listed bare (what a client sends for D6 (explicit-wins)), a decision node's model as `claude/<model>`, and a tag two nodes share as `node/tag` on both.

- 2026-11-01 — step 20 checkpointed · 65884f1f5 — fix(probe): readiness acts only on a hang, and the house file names searle's qwen3 4b tag (range 2's live run) (1 drift, 3m)
- 2026-11-01 — step 8 checkpointed · 1830c5c44 — feat(route): RouteInput from OpenAI chat and embeddings bodies (spec step 9) (5m)
- 2026-11-01 — step 9 checkpointed · bac88e15d — feat(route): the explicit, alias, shape, rule and default rungs and the ladder (spec step 10) (1 drift, 8m)
- 2026-11-01 — range 3 of 8's stop recorded — read the twenty-request routing table in `route/__tests__/ladder.test.ts` as the Stage A routing policy before placement and `/route` build on it; the leases pause that follows is why this span ends here

  **Summary**: Range 3 fixed the readiness bug from range 2's live run and built routing. A 4xx no longer unloads a model, and the house file names searle's real qwen3 4b tag. Then came the RouteInput parser for OpenAI chat and embeddings bodies, and the ladder (explicit, alias, shape, rule, default), with a twenty-request table over the house file as Stage A's routing policy. All three steps landed green; two strayed from their seams.

  1. Two checkpoints reached past their seams, both on purpose
  2. The table reads as the house policy, and four rows deserve a look
  3. A profile nobody defines is refused wherever it is named
  4. RouteInput makes four small calls the spec left open
  5. Readiness now acts on how a ping failed, per D45

  **Readout**:

  ```text
  steps        3 of 3 landed
               - 20 65884f1 · 8 1830c5c · 9 bac88e1
  check        green: 9 of 9 checks, 3 landings
  done-when    met
  decisions    honored:
               - D45 (readiness-acts-on-a-hang)
               - D6 (explicit-wins), D7 (cheapest-rung-first)
               - D35 (shape-is-the-endpoint)
  constraints  17 of 17 honored
  seam         strayed: 4 paths outside 2 steps' seams
               - step 20: 3 paths
               - step 9: packages/penfield/src/route/types.ts
  diff         +1412 -12 across 26 files
               - deploy/penfield.example.yaml +2 -2
               - packages/penfield/src/probe/__tests__/prober.test.ts +40 -0
               - packages/penfield/src/probe/prober.ts +5 -1
               - packages/penfield/src/probe/readiness.ts +15 -5
               - packages/penfield/src/route/__tests__/input.test.ts +216 -0
               - packages/penfield/src/route/__tests__/ladder.test.ts +338 -0
               - packages/penfield/src/route/index.ts +5 -1
               - and 19 more
  spent        17 min · green first run at every landing · 2 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Harvested**: **5** of 15 parked ideas open

  | Park | What it is | Why it matters | Lean |
  | --- | --- | --- | --- |
  | P11 · 4xx in half-open | a model whose readiness ping answers 4xx keeps the breaker it had (D45 counts it as nothing), so a model breaker opened by an earlier hang or 5xx stays open while every half-open ping answers 400; a 4xx in half-open might count as a success | a model breaker stuck open would make its profile unplaceable once step 10 reads breakers | tangent: an embedding model's breaker opens only after a hang or 5xx, which its 400 from Ollama's capability check makes unlikely |
  | P12 · stale qwen3 tag in docs | the spec's §5.1 example and playbook §4's house config still name qwen3:4b-instruct-2507; step 19's playbook pass should carry searle's real tag qwen3:4b-instruct-2507-q4_K_M, and config/defaults.ts still says ready_prompt is off until Q2 is measured | a reader copying playbook §4 would get candidate_missing on searle | tangent: step 19 rewrites the playbook as shipped from the house file, which now carries the tag, and the spec is a settled source |
  | P13 · string-only OpenAI metadata | OpenAI's metadata is a string-to-string map, so a typed SDK client (fascicle flows) cannot send metadata.penfield as an object; accept a JSON string there, or penfield.* string keys, beside the object form | a typed SDK client could not send hints in the body at all | tangent: no client sends metadata.penfield yet, and every hint has a header today |
  | P14 · no vision route | the house file has no vision rule or profile, so an image routes to chat's first candidate, qwen3.6:35b-mlx, whether or not it reads images; a rule on attachments: images and a vision-capable candidate list would keep a picture off a text-only model | a picture lands on a text-only model and gets a confident wrong answer | tangent: rules already match `attachments: images`, so a vision rule is a config edit you can make at any time |
  | P15 · compile patterns at load | a system_matches pattern that does not compile is caught only when a request reaches its rule (refused then); compiling each pattern at load, (?i) included, would make it a D41 static check with a line | a typo in system_matches would refuse requests at runtime instead of failing the boot with a line | tangent: the ladder already refuses a broken pattern with its reason, so a load check only moves the error earlier |

  **Recommendation**: Read the table at `packages/penfield/src/route/__tests__/ladder.test.ts:93-120` and confirm it as Stage A's routing policy, with all five parks as tangents. The table matches the house file as written, so a row you would change is a rule or profile edit, which is cheaper now than after placement and `/route` build on it; the image row (P14) is the likeliest one.

  **1.** Two checkpoints reached past their seams, both on purpose

  Step 20's checkpoint swept in the three Ollama captures range 2 left untracked in `packages/penfield/test/fixtures/ollama/` (a streamed chat, a reasoning stream excerpt, an embeddings response). They are meant for plan step 13, and the range 2 record said they would ride the next checkpoint, so they are in `65884f1` rather than in step 13's diff. Step 9 added the ladder's types (`Rung`, `Answer`, `RungResult`, `ModelRung`, `RoutedProfile`) to `route/types.ts`, beside `RouteInput`. That file is step 8's, not in step 9's seam. Putting the types in `ladder.ts` would have made the rungs import from the ladder that imports them, a cycle fallow would flag. Neither stray changes behaviour.

  **2.** The table reads as the house policy, and four rows deserve a look

  The table is at `packages/penfield/src/route/__tests__/ladder.test.ts:93-120`, one row per request, each rendered as `profile · rung · confidence`. On the house file, rule 8 (`chat: true`) answers every chat request at 1.0, so the `default` rung never fires there; it is tested on a file without that rule. The rows worth reading twice:

  - An image routes to `chat`, so to `qwen3.6:35b-mlx`, because the house has no vision rule (P14).
  - Rule order is policy: a profile hint outranks tools, and tools outrank length (a 30 k-token agent turn is `code-heavy`, not `summarize`).
  - `tokens_gt` is strictly over: an agent turn at exactly 12000 tokens is `code-light`.
  - A profile's own name (`summarize`) routes there at the `alias` rung, past every rule, even with tools.

  **3.** A profile nobody defines is refused wherever it is named

  This is P2's call, made here: the rule rung, the `$hint` rule, the shape rung (`audio_transcriptions` wants `stt`, which the house lacks) and the default all go through one check. A profile `profiles:` lacks is a refused result naming it, never a fall-through to the next rule. A `system_matches` that does not compile refuses the request that reaches it, so a broken rule cannot reroute traffic without saying so (P15 would move that error to load). P3's `(?i)` is handled as any leading `(?ims)` group becoming the RegExp's flags. A model that is no alias, profile or catalogue model is refused at `explicit`, naming any node that is down, since it may hold the model. `route` returns a Promise, because the Stage C rungs it takes as functions call a model; Stage A passes none.

  **4.** RouteInput makes four small calls the spec left open

  An `x-penfield-*` header wins over `metadata.penfield`: the header is set by whatever sends the request to penfield, which may sit above the tool that wrote the body. "4 k" and "1 k" are 4096 and 1024, the way the house counts 64 k as 65536. A hint that cannot be read (`x-penfield-max-privacy: public`) refuses the request rather than being dropped, since dropping a stricter privacy would route above what the sender asked (C11 (fail-closed)). Attachments are read from user messages only, images over code over docs, and code is a fenced block or a file part with a code extension. An assistant's code in the history is not an attachment.

  **5.** Readiness now acts on how a ping failed, per D45

  The readiness call reports `hang`, `server`, `client` or `unreachable`. A 4xx is the runner answering (an embedding model refusing `generate`) and counts as nothing; a 5xx or a refused connection counts toward the model's breaker without an unload; only a hang takes `unload_on_hang`. The fake Ollama gained an embedding model that answers 400 and a crashed runner that answers 500. Counting a 4xx as nothing has one corner, P11: a model breaker opened earlier by a hang stays open while every half-open ping answers 400.

- 2026-11-01 — step 10 checkpointed · 56da9737f — feat(place): leases and placement (spec step 11) (1 drift, 80m)

  **Summary**: Placement and the lease table are in. `place` picks a target from live state without taking a lease. `claim` takes the lease, and under `wait` it queues in a FIFO per model. One idempotent `release` frees every lease, and the boot sweep and the reaper go through it too. Three of the rules are my reading of the plan and need your call: `wait` holds out for the top-ranked candidate, the memory fit adds a quarter of a model's weights for its KV cache, and under `avoid` a Claude decision wins over a cold local load.

  1. `wait` holds out for the top-ranked candidate, and `degrade` moves to the next one with a free slot
  2. A cold load must fit beside the pinned and leased models, with a quarter of the weights added for the KV cache
  3. Under `avoid`, a Claude decision ranks with the resident models, ahead of a cold local load
  4. Leases are SQLite rows, taken by one conditional insert and freed by one idempotent release, and serve now sweeps and reaps them
  5. Smaller calls: an unprobed node is skipped, a hint can lower privacy but never raise it, and `prefer` re-ranks the candidates

  **Readout**:

  ```text
  check        green: 9 of 9 checks
  done-when    met
  decisions    bent: D12 (placement-reads-live-state)
               → wait holds for the top pick; allow ranks cold loads in; see 1, 3
  constraints  17 of 17 honored
  seam         strayed: 4 paths outside the seam
               - packages/penfield/src/catalogue/__tests__/merge.test.ts
               - packages/penfield/src/catalogue/index.ts
               - packages/penfield/src/cli.ts
               - packages/penfield/src/ui/api.ts
  diff         +1479 -5 across 11 files
               - packages/penfield/src/catalogue/__tests__/merge.test.ts +1 -0
               - packages/penfield/src/catalogue/index.ts +1 -1
               - packages/penfield/src/catalogue/merge.ts +4 -0
               - packages/penfield/src/cli.ts +20 -3
               - packages/penfield/src/place/__tests__/leases.test.ts +236 -0
               - packages/penfield/src/place/__tests__/placement.test.ts +492 -0
               - packages/penfield/src/place/index.ts +5 -0
               - and 4 more
  spent        80 min · 4 turns · 5s gate · green first run
  ```

  **Verdict**: ○ Out of plumb (decisions bent)

  **Recommendation**: Approve the lease rules after you check the three readings in sections 1 to 3. They are where a wrong lease rule costs the most: `wait` holding out for the top-ranked model, the memory fit with its quarter-weight KV allowance, and `avoid` letting a Claude decision win over a cold load. Each is a line or two to change if you read D12 and D15 the other way. P16 is the park I would fix before Stage A ships, since Ollama can still unload the pinned 27B on its own.

  **1.** `wait` holds out for the top-ranked candidate, and `degrade` moves to the next one with a free slot

  D15 makes `degrade` the default for interactive callers and `wait` the default for batch. Read literally, D12 applies the busy policy only once no candidate has a slot. Then a batch caller would degrade just like an interactive one whenever candidate two was free, and `wait` would matter only when every candidate was full. I read `wait` as a batch caller choosing to hold out for its best model. When that model is busy, `place` keeps it as the target and adds a reason saying it waits. `claim` then queues in that model's FIFO for up to `wait_ms` (120 s for night-shift) and refuses with the reason once the time runs out. `degrade` takes the next candidate with a free slot and sets `degraded_from`. When no candidate is free, it refuses at once, which is the Frame's "fails fast with a clear error". The busy mode comes from the caller's `busy`, else the profile's key in `policy.busy`, else `policy.busy.default`. `wait_ms` comes from the caller, else the policy. If you read D12 the other way, the change is two lines in `choose` in `placement.ts`.

  **2.** A cold load must fit beside the pinned and leased models, with a quarter of the weights added for the KV cache

  Under D44, a model's footprint is its `size_bytes` on disk times 1.25 (`KV_ALLOWANCE`). A load goes ahead when its footprint, plus that of every resident model on the node that is pinned or holds a lease, fits in `memory_gb`. An idle, unpinned resident model is what a load may evict. The reason names those models, and the pinned model never appears in that list. A model that holds a lease counts as resident even if the last discovery said cold, so two quick requests are not counted as two loads. A node with no `memory_gb`, or a model with no size, can load only when nothing pinned or leased is resident. The tests use house-like sizes. With the pinned 27B resident and the 35B leased, nothing else fits on searle. With the 35B idle, a 20 GB load fits and names the 35B as the model it may evict. One gap remains: Ollama picks what to unload, and it knows nothing of penfield's pins. Under `OLLAMA_MAX_LOADED_MODELS=2`, a third model can make it unload the pinned 27B. That is parked as P16. P17 covers checking `memory_gb` against Metal's usable memory on searle.

  **3.** Under `avoid`, a Claude decision ranks with the resident models, ahead of a cold local load

  The done-when needs three distinct behaviours. `allow` takes the profile's rank order and treats a cold load as being as good as a resident model. `avoid` takes every candidate that can serve without a load before any cold load: a resident model, one whose residency is unknown, or a Claude decision. `never` loads nothing. D12's literal order, resident first and then cold, is `avoid`, and that is the house default. One consequence: if both local chat models are cold, rob's chat request goes to `claude/sonnet@low` rather than a 3.6 s load of the 35B. In the house file the 27B is pinned and normally resident, so this rarely happens. The other reading would rank a Claude decision after cold local loads.

  **4.** Leases are SQLite rows, taken by one conditional insert and freed by one idempotent release, and serve now sweeps and reaps them

  `acquire` is one `insert … select … where count < slots`, so the slot is checked and taken in a single statement. `release(id, outcome)` changes only an active row: it returns true the first time, and every later call leaves the row as it ended. It also hands the freed slot to the head of that model's queue. The boot sweep and the reaper both go through it, with outcome `orphaned` and an `orphaned` incident. A new claim never jumps the queue. A waiter leaves the queue when its `wait_ms` runs out or its `AbortSignal` fires. Outside the seam, `cli.ts` now creates the lease table and sweeps the last instance's leases before it listens. It runs the reaper with the most frequent probe, at least every 10 s. `/catalogue`'s `slots_in_use` now reads the table; the comment in `ui/api.ts` already said that would come in this step. `merge.test.ts` gains `memory_gb: null`, and `catalogue/index.ts` exports `CatalogueNode`.

  **5.** Smaller calls: an unprobed node is skipped, a hint can lower privacy but never raise it, and `prefer` re-ranks the candidates

  A node that has not been probed yet is skipped, which fails closed for the few milliseconds after boot. The `max_privacy` cap is the lowest of the caller's, the alias's and the request hint's, and the reason names which one set it. `prefer`, from an alias or a hint, re-sorts the candidates by the overlay's speed or quality and keeps the profile's order between ties, so `auto/best` puts `claude/sonnet` first for rob. A Claude target's effort is the request's hint when the node offers it, else the candidate's, else `medium`. Two fields go beyond spec §5.3's shape: `Decision.profile` is null when a request named a model, and `Decision.policy` carries `wait_ms` under `wait`. `place` takes the decision's id and time as an argument, so it stays pure.

- 2026-11-01 — step 21 checkpointed · 9b4926bd6 — fix(place): a cold load never asks Ollama to evict beside a resident pin (range 4's P16) (7m)
- 2026-11-01 — step 11 checkpointed · ed659904a — feat(wire): request ids, the error envelope and fail-closed policy (spec step 13) (1 drift, 6m)
- 2026-11-01 — step 12 checkpointed · 0b17e071c — feat(wire): POST /route decides dry, logs the row, GET /decisions reads it (spec step 12) (1 drift, 6m)
- 2026-11-01 — range 5 of 9's stop recorded — the first `auto` decision, dry: `POST /route` against searle with a short question decides a resident chat candidate, and the `/decisions` row matches the response; this is spec range 3's stop

  **Summary**: Range 5 closed range 4's pin gap and made the first decision. Step 21 lets a cold load go ahead beside a resident pin only when it needs no eviction at all, judged by memory and by a new per-node `max_loaded`. Step 11 puts a request id on every response, wraps every error in OpenAI's error shape, and sends a 403 when a caller names a model it may not use. Step 12 adds `POST /route`, which decides without taking a lease and logs the row, and `GET /decisions`, which reads that row back equal to the response. All three steps landed green on the first run. Steps 11 and 12 strayed outside their seams to wire the server and the CLI. Live on searle, the row matched the response, but the decision went to Claude: searle had nothing loaded, and under `avoid` a Claude decision outranks a cold load (P21).

  1. Live on searle, the row matched the response, but the decision was Claude, because searle had nothing loaded (P21)
  2. Steps 11 and 12 strayed outside their seams to wire the server and the CLI
  3. On searle at `max_loaded: 2`, nothing cold-loads while the pinned 27B and the 35B are both resident (P19)
  4. A refused decision's reason is read back from its last reason line, because no column holds it
  5. `/route` returns 200 for every decision except the policy's 403, refusals included

  **Readout**:

  ```text
  steps        3 of 3 landed
               - 11 ed65990 · 12 0b17e07 · 21 9b4926b
  check        green: 9 of 9 checks, 3 landings
  done-when    met
  decisions    honored:
               - D46 (ollama-picks-the-evictee)
               - D30 (auth-arrives-with-models), D38 (models-list-filters-auto)
               - D31 (log-carries-route-input), D43 (decision-policy-column)
  constraints  17 of 17 honored
  seam         strayed: 9 paths outside 2 steps' seams
               - step 11: packages/penfield/src/wire/openai.ts and 2 others
               - step 12: packages/penfield/src/cli.ts and 5 others
  diff         +1159 -87 across 27 files
               - deploy/penfield.example.yaml +1 -0
               - packages/penfield/src/catalogue/__tests__/merge.test.ts +12 -0
               - packages/penfield/src/catalogue/merge.ts +19 -14
               - packages/penfield/src/cli.ts +10 -2
               - packages/penfield/src/config/__tests__/load.test.ts +16 -0
               - packages/penfield/src/config/schema.ts +2 -0
               - packages/penfield/src/index.ts +2 -2
               - and 20 more
  spent        20 min · green first run at every landing · 2 drift warnings
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Harvested**: **3** of 21 parked ideas open

  | Park | What it is | Why it matters | Lean |
  | --- | --- | --- | --- |
  | P19 · Embeddings at the cap | with max_loaded 2 and both the pinned 27B and the 35B resident on searle, D46 refuses every cold load there, an embedding model included, so /v1/embeddings with auto fails until one unloads; OLLAMA_MAX_LOADED_MODELS 3 on searle, or an embedding model kept resident, would leave room | with both chat models resident on searle, every embeddings request would be refused | tangent: the cap is a number in the house file and on searle, and whether both chat models are resident at once is best read at range 7's live stop, beside P17 |
  | P20 · Prober hang test flakes | prober.test.ts runs its hang cases at timeout_ms 300, which also times liveness and discovery against the local fake, so under a loaded gate (28 s against 6) /api/version or /api/tags can miss 300 ms, searle reads down, and 'a hung resident model ... is unloaded once' sees no generate at all; a fake-clock readiness timeout, or a longer liveness budget than the hang's, would keep it off the gate | a red gate on a flake holds the end of every turn until a rerun | tangent: it fails only when the gate runs loaded and passed on the rerun, and the fix touches only step 6's test, small enough for any boundary |
  | P21 · Idle searle sends chat to Claude | under cold_load avoid a Claude decision counts as ready and ranks ahead of a cold local load, and penfield never loads a pin, so on an idle searle (/api/ps empty at range 5's live stop) every auto chat from a cloud caller goes to claude/sonnet, and nothing penfield does for rob or zed-native ever loads a chat model there; a cold local candidate could give way only to a ready local one ranked below it, never to a decision | the house's `auto` chat answers from Claude, or with a hint, whenever searle has unloaded | blocker: on an idle searle every `auto` chat from rob or Zed goes to Claude and nothing ever loads a local chat model, so the Frame's curl check and range 7's Zed chat cannot answer from searle; fold it as D48 and a fix step on Opus ahead of step 13 |

  **Recommendation**: Confirm P21 as a blocker and P19 and P20 as tangents, then finish the stop's resident half by loading the 35B and asking again. The row half held live. P21's rule reverses step 10's section 3, which you approved at range 4, so it is your call; without it, `auto` chat from a cloud caller never wakes searle. To see a resident candidate decided today, load the 35B on searle:

  ```sh
  curl -s http://192.168.1.90:11434/api/generate -d '{"model":"qwen3.6:35b-mlx","keep_alive":"30m"}'
  ```

  Then rerun your two curls: the target should be `searle/qwen3.6:35b-mlx`, resident, and the row should match it again.

  **1.** Live on searle, the row matched the response, but the decision was Claude, because searle had nothing loaded (P21)

  Your `/route` call and its `/decisions` row agree field for field; only the key order differs, and the outcome columns are null as a dry row's should be. searle's `/api/ps` was empty when I read it just after, and the running gateway's `/catalogue` agreed: every chat model cold, the pinned 27B included. Under `cold_load: avoid`, step 10 counts a Claude decision as ready, so `claude/sonnet@low` ranked ahead of both cold loads, and the 35B and the 27B came back as its alternatives. That is the rule you approved at range 4 (step 10's section 3), and the live run shows what it costs. Penfield never loads a pin, and for a caller allowed cloud nothing penfield does ever loads a chat model, so an idle searle stays idle: rob's `auto` chat goes to Claude, and Zed's becomes a hint message instead of an answer at range 7's stop. The stop's other half, a resident candidate, could not be shown with nothing resident. P21 proposes the rule: under `avoid`, a cold local candidate gives way only to a ready local one ranked below it, never to a Claude decision, which keeps its rank. Over the house profiles: idle chat cold-loads the 35B; chat with the 35B resident takes it; code-light with the 35B resident takes it over the cold 27B; code-heavy still takes opus first.

  **2.** Steps 11 and 12 strayed outside their seams to wire the server and the CLI

  Request ids and the error envelope need a hook and two handlers in `wire/server.ts`, which step 11's seam does not list. Step 11 also changed `wire/openai.ts`: the `/v1/models` filter now calls the same `bar_of` as the 403. So a model the list shows can never be refused, and a model it hides always is; one test checks this for every caller and every model. The e2e 401 expectation in `test/e2e/catalogue.test.ts` gained the envelope's `param` and `request_id`. Step 12 registered `/route` and `/decisions` in `server.ts`. It passed the server the clock, the decision log and the log's reader through `cli.ts`, and exported the two new UI functions from the `ui` barrel. The three wire tests that build a server got the new deps as well. None of these changes does anything the plan does not ask for.

  **3.** On searle at `max_loaded: 2`, nothing cold-loads while the pinned 27B and the 35B are both resident (P19)

  D46 holds that while a pinned model is resident, every resident model must stay. With two models resident and a cap of 2, any third model is refused, an embedding model included. `/v1/embeddings` with `auto` would then fail until one of the two unloads. At range 2's live run only the 35B was resident, so this may rarely bite. Both fixes are config, not code: `OLLAMA_MAX_LOADED_MODELS 3` on searle with `max_loaded: 3` in the house file, or keeping an embedding model resident. Two smaller notes. A refused cold load is a skip, as under D44, and the busy policy then works over the candidates left; `degraded_from` stays unset, since it marks a busy model, not a cold one. With no pin resident, the reason strings are D44's word for word, so its tests pass unchanged.

  **4.** A refused decision's reason is read back from its last reason line, because no column holds it

  Spec §5.5 stores a target as kind, node, model and effort, so the read has to rebuild two things. A proxy target's format comes from the input column, since a request is always forwarded in its own format (C1). A refusal's reason comes from the decision's last reason line, because every refusal path ends on it. The ladder writes the reason as it stands; placement and policy write it after a `place: refused:` or `policy: refused:` prefix. The e2e reads back both a ladder refusal and a policy 403. The alternative is a `target_reason` column, added in the same `user_version` 2 migration as D43's `policy`. That would be a new decision, so I did not make it. It is a few lines if you would rather not depend on how the reasons are worded.

  **5.** `/route` returns 200 for every decision except the policy's 403, refusals included

  A body the router cannot read gets a 400 and leaves no row. A caller naming a model it may not use gets a 403 with the reason and the decision id, and the row is logged with outcome `refused`. An unknown model, a busy node, or no candidate at all returns 200 with a refused target, because the Decision is the answer `/route` exists to give. Chat completions in step 14 will need their own mapping (a 404 `model_not_found` for an unknown model, a 503 when busy). The envelope puts `request_id` and `decision_id` inside `error`, and the 403 uses the type `permission_error`. A dry row's outcome is null. `/decisions` shows every caller's rows to whoever asks, like `/catalogue`, and never returns prompt text.

- 2026-11-01 — step 22 checkpointed · d7c86b944 — fix(place): under `avoid`, a cold local load outranks a Claude decision ranked below it (range 5's P21) (5m)
- 2026-11-01 — range 9 of 9's stop recorded — with nothing resident on searle, `POST /route` with a short `auto` question decides a cold load of `qwen3.6:35b-mlx`, not Claude; then load it and ask again for the resident candidate range 5's stop could not show

  **Summary**: Range 9 fixes the rule that sent every `auto` chat to Claude when searle had nothing loaded (P21). Under `cold_load: avoid`, only a local model that is already up may now jump ahead of a cold load, and a Claude decision keeps its place in the profile's order. So with nothing resident, rob's `auto` chat cold-loads `qwen3.6:35b-mlx`, with the 27B and `claude/sonnet@low` as its alternatives. Step 22 changed one function in `placement.ts`. Its tests run over the house file's own profiles, and the route e2e now boots a second gateway over an idle fake searle. It landed green on the first run, inside its seam.

  1. With nothing resident, `auto` chat now cold-loads the 35B where it used to decide Claude
  2. A busy resident model now degrades to a cold load ranked next, not to Claude
  3. A decision ranked between a cold load and a ready local model ends up behind both
  4. The route e2e boots a second gateway over an idle searle, because the probe runs every 10 s

  **Readout**:

  ```text
  steps        1 of 1 landed
               - 22 d7c86b9
  check        green: 9 of 9 checks, 1 landing
  done-when    met
  decisions    honored:
               - D48 (avoid-yields-to-local)
               - D44 (memory-fit-cold-load), D46 (ollama-picks-the-evictee)
  constraints  17 of 17 honored
  seam         held: 1 of 1 steps, no strays
  diff         +167 -22 across 3 files
               - packages/penfield/src/place/__tests__/placement.test.ts +102 -1
               - packages/penfield/src/place/placement.ts +9 -4
               - packages/penfield/test/e2e/route.test.ts +56 -17
  spent        5 min · green first run at every landing
  ```

  **Verdict**: ● Plumb

  **Recommendation**: Run the stop live from the laptop. Restart your gateway on this commit, make sure `/api/ps` on searle is empty, ask `/route`, then load the 35B, wait one probe (10 s) and ask again. The first ask should name `searle/qwen3.6:35b-mlx` with `placement.cold_load: true` and sonnet among its alternatives. The second should name the same model, resident. If the pinned 27B is loaded, the first ask takes the 27B instead, so unload it first. Then decide whether section 2's busy fallback is the trade you want before range 6 sends real traffic. If it is not, it needs a new decision, not a change to this step. With `$H` and `$T` as in the playbook:

  ```sh
  curl -s http://192.168.1.90:11434/api/ps | jq '.models[].name'
  curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' $H/route -d '{"model":"auto","messages":[{"role":"user","content":"what is the capital of France?"}]}' | jq '{target, alternatives, placement}'
  curl -s http://192.168.1.90:11434/api/generate -d '{"model":"qwen3.6:35b-mlx","keep_alive":"30m"}'
  ```

  **1.** With nothing resident, `auto` chat now cold-loads the 35B where it used to decide Claude

  The old pool under `avoid` put every ready candidate ahead of every cold load, and it counted a Claude decision as ready. The new pool finds the first cold load in rank order. Everything ranked above it stays where it is. From there down, the ready local models go first, in rank order, then the cold loads and the decisions, in rank order. Over the house file that gives: idle chat takes the 35B cold; chat with the 35B resident takes it; code-light with the 35B resident takes it over the cold 27B ranked above it; summarize with only the pinned 27B resident takes the 27B; code-heavy still decides `claude/opus@high` first. A cold load that D44 or D46 refuses drops out of the pool as before, and the next in rank takes the request: the cold 27B when only the 35B is too big, `claude/sonnet@low` when neither fits, and sonnet again when the pinned 27B is busy and the 35B cannot load beside it. `allow` and `never` build the same pool as before. The resident case in the route e2e now lists its alternatives in rank order, 27B before sonnet.

  **2.** A busy resident model now degrades to a cold load ranked next, not to Claude

  This follows from D48 but the done-when does not name it. Take rob's chat with the 35B resident and both of its slots held. Before, `degrade` fell through to `claude/sonnet@low`, since the decision ranked ahead of the cold 27B. Now the cold 27B comes first. With the 27B not loaded, D44 lets it in beside the leased 35B (20 GB beside 25 in 48, two of `max_loaded` 2), so a third concurrent chat cold-loads the slow 27B. That costs a first token under `stall_ms.first_token_cold` (90 s) instead of a Claude answer. For `zed-native` it means a cold-load wait instead of a hint message. `wait` callers such as night-shift are unchanged: they wait for the first candidate.

  **3.** A decision ranked between a cold load and a ready local model ends up behind both

  D48 holds two rules: a cold load gives way to a ready local model ranked below it, and a decision never jumps a cold load ranked above it. With the order cold A, decision D, ready B, the only order that keeps both is B, A, D. So the ready model goes first, and the decision drops behind B even though the profile ranked it above B. No house profile has this shape today. One test pins it, with summarize rewritten as gemma cold, then sonnet, then the resident 35B: the 35B is chosen, then gemma, then sonnet.

  **4.** The route e2e boots a second gateway over an idle searle, because the probe runs every 10 s

  The house file probes searle every 10 s on a real clock. Changing the fake's residency mid-run would need a 10 s wait. Instead, the e2e's boot and shutdown became two helpers, and a second describe block boots its own gateway over a fake with nothing resident. It decides the 35B cold load and checks that the fake still has nothing loaded, since a dry decision loads nothing. The first gateway's tests are unchanged apart from the alternatives' order.

- 2026-11-01 — step 13 checkpointed · 6e5e7266e — feat(wire): the streaming proxy with stall, deadline and abort (spec step 14) (1 drift, 511m)

  **Summary**: `proxy()` now forwards a claimed decision to its node and pipes the answer back as the client reads it. Only `model` is rewritten in the body, and no inbound `Authorization` or `x-penfield-*` header goes upstream. Every forward ends through one `finish`, which releases the lease once and writes `outcome`, `first_byte_ms`, `total_ms`, `bytes_out`, `upstream_status` and `upstream_prompt_tokens` on the decision's row. A client leaving, a stall or the deadline cuts the forward short, and only a stall before the first byte is retried, once, on the next candidate on a node. The reaper now waits 30 s past `deadline_at` (D47). Sixteen integration tests against the fake Ollama prove each path, and after every test they check that each lease was released exactly once. Nothing calls the proxy yet; step 14 wires it to the endpoints.

  1. The pipe holds memory flat: 2 MB of growth over a 61 MB stream, and 56 MB when a test version keeps the chunks
  2. Every path ends through one `finish`, and the tests count releases per lease
  3. The retry is a decision of its own, and a cold candidate gets the longer first-byte window
  4. Four readings the done-when left open
  5. Outside the seam: two error kinds and three barrel lines

  **Readout**:

  ```text
  check        green: 9 of 9 checks
  done-when    met
  decisions    honored:
               - D2 (proxy-not-translate), D4 (no-engine-hot-path)
               - D9 (decision-carries-alternatives), D13 (leases), D15 (busy-policy)
               - D16 (hung-work-recovered), D34 (timers-injectable), D47 (reaper-grace)
  constraints  17 of 17 honored
  seam         strayed: 3 paths outside the seam
               - packages/penfield/src/log/index.ts
               - packages/penfield/src/place/index.ts
               - packages/penfield/src/wire/errors.ts
  diff         +1317 -22 across 13 files
               - packages/penfield/src/log/decisions.ts +24 -1
               - packages/penfield/src/log/index.ts +2 -2
               - packages/penfield/src/place/__tests__/leases.test.ts +24 -7
               - packages/penfield/src/place/index.ts +1 -1
               - packages/penfield/src/place/leases.ts +7 -0
               - packages/penfield/src/place/reaper.ts +11 -6
               - packages/penfield/src/wire/__tests__/sse.test.ts +71 -0
               - and 6 more
  spent        8h 31m · 1 turn · 5s gate · green first run
  ```

  **Verdict**: ◐ A hair off (seam strayed)

  **Recommendation**: Approve the piping, the abort paths and the single release as built, after reading the two calls of mine in sections 3 and 4. Each is a line or two to change: the cold first-byte window taking the larger of the two values, and no incident for a deadline or a client leaving. The flat-heap result with its failing check, plus the release counter on every test, are the evidence this pause asked for. P22 (stalls into the breaker) is the park I would schedule soonest: without it, a node that stalls every request stays placeable until the prober notices.

  **1.** The pipe holds memory flat: 2 MB of growth over a 61 MB stream, and 56 MB when a test version keeps the chunks

  The node's body goes to Fastify as a `Readable.from` over an async generator, and Fastify pipes it, so a chunk is read from the node only when the client has taken the one before. The stall window runs only while the proxy waits on the node, from each read to the chunk that answers it, so a client that is slow to read never counts as the node stalling. In the 50 k-chunk test, about 1 KB per chunk, the client had its first chunk when the fake had sent about 1,400 of the 50,000. Measured after two full collections, the heap plus the buffers it points to grew about 2 MB at every 10 MB sample. One collection alone overstated it at 14 to 20 MB, because V8 frees a dead buffer's memory only on the next collection. As a check, I patched the proxy to keep every chunk: the test then read 56 MB and failed, so the 32 MB bound would catch a proxy that buffers. The fake Ollama now waits for its socket to drain before it writes again, so it never buffers a stream either.

  **2.** Every path ends through one `finish`, and the tests count releases per lease

  Each forward to a node is a leg with its own `AbortController`, deadline timer and a guarded `finish`, which releases the lease, writes a `stall` incident for a stall, and writes the outcome. A client that leaves is seen on `reply.raw`'s `close` before the response has finished. In one measured run, the fake saw its upstream socket close 10 ms after the client aborted mid-stream, and 2 ms after it aborted before the first byte, against the test's bound of 100 ms. Three things hold the release to once. The generator's `finally` calls `finish`, the body stream's `close` covers a client that left before the generator started, and the deadline timer calls `finish` itself, so a client that stops reading cannot hold the lease past `deadline_at`. The tests wrap `release` with a counter, and after every test they require that no lease is active and that each was released exactly once. Reading the code back turned up one leak, now fixed: a retry that won a slot just as the client left would have hung up while still holding that slot's lease. It now hands the lease to the leg, which releases it as `client_gone`.

  **3.** The retry is a decision of its own, and a cold candidate gets the longer first-byte window

  On a stall before the first byte, the proxy takes the first alternative that is on a node, skipping the `claude/*` decisions, and makes it a new decision. That decision has a new id, the same request id, `degraded_from` naming the stalled model, and a closing reason line naming the stall. It is claimed through the busy policy the way the first was, and it is logged whether or not it gets a slot. The first row keeps its own `stalled` outcome, so the log stays append-only, and the client's `x-penfield-decision` names the retry. When there is no alternative on a node, or the retry is refused because the next model is busy or the client left while it waited, the answer is a 504 naming why. A stall on the retry is a 504 too, and there is no third attempt. One reading of mine: before the first byte of a cold load, the window is the larger of `first_token_cold` and the profile's `stall_ms`, because otherwise a cold load under code-heavy (120 s) would get less time than a warm one.

  **4.** Four readings the done-when left open

  The first byte is the node's first body byte, and the client gets no headers until it arrives. A node that answers headers but no body is therefore the same stall as one that answers nothing, and a retry can still set the headers. A deadline or a client leaving writes no incident: the row's outcome records it, and incidents stay for trouble with a node, as the done-when asks for the deadline. `bytes_out` counts the node's bytes as they were handed to the client, not penfield's own error event, so it means the same on every path. An event stream cut short after bytes ends on an OpenAI error event carrying both ids, and a JSON body cut short is broken off instead, so no client takes half a body for the whole.

  **5.** Outside the seam: two error kinds and three barrel lines

  `wire/errors.ts` gained `bad_gateway` (502) and `gateway_timeout` (504) and exports `error_body`, so the error event inside a stream uses the same envelope as every other error. `log/index.ts` exports `log_outcome`, and `place/index.ts` exports the `Lease` and `Outcome` types the proxy names. Building also turned up four tangents, now P22 to P25: stalls are not yet counted into the node's breaker (spec §6), no node key is sent to an OpenAI-compatible node, usage is read only from event streams, and re-serializing the body can respell a number.
