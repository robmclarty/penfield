# Penfield: specification and build plan

**Name:** penfield, after the Penfield mood organ in *Do Androids Dream of Electric Sheep?*: dial a setting, get the state you need. Binary `penfield`, config `penfield.yaml`, headers `x-penfield-*`.
**Date:** 2026-10-29. **Status:** decided, ready for `/plumbbob:plan`.
**Companions:** [`gateway-and-router-options.md`](./gateway-and-router-options.md) (why this and not something off the shelf) and [`playbook.md`](./playbook.md) (install, configure, operate).

Written in plumbbob's shape: a frame, decisions with their because, constraints, seams, and steps with a done-when. Stage A is the first plan; later stages are sized but not stepped in detail.

---

## 1. Frame

**Problem.** Every tool in the house that wants a model (Zed, fascicle flows, volley, night-shift, runciter, shinbun, nurselog, lodestar, future agents) carries its own idea of which model lives where. Nothing knows what is resident on searle right now, nothing shares a policy about privacy, speed, quality and cost, and nothing decides when a prompt is beyond the local models and should go to Claude. Rob makes that decision by hand on every prompt, or not at all.

**Smallest thing that solves it.** One small service on plato with a settings file. It keeps a catalogue of nodes and models, probes them, and answers requests in the OpenAI and Anthropic wire formats. A request that names a real model is forwarded to the node that has it. A request that names `auto` (or a profile alias) is routed by a cheap ladder to a profile, placed on a resident, healthy, free model, and forwarded unchanged. When the answer is "this needs Claude", the gateway says so and the requester's own client runs Claude under the requester's own login. Every decision is logged.

**Done looks like** (Stage A). From this laptop, with `penfield.yaml` naming searle and claude, `curl` to `/v1/chat/completions` with `model: auto` streams an answer from the right model on searle; the same with `model: qwen3.8:27b-mlx` forwards verbatim; `/v1/embeddings` with `auto` lands on an embedding model; `/v1/models` lists `auto`, the aliases and the catalogue; Zed's native agent uses the gateway as an `openai_compatible` provider and switches models in its picker; a busy or down searle degrades to the next candidate or fails fast with a clear error; the decision log shows every request with its rung, target and timings; Uptime Kuma sees `/healthz`; `pnpm check` is green.

**Explicitly not doing.** Translating between wire formats. Holding or forwarding any Claude subscription credential. Running a model on plato. A general-purpose queue (Stage D). Voice (Stage E). Team features (SSO, spend dashboards, multi-tenant admin). Replacing Ollama's own per-model parallelism. Any LLM call in the placement step.

## 2. Architecture

```text
clients                         plato: penfield                            nodes
───────                         ────────────────────────────────         ─────
Zed native agent  ─OpenAI─┐     ┌──────────┐  ┌─────────┐  ┌─────────┐   searle (Ollama, MLX)
penfield ACP agent ─/route─┤     │  wire    │→ │ router  │→ │ place   │→  compute box (CPU models, later)
fascicle flows    ─OpenAI─┼────▶│ auth,    │  │ ladder  │  │ leases, │   openrouter (cloud, policy-gated)
n8n, curl, agents ─Anthr.─┤     │ proxy,   │  │ rungs   │  │ pins,   │   anthropic API key (optional, off)
                          │     │ SSE pipe │  │         │  │ breaker │   claude_decision (never executed here)
                          │     └────┬─────┘  └────┬────┘  └────┬────┘
                          │          │             │            │
                          │     ┌────▼─────────────▼────────────▼────┐
                          │     │ catalogue ◀─ prober ◀─ nodes' /api │
                          │     │ decision log (SQLite) · leases      │
                          └────▶│ UI page · /healthz · /catalogue     │
                                └─────────────────────────────────────┘
```

Request path for `auto`: **wire** authenticates the caller and parses just enough of the body (endpoint, model, message text, tools, attachments, rough token count, hints) → **router** runs the ladder and names a profile with a confidence → **placement** ranks the profile's candidates against the catalogue and the lease table and picks one (or returns a `claude_decision`, or degrades) → **wire** rewrites `model`, forwards the original body to the node's matching endpoint in the format it arrived in, pipes the stream back, and releases the lease at the last byte → **log** records the decision and the outcome.

## 3. Decisions

Each is settled. Re-litigate in a spike, not in the chat.

### Shape

- D1. **One service, one settings file, no hard-coded universe.** Every node, model, profile, policy and caller comes from `penfield.yaml`; the same binary runs at home and at work. *Because* portability was the first requirement, and a tool is the thing that survives.
- D2. **Proxy, don't translate.** Requests are forwarded in the format they arrived in to a node that speaks that format; the gateway rewrites `model` and nothing else. A node that lacks the incoming format is not a candidate for that request. *Because* Ollama, llama.cpp, LM Studio and oMLX all speak both OpenAI and Anthropic natively, and translation is where gateways grow fat.
- D3. **TypeScript on Node 24, Fastify, fascicle, zod, SQLite.** Functional style, plain values, no classes. checkride is the gate, trailhead the scaffold, plumbbob the loop. *Because* that is the stack every other tool in the folder shares, and fascicle already has the engine, `serve_acp`, `claude_cli`, pricing and trajectories.
- D4. **Hot path has no fascicle engine in it.** fascicle is used for the classifier rung, the optional API-key leg, and the ACP agent; proxying is raw `fetch` and stream piping. *Because* the engine's job is model turns, and a proxy's job is bytes.
- D5. **Runs on plato.** Container or systemd, config in a git repo, state in one SQLite file under `/var/lib/penfield`. *Because* plato is the control plane, has idle cycles, is on the UPS, and auditing AI use is its mission.

### Routing

- D6. **Explicit beats everything.** A concrete model id is forwarded to the node that has it, no ladder, no classifier, with placement only choosing among nodes that have that exact model. *Because* override must be absolute.
- D7. **The ladder is cheapest rung first, and stops at the first rung that answers with confidence above the threshold.** Rungs: `explicit` → `alias` → `shape` → `rule` → `embedding` → `classifier` → `default`. Stage A ships the first four and `default`. *Because* most traffic is decidable from the request shape at zero cost, and the model-backed rungs are the expensive ones.
- D8. **Profiles are the unit of routing; models are the unit of placement.** The ladder names a profile (`embed`, `classify`, `extract`, `summarize`, `chat`, `code-light`, `code-heavy`, `reason`, later `stt`, `tts`); each profile lists ranked candidate models in config. *Because* a profile is stable across machines and models are not.
- D9. **A decision carries ranked alternatives, its rung, its reasons and a confidence**, and is returned to `/route` callers whole. *Because* "choice one is busy, use choice two" is then a filter, and the log becomes the eval set.
- D10. **Policy precedence is privacy, then quality above the confidence threshold, then speed, then cost.** Privacy classes: `local`, `lan`, `cloud`. A caller's policy sets the highest class allowed; the default is `local` and `lan` only. *Because* Rob said so, and cost only exists on the cloud leg.
- D11. **The classifier (Stage C) answers only two questions for free-form chat: local or Claude, and which Claude tier.** It runs on a node as any other model, through a fixed JSON schema, via fascicle `define_agent`. *Because* everything else is decidable without it, and a model in the routing path is a latency and a dependency.

### Placement

- D12. **Placement reads live state, never only config: resident models, health, breaker state, free slots, pins.** It takes the first candidate that is resident, healthy and has a free slot; otherwise the first that is healthy and loadable if the policy allows a cold load; otherwise the busy policy applies. *Because* on a 48 GB Mac, available means resident.
- D13. **Leases.** Every forwarded request holds a lease on `(node, model)` from the moment it is dispatched to the last byte or the disconnect. Slot counts per model come from config, with a node default. *Because* Ollama queues blindly and cannot see memory thrash coming.
- D14. **Pinning.** A model marked `pinned` on a node is never evicted by a load the gateway triggers; placement routes elsewhere, degrades, or waits. *Because* one person's 27B must not unload the 35B someone else is mid-stream on.
- D15. **Busy policy per caller and profile: `degrade` (default for interactive) or `wait` with a deadline (default for batch).** Stage A implements `degrade` and a bounded `wait` (one in-memory FIFO per `(node, model)`, no fairness). The real queue is Stage D. *Because* the seam is the lease table, and it has to exist before a queue can plug into it.
- D16. **Hung and orphaned work is detected and recovered, in escalating steps.** See §6. *Because* a lease that is never released is a slot that is never free.

### The Claude leg

- D17. **The gateway never holds, sees, or forwards a Claude subscription credential.** A `claude_decision` target is a decision, not an execution; the requester's client runs `claude` under its own login. *Because* Anthropic's terms forbid intermediating subscription credentials and permit the unmodified binary under one's own login.
- D18. **An optional `anthropic_api` target with an API key executes server-side, per-caller budgeted, off by default.** *Because* unattended agents on the LAN need a permitted path.
- D19. **A proxy endpoint that resolves to `claude_decision` cannot execute it, so the caller's policy says what happens: `hint` (a short assistant message naming the model and effort), `downgrade` (best local candidate, with a `x-penfield-downgraded` header), or `api_key`.** Default `hint`. *Because* Zed's native agent and curl cannot act on a decision, and silently answering locally would hide the routing.
- D20. **The penfield ACP agent delegates its Claude branch to `claude-agent-acp` as an ACP client, forwarding the session.** *Because* that is exactly what Zed's Claude thread has today, permissions and resume included, and nothing is gained by reimplementing it.

### Identity and audit

- D21. **Every request carries a caller** (bearer token → caller name, policy, priority). No anonymous requests, LAN bind only. *Because* multiplayer, budgets and fairness all hang off identity, and Ollama has no auth of its own.
- D22. **Log decisions, not prompts, by default.** Per-caller `keep_prompts: true` stores prompt text for the eval set. Transcripts of model output are never stored. *Because* that is nurselog's doctrine and plato's audit role wants decisions.
- D23. **The decision log is written in the gateway's own neutral schema, never a node's.** *Because* the log must outlive any node or vendor, and it is the regression suite (the Sophia pattern).

### Operations

- D24. **Node registration is one YAML entry; models are discovered.** Ollama via `/api/tags` and `/api/ps`; OpenAI-compatible via `/v1/models`; hand-listed when a node can't be asked. Metadata (profiles, speed, quality, context) is overlaid by glob in config. *Because* adding a node must take a minute.
- D25. **Health is exposed where plato already looks**: `/healthz` for Uptime Kuma, a one-line metrics endpoint for Beszel or OpenTelemetry later, and the UI page. *Because* Grafana stays off the roadmap until Beszel and Kuma fail.

## 4. Constraints

The reviewer checks these.

- C1. No wire-format translation in Stages A and B. A mismatch is a refused candidate, with the reason in the decision.
- C2. No subscription credential (OAuth token, `CLAUDE_CODE_OAUTH_TOKEN`, session files) is read, stored, forwarded or logged, anywhere in this codebase. A structural rule (ast-grep) forbids the env names; a test asserts the proxy strips `Authorization`-class headers it did not set.
- C3. No model call in the placement step, ever. The classifier rung is the only model call in the routing path, it runs only for free-form chat, and it is skipped when its node is down.
- C4. Streaming end to end: request bodies are read once (to parse the routing fields) and forwarded; response bodies are piped, never buffered whole. Memory stays flat under a 100 k-token response.
- C5. Bind to the LAN interface only; every endpoint except `/healthz` requires a caller token; tokens come from env or a file outside the repo, never from `penfield.yaml`.
- C6. Functional and procedural TypeScript: no `class`, `this`, `extends`, decorators or ambient singletons. Config is parsed once with zod and passed down.
- C7. `pnpm check` (checkride) is the definition of done: types, oxlint, ast-grep rules, dead code, tests with coverage, docs, spelling. No `any`, no `@ts-ignore`, no disabled rules.
- C8. One SQLite file for log and leases. No Postgres, no Redis, no daemon other than `penfield` itself.
- C9. Footprint under 250 MB resident on plato with the UI open and ten concurrent streams.
- C10. Every request and decision has an id that appears in logs, headers (`x-penfield-request`, `x-penfield-decision`) and the UI, so a complaint can be traced in one lookup.
- C11. Fail closed on policy: an unknown caller, a cloud target for a local-only caller, or a model a caller may not use is a 403 with a reason, never a silent downgrade.

## 5. Interfaces

### 5.1 `penfield.yaml`

```yaml
version: 1
server:
  listen: 192.168.1.89:7777        # LAN interface only (C5)
  name: penfield
  state_dir: /var/lib/penfield        # penfield.db lives here
  tokens_file: /etc/penfield/tokens   # caller: token, one per line

nodes:
  searle:
    kind: ollama                   # ollama | openai_compatible | anthropic_api | claude_decision
    url: http://192.168.1.90:11434
    privacy: lan                   # local | lan | cloud
    formats: [openai, anthropic]   # what it accepts on the wire; discovered defaults per kind
    discover: true                 # /api/tags + /api/ps every probe tick
    memory_gb: 48
    slots: { default: 2, "qwen3.8:27b-mlx": 1 }
    pinned: [qwen3.8:27b-mlx]
    probe: { every_ms: 10000, timeout_ms: 3000, ready_prompt: true }
    recover:                       # §6, all off unless listed
      unload_on_hang: true
      command: null                # e.g. "ssh searle 'brew services restart ollama'" (Stage D, approval-gated)
  openrouter:
    kind: openai_compatible
    url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    privacy: cloud
    discover: false
    models: [openrouter/auto, anthropic/claude-sonnet-5.5]
  claude:
    kind: claude_decision
    privacy: cloud
    models: [haiku, sonnet, opus]
    efforts: [low, medium, high, xhigh, max]
  anthropic:
    kind: anthropic_api
    enabled: false
    api_key_env: ANTHROPIC_API_KEY
    privacy: cloud

models:                            # metadata overlay by glob, first match wins
  "qwen3.8:27b*":   { profiles: [code-light, reason, chat, summarize], speed: slow,   quality: high,   context: 65536 }
  "qwen3.6:35b*":   { profiles: [code-light, chat, summarize, extract], speed: fast,  quality: medium, context: 65536 }
  "gemma4:26b*":    { profiles: [chat, summarize, classify],            speed: fast,  quality: medium }
  "qwen3:4b-instruct*": { profiles: [classify, extract, route],         speed: fastest, quality: low }
  "nomic-embed-text*":  { profiles: [embed] }
  "qwen3-embedding*":   { profiles: [embed] }
  "claude/opus":    { profiles: [code-heavy, reason], quality: frontier, cost: high }
  "claude/sonnet":  { profiles: [code-heavy, code-light, chat], quality: frontier, cost: medium }
  "claude/haiku":   { profiles: [chat, summarize, classify], quality: high, cost: low }

profiles:                          # ranked candidates; "node/model@effort" or "model" (any node that has it)
  embed:      { candidates: [nomic-embed-text, qwen3-embedding:0.6b] }
  classify:   { candidates: [qwen3:4b-instruct-2507, gemma4:e4b] }
  extract:    { candidates: [qwen3.6:35b-mlx, qwen3:4b-instruct-2507] }
  summarize:  { candidates: [qwen3.6:35b-mlx, gemma4:26b, qwen3.8:27b-mlx] }
  chat:       { candidates: [qwen3.6:35b-mlx, qwen3.8:27b-mlx, claude/sonnet@low] }
  code-light: { candidates: [qwen3.8:27b-mlx, qwen3.6:35b-mlx, claude/sonnet@medium] }
  code-heavy: { candidates: [claude/opus@high, claude/sonnet@high, qwen3.8:27b-mlx] }
  reason:     { candidates: [claude/opus@xhigh, qwen3.8:27b-mlx] }

aliases:
  auto:         { ladder: default }
  auto/fast:    { ladder: default, prefer: speed }
  auto/private: { ladder: default, max_privacy: lan }
  auto/best:    { ladder: default, prefer: quality }
  # a profile name is also an alias: model "summarize" routes to that profile

policy:
  precedence: [privacy, quality, speed, cost]
  confidence_threshold: 0.7
  cold_load: avoid                 # allow | avoid | never
  busy: { default: degrade, wait_ms: 5000 }
  on_claude_for_proxy: hint        # hint | downgrade | api_key
  stall_ms: { default: 30000, first_token_cold: 90000, code-light: 60000, code-heavy: 120000 }
  deadline_ms: { default: 600000 }

router:
  rules:                           # evaluated in order; first match wins
    - { when: { endpoint: embeddings }, profile: embed }
    - { when: { endpoint: audio_transcriptions }, profile: stt }
    - { when: { hint: present }, profile: $hint }          # x-penfield-profile header or metadata.penfield.profile
    - { when: { tools: true, tokens_gt: 12000 }, profile: code-heavy }
    - { when: { tools: true }, profile: code-light }
    - { when: { attachments: code, tokens_gt: 4000 }, profile: code-light }
    - { when: { tokens_gt: 24000 }, profile: summarize }
    - { when: { system_matches: "(?i)classif|categori|label" }, profile: classify }
    - { when: { chat: true }, profile: chat }              # falls to embedding/classifier rungs when below threshold
  exemplars: ./profiles            # Stage C: one markdown file per profile with example prompts
  embedder: nomic-embed-text       # Stage C
  classifier: qwen3:4b-instruct-2507   # Stage C

callers:
  rob:          { max_privacy: cloud, claude: decision, priority: interactive, keep_prompts: true }
  zed-native:   { max_privacy: cloud, claude: hint, priority: interactive }
  night-shift:  { max_privacy: lan, priority: batch, busy: wait, wait_ms: 120000 }
  nurselog:     { max_privacy: lan, priority: interactive, models: [qwen3.8:27b-mlx, nomic-embed-text] }
```

Validation: zod, at load; an unknown key, an alias to a missing profile, a candidate no node could ever have, or a pinned model not in any node's list is a boot failure with a line number.

### 5.2 Request parsing (`RouteInput`)

What the wire layer extracts before routing; nothing else is read from the body.

```ts
type RouteInput = {
  request_id: string
  caller: Caller
  format: 'openai' | 'anthropic'
  endpoint: 'chat' | 'embeddings' | 'messages' | 'audio_transcriptions' | 'audio_speech'
  model: string                      // as sent: concrete id, alias, or profile name
  text: string                       // last user message text, truncated to 4 k chars
  system_text: string                // first 1 k chars of system prompt, if any
  history_turns: number
  tokens_estimate: number            // chars / 4 over all messages
  tools: boolean
  attachments: 'none' | 'code' | 'docs' | 'images'
  hints: { profile?: string, max_privacy?: Privacy, prefer?: 'speed' | 'quality', effort?: Effort }
         // from x-penfield-* headers, or metadata.penfield (OpenAI) / metadata.penfield (Anthropic)
}
```

### 5.3 `Decision`

```ts
type Target =
  | { kind: 'proxy', node: string, model: string, format: 'openai' | 'anthropic' }
  | { kind: 'claude_decision', model: 'haiku' | 'sonnet' | 'opus', effort: Effort }
  | { kind: 'refused', reason: string }

type Decision = {
  id: string
  request_id: string
  at: string                          // ISO
  caller: string
  profile: string
  rung: 'explicit' | 'alias' | 'shape' | 'rule' | 'embedding' | 'classifier' | 'default'
  confidence: number                  // 1.0 for explicit/alias/shape/rule
  reasons: string[]                   // human-readable, one per rung and placement step
  target: Target
  alternatives: Target[]              // ranked, excluding target
  placement: { resident: boolean, cold_load: boolean, waited_ms: number, degraded_from?: string }
  policy: { max_privacy: Privacy, prefer?: string, busy: 'degrade' | 'wait' }
}
```

### 5.4 Endpoints

| Method and path | Formats | Behaviour |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | Route (if alias) or place (if explicit), forward to node's `/v1/chat/completions`, pipe stream. `claude_decision` → caller's `on_claude_for_proxy`. |
| `POST /v1/embeddings` | OpenAI | Same, profile `embed`. |
| `GET /v1/models` | OpenAI | Aliases, profiles, then catalogue models visible to the caller; `owned_by` = node; extra `penfield` object with residency and profiles. |
| `POST /v1/messages` | Anthropic | Stage B. Same as chat; forwarded to node's `/v1/messages`. |
| `POST /route` | penfield | Stage B. Body is an OpenAI or Anthropic request, or `{ text, tools, tokens_estimate, hints }`. Returns the `Decision`, executes nothing, holds no lease. |
| `GET /catalogue` | penfield | Nodes, models, residency, pins, breaker state, slots in use. |
| `GET /decisions?caller=&since=&limit=` | penfield | Decision log, newest first. |
| `GET /leases` | penfield | Live leases with age, last byte, state. |
| `POST /admin/leases/:id/release`, `POST /admin/nodes/:n/breaker/reset`, `POST /admin/nodes/:n/unload/:model`, `POST /admin/pins` | penfield, admin token | Stage B. Manual recovery and pinning. |
| `GET /healthz` | — | `200` when the server is up; body lists node states. Unauthenticated, for Kuma. |
| `GET /metrics` | — | Stage D. One line per node and profile. |
| `GET /` | — | The UI page. |

Headers on every proxied response: `x-penfield-request`, `x-penfield-decision`, `x-penfield-target` (`node/model`), `x-penfield-rung`, and `x-penfield-downgraded` when applicable. Errors are JSON in the incoming format's error shape with the decision id.

### 5.5 Decision log and lease tables (SQLite)

```sql
create table decisions (
  id text primary key, request_id text, at text, caller text, profile text, rung text,
  confidence real, target_kind text, target_node text, target_model text, effort text,
  alternatives text,            -- JSON
  reasons text,                 -- JSON
  resident int, cold_load int, waited_ms int, degraded_from text,
  outcome text,                 -- ok | stalled | deadline | client_gone | upstream_error | refused | hinted
  first_byte_ms int, total_ms int, bytes_out int, upstream_status int,
  prompt text                   -- null unless caller.keep_prompts
);
create table leases (
  id text primary key, request_id text, decision_id text, caller text, node text, model text,
  instance text,                -- gateway instance id (boot uuid); leases from other instances are orphans
  started_at text, last_byte_at text, deadline_at text, state text   -- active | released | stalled | orphaned
);
create table incidents (
  id text primary key, at text, node text, model text, kind text,   -- stall | deadline | probe_fail | breaker_open | recovered
  detail text
);
```

### 5.6 The penfield ACP agent (Stage B)

A separate package in the same workspace (`agent/`), run by Zed or any ACP client as a stdio subprocess on the client machine.

- Built on `serve_acp` from `fascicle/acp`. Config options returned on `session/new` and after every `session/set_config_option`: `model` (category `model`: `auto`, the aliases, then the catalogue from `/v1/models`, refreshed per session), `effort` (category `thought_level`: `auto`, `low` … `max`), and `mode` (fascicle's manual, accept edits, auto).
- Each turn: `POST /route` with the turn's text, history length, attachment kinds, the selected model and effort as hints, and the caller token from env.
- Local target: a fascicle flow with `workspace_tools`, calling the gateway's `/v1/chat/completions` with the decided concrete model (so the lease and log happen on the gateway), streaming into the thread; the decision's reasons appear once as a small status line.
- `claude_decision` target: the agent opens, or reuses, a child ACP session to `npx @agentclientprotocol/claude-agent-acp` in the same `cwd`, sets its `model` and `effort` config options from the decision, forwards the prompt, and relays every `session/update`, `session/request_permission` and cancel between client and child verbatim. The child runs under the user's own `claude` login; the penfield agent passes no credential and reads none.
- `refused` target: a one-line reply with the reason.
- Explicit `model` other than `auto`: skips `/route` except for placement, so the picker is an absolute override.

## 6. Hung and orphaned work

What can go wrong, how it is noticed, and what is done. Every step writes an `incidents` row and shows in the UI.

| Condition | Detected by | Action |
|---|---|---|
| **Client went away** mid-stream | Fastify request `close` before the response ended | Abort the upstream fetch via its `AbortController`; release the lease; outcome `client_gone`. |
| **Upstream stalls** (no bytes for `stall_ms` of the profile; `first_token_cold` applies when the placement was a cold load) | A per-lease timer reset on every chunk | Abort upstream; release; if nothing was streamed yet and an alternative exists, retry once on the next candidate with `degraded_from` set; else error with the decision id. Node gets a `stall` incident; three stalls in five minutes open the breaker. |
| **Deadline** (`deadline_ms` of the profile) | Timer from dispatch | Abort; release; outcome `deadline`. Never retried. |
| **Orphaned lease** (gateway crashed or restarted mid-stream) | On boot, every `active` lease whose `instance` is not this boot's id; and a reaper every probe tick for `active` leases past `deadline_at` | Mark `orphaned`, release the slot, incident. The upstream request died with the process; nothing to abort. |
| **Node unresponsive** (probe timeout, connection refused) | Prober: `GET /api/version` liveness every tick; `POST /api/generate` with an empty prompt and `keep_alive` unchanged as a readiness ping when `ready_prompt: true`, on a longer interval or when the node is suspect | After N consecutive failures (config, default 3) the breaker opens: placement skips the node, active leases get a shortened deadline, incident `breaker_open`. Half-open probe every 30 s; one success closes it. |
| **Model resident but wedged** (readiness ping times out while `/api/ps` still lists it; or two consecutive stalls on the same model with other models fine) | Prober and the stall counter | `recover.unload_on_hang`: `POST /api/generate {model, keep_alive: 0}` to evict it, then a readiness ping that reloads it; if the ping succeeds, incident `recovered`; if not, breaker opens for that model only (per-model breaker state). |
| **Node needs a restart** | Breaker open for the node longer than `recover.escalate_after_ms` | Stage D: run `recover.command` if configured, behind an approval button in the UI first and unattended only once it has worked by hand; until then, the UI shows the exact command to run. |
| **Slot accounting drift** (leases say busy, node says idle) | Reconciliation every tick: compare active leases per node with the node's reported state (`/api/ps` gives residency only, so drift is inferred from leases older than the profile's typical `total_ms` p95 with no bytes in `stall_ms`) | Treated as a stall, same path. |
| **Gateway itself hung** | Uptime Kuma on `/healthz` with a 10 s timeout | Alert; systemd `Restart=on-failure` plus a watchdog ping (`sd_notify`) in Stage B. |

Design rules: a lease is released in exactly one place (`release(lease_id, outcome)`), idempotent; every abort path goes through it; the reaper and the boot sweep use the same function; recovery actions are logged with what they did, and the UI can trigger each by hand.

## 7. Seams

```text
penfield/                    pnpm workspace (trailhead layout)
  packages/penfield/            the service
    src/config/              schema.ts (zod), load.ts, defaults.ts
    src/catalogue/           types.ts, discover_ollama.ts, discover_openai.ts, merge.ts, catalogue.ts
    src/probe/               prober.ts, breaker.ts, readiness.ts
    src/place/               leases.ts, placement.ts, reaper.ts, recover.ts
    src/route/               ladder.ts, input.ts, rungs/{explicit,alias,shape,rule,embedding,classifier,default}.ts
    src/wire/                server.ts, auth.ts, openai.ts, anthropic.ts, route_endpoint.ts, proxy.ts, sse.ts, errors.ts, admin.ts
    src/log/                 db.ts, decisions.ts, incidents.ts
    src/ui/                  page.ts (one HTML file, no build step), api.ts
    src/cli.ts               penfield serve | check-config | catalogue | replay | decisions
    test/                    unit beside sources; integration with a fake Ollama (test/fake_ollama.ts) and a fake OpenAI server
  packages/agent/            the penfield ACP agent (Stage B)
    src/main.ts, route_client.ts, local_branch.ts, claude_branch.ts (ACP client to claude-agent-acp), config_options.ts
  profiles/                  exemplar markdown per profile (Stage C)
  deploy/                    Dockerfile, compose.yaml, penfield.service, penfield.example.yaml, office.example.yaml
  docs/                      this spec, the playbook, decisions log
```

**Interfaces between seams** (the contracts the reviewer holds steady):

- `catalogue.snapshot(): Catalogue` — pure data: nodes, models, residency, breaker state, pins, slots. Nothing else reads nodes directly.
- `route(input: RouteInput, catalogue, policy): RoutedProfile` — pure; no I/O except the two model-backed rungs, which are injected as functions so tests run without a node.
- `place(profile, input, catalogue, leases, policy): Decision` — pure over the lease table's snapshot; the lease acquire is a separate call so `/route` never acquires.
- `proxy(decision, request, reply, lease)` — the only code that touches upstream sockets.
- `release(lease_id, outcome)` — the single release path (§6).
- `log.decision(d)`, `log.outcome(id, outcome, timings)`, `log.incident(i)` — append-only.

**Untouched:** fascicle itself in Stage A. The one fascicle change in Stage B is a `config_options` extension in `fascicle/acp` to let an agent add options beyond mode (a small PR to your own library), or a local override in the agent until then.

## 8. Steps

Each step is one plumbbob step: implement, check, self-review, checkpoint. Done-when is the finish line. Ranges mark where the build stops for Rob.

### Stage A — `auto` by rules, any client (first plan)

**Range 1: skeleton and config** (stop after step 4 for a look at the schema)

1. Scaffold the workspace from trailhead with `packages/penfield`, checkride wired, `pnpm check` green on an empty `src/`. **Done when:** `pnpm check` exits 0 and CI runs it.
2. `config/schema.ts` and `load.ts`: the zod schema for §5.1 with defaults; `penfield check-config` prints the merged config or the first error with its path. **Done when:** fixtures for a valid file, an alias to a missing profile, a pinned model no node lists, and an unknown key each produce the specified result in tests.
3. `log/db.ts`: open or create `penfield.db` with the three tables, WAL mode, an instance id per boot. **Done when:** a test opens a temp db twice and the second boot sees the first's rows.
4. `cli.ts` with `serve` (boot, bind, log a banner, `/healthz` 200) and `check-config`. **Done when:** `penfield serve --config fixture.yaml` answers `/healthz` and refuses to bind to `0.0.0.0` unless `--allow-any-interface` (C5).

**Range 2: catalogue and probe** (stop after step 8 against the real searle)

5. `catalogue/discover_ollama.ts`: `/api/tags` and `/api/ps` into `Model[]` with residency; `discover_openai.ts`: `/v1/models`. Fake servers in `test/`. **Done when:** a fake Ollama with three tags and one resident yields a snapshot with the right flags; a connection refusal yields an empty, `down` node, not a throw.
6. `catalogue/merge.ts`: overlay `models:` globs, node `models:` lists, pins and slots; expose `snapshot()`. **Done when:** glob precedence (first match wins) and per-node slot overrides are covered by tests.
7. `probe/prober.ts` and `breaker.ts`: liveness per tick, readiness ping per config, consecutive-failure breaker with half-open, per-node and per-model state, `incidents` rows. **Done when:** a fake node that fails three probes opens the breaker, one success in half-open closes it, and each transition is an incident.
8. `GET /catalogue` and `GET /v1/models` with aliases, profiles and models filtered by the caller's policy. **Done when:** run against the real searle, the output lists its tags with residency matching `ollama ps`.

**Range 3: route and place** (stop after step 12: the first `auto` decision, dry)

9. `route/input.ts`: `RouteInput` from an OpenAI chat body and an embeddings body (Anthropic in Stage B); token estimate; hints from headers and `metadata.penfield`. **Done when:** fixtures with tools, images, long histories and hints parse to the expected fields; a 2 MB body is parsed without copying message text beyond the 4 k cap.
10. Rungs `explicit`, `alias`, `shape`, `rule`, `default` and `ladder.ts` with the confidence threshold. **Done when:** a table-driven test maps twenty representative requests to the expected profile and rung; an explicit model skips the ladder entirely.
11. `place/leases.ts` (acquire, release, snapshot, reaper, boot sweep) and `placement.ts` (ranked candidates, resident-healthy-free first, cold-load policy, pins, degrade). **Done when:** tests cover: two slots then busy; busy with degrade to candidate two; busy with wait under the deadline; pinned model never chosen for eviction; a down node skipped; an orphan swept on boot; release idempotent.
12. `POST /route` (dry, no lease) returning a `Decision`, plus `decisions` rows. **Done when:** against searle, `auto` with a short question decides a chat candidate that is resident, and the log row matches the response.

**Range 4: the proxy** (stop after step 16: Zed is on it)

13. `wire/auth.ts` (tokens file → caller), `wire/errors.ts` (OpenAI error shape with decision id), request ids. **Done when:** no token is 401, an unknown token 401, a caller over its `max_privacy` 403 with reason (C11).
14. `wire/proxy.ts` and `sse.ts`: forward the original body with `model` rewritten to the node's same-format endpoint, pipe the response, release on end, abort on client close, stall and deadline timers from §6, outcome and timings to the log. **Done when:** with the fake Ollama, a 50 k-chunk stream passes with flat memory (C4); client disconnect aborts upstream within 100 ms; a stall triggers one retry on the next candidate when nothing was streamed and an error when something was.
15. `POST /v1/chat/completions` and `POST /v1/embeddings` wired end to end, including `on_claude_for_proxy` (`hint` and `downgrade`; `api_key` is Stage D). **Done when:** the Frame's curl checks pass against searle; a `code-heavy` request from the `zed-native` caller returns the hint message with `x-penfield-decision`.
16. Zed: the `openai_compatible` provider entry from the playbook, `PENFIELD_API_KEY`, models `auto`, `auto/fast`, `auto/private`, `auto/best`, and the local tags. **Done when:** a chat in Zed's native agent with `auto` streams from searle and the decision shows in `/decisions`; switching to a concrete model in the picker forwards verbatim.

**Range 5: operate** (stop at the end: the Stage A review)

17. `GET /decisions`, `GET /leases`, and the UI page v0: nodes with breaker state and residency, catalogue, last 100 decisions with rung and reasons, live leases with age and last byte. Plain HTML, fetches the JSON endpoints, no build step. **Done when:** the page renders from a cold browser against the running service and refreshes every five seconds.
18. `deploy/`: Dockerfile (Node 24 slim, non-root), `compose.yaml` binding the LAN address and mounting `/var/lib/penfield` and `/etc/penfield`, a `penfield.service` alternative, `penfield.example.yaml` (home) and `office.example.yaml`. **Done when:** the playbook's install steps work on plato from a clean checkout and `/healthz` is green in Uptime Kuma.
19. `penfield replay --since <date>`: re-runs the ladder (rungs that need no model) over logged decisions and reports changed outcomes, for safe rule edits. **Done when:** editing a rule in a fixture config produces a diff of affected decisions.
20. Docs: README, `docs/decisions.md` (this spec's D-list with any verdicts), and the playbook updated to what shipped. **Done when:** `pnpm check` passes with docs and links; the CHANGELOG has 0.1.0.

### Stage B — the Claude step and the ACP agent

Sized, not yet stepped: Anthropic `/v1/messages` passthrough with `RouteInput` from Anthropic bodies (2 steps); `/route` accepting Anthropic bodies and the bare `{text, …}` shape (1); the `fascicle/acp` config-options extension for `model` and `thought_level` (1, in fascicle); `packages/agent`: `serve_acp` skeleton with options (1), local branch via gateway with workspace tools (2), ACP client to `claude-agent-acp` with session forwarding, permission relay and cancel (3), Zed registration and an end-to-end check of both branches (1); admin endpoints and UI buttons for release, breaker reset, unload, pin (2); systemd watchdog (1). About 14 steps, two ranges.

### Stage C — the model-backed rungs and the eval loop

Exemplar files per profile and the `embedding` rung via the catalogue's embedder, with a nearest-centroid threshold (3); the `classifier` rung as a fascicle `define_agent` markdown with a JSON schema returning `{profile, claude_tier, confidence}`, run on a node, skipped when the node is down (3); `keep_prompts` and `penfield replay` extended to re-run the model rungs over kept prompts and score agreement with the logged choice (2); a `volley matrix`-style comparison of candidate classifiers on the kept set (1). About 9 steps.

### Stage D — queue, budgets, recovery, API key

A real `wait` queue: persistent, FIFO within priority, fair across callers, admission per caller and profile, `/queue` in the UI (4); the `anthropic_api` leg through fascicle's native Anthropic adapter with per-caller daily budgets from pricing events (3); `recover.command` behind UI approval, then unattended after a configured number of successful manual runs (2); `/metrics` (1). About 10 steps.

### Stage E — more nodes and voice

Wyoming adapters for Parakeet and Kokoro presented as `/v1/audio/transcriptions` and `/v1/audio/speech` with `stt` and `tts` profiles; a `penfield-node` helper for nodes that cannot be discovered (a CPU box running llama-server or LocalAI); llama-swap on nodes; mDNS or DNS-SD registration; the office config as a tested example.

## 9. Open questions

Not guessed into decisions. Each names how it gets resolved.

- Q1. **Ollama's per-request context window.** The `/v1` endpoints cannot set `num_ctx`. Resolve by setting `OLLAMA_CONTEXT_LENGTH` on searle (64 k) and recording per-model context in the overlay; revisit if a caller needs more. *Resolve by:* decide at step 8.
- Q2. **Readiness ping cost on MLX.** An empty-prompt `/api/generate` loads the model if it isn't resident, which is itself an eviction risk. *Resolve by:* spike at step 7: ping only models already in `/api/ps`, never others.
- Q3. **Does `claude-agent-acp` accept `model` and `effort` via `session/set_config_option` on protocol v1, and does it honour `cwd` for CLAUDE.md and skills?** *Resolve by:* a 30-minute spike before Stage B's agent steps, driving it from runciter's ACP shim.
- Q4. **Token estimate quality.** Chars divided by four misjudges code and CJK. *Resolve by:* measure against Ollama's reported `prompt_eval_count` in the log during Stage A and tune the thresholds in Stage C.
- Q5. **Where `auto` sits for Zed's native agent when the decision is Claude**: `hint` interrupts the flow; `downgrade` hides it. *Resolve by:* use `hint` for two weeks, read the log, decide.
- Q6. **Name.** Resolved 2026-10-29: penfield.
