# A model gateway and router for the house: options and a recommendation

*Research note, 2026-10-29. Status: options for a decision; nothing here is decided. Builds on `orchestration-layer-research-2026-10-07.md` (in `learning-ai/multi-agent-orchestra/`, outside this repo), whose rule was "skip a gateway until several non-fascicle consumers share models." Zed, plumbbob, runciter, night-shift, nurselog, shinbun and lodestar now all want the same models on searle, so that trigger has fired.*

*Freshness: versions and claims checked 2026-10-29 against primary pages. Anything marked (est.) is an estimate, not a measurement.*

## Contents

1. [The short version](#1-the-short-version)
2. [What you asked for, as requirements](#2-what-you-asked-for-as-requirements)
3. [What you already have](#3-what-you-already-have)
4. [Four facts that shape the answer](#4-four-facts-that-shape-the-answer)
5. [Off the shelf](#5-off-the-shelf)
6. [The build option](#6-the-build-option)
7. [The Zed side: custom fascicle ACP, something installed, or both](#7-the-zed-side)
8. [Comparison](#8-comparison)
9. [Recommendation and the decisions that are yours](#9-recommendation-and-the-decisions-that-are-yours)
10. [What the spec would cover](#10-what-the-spec-would-cover)
11. [Sources](#11-sources)

---

## 1. The short version

- **Nothing off the shelf does the whole job.** The gateways (LiteLLM, Bifrost, Portkey) route by deployment and key, not by what the prompt is. The intent routers (NeMo Switchyard, Plano, vLLM Semantic Router) are heavy, alpha, or built for weak-vs-strong coding-agent turns, and none of them knows which of your machines currently has which model resident. The fleet managers (GPUStack, Paddler) want Linux GPU workers and can't drive a Mac mini. The one small tool shaped like your brief, Olla, does discovery, health and format translation but has no intent routing.
- **The build is smaller than it looks**, because every local server you run (Ollama, llama.cpp, LM Studio, oMLX) already speaks both the OpenAI and the Anthropic wire formats. The gateway never has to translate. It reads enough of the request to choose a model and a node, rewrites the `model` field and the host, and streams the bytes back. That is a routing reverse proxy, about 1,500 to 2,500 lines of TypeScript on fascicle, not a new LiteLLM.
- **The Claude leg has a hard boundary.** Anthropic's current terms let you run the unmodified `claude` binary under your own login for your own use, and forbid storing or intermediating subscription credentials. So the gateway must never hold your Claude login. The pattern that fits: the gateway *decides* ("this needs Claude Opus at high effort") and the client that already has your login, Zed's ACP agent on your laptop, *executes*. For agents that must run unattended on the LAN, the gateway can hold an API key, metered.
- **Zed: build the small fascicle ACP agent and keep `claude-acp` installed.** The fascicle agent is the one front door that asks the gateway and then either streams from a local model or spawns `claude` locally with the chosen model and effort. Zed's native agent also gets the gateway as an `openai_compatible` provider with an `auto` model for the cases where you want Zed's own tools. OpenCode and the other registry agents can't do the decision step, and their model choice is fixed at startup.
- **Host it on plato**, the ThinkCentre that already runs DNS, NUT, Beszel and Uptime Kuma. The gateway is control-plane shaped: tiny, stateless apart from its catalogue and decision log, and it should outlive the inference nodes it watches. A Pi 5 would be a second always-on box doing the same job with a slower CPU for the embedding classifier. Move it to a Pi later if you ever want the isolation.
- **Recommendation:** build it on fascicle, on plato, with a deterministic routing ladder first (request shape, explicit model, rules), embeddings second, and a small local model third for free-form chat; decision mode for Claude; an API key only for unattended agents. Named *penfield*, after the mood organ.

## 2. What you asked for, as requirements

| # | Want | Notes |
|---|---|---|
| R1 | One small always-on box as the entry point | Pi or mini PC. Plato already exists. |
| R2 | Zed sends every prompt to it | Native agent, or an ACP agent you own |
| R3 | A minimal UI for settings | Toggle policies, pin a model, see what's resident |
| R4 | A catalogue of every model on the network, with availability | Resident vs loadable matters as much as up vs down on a 48 GB Mac |
| R5 | Fast routing, deterministic or a small fast model, into profiles | embed, summarize, classify, voice, memory/RAG, light coding on Qwen 3.8 27B or Gemma 4 |
| R6 | Pass-through to Claude Code for anything beyond that, choosing model and effort | Subject to Anthropic's terms, see §4 |
| R7 | Manual override and explicit models | Both in Zed's picker and from code |
| R8 | OpenAI and Anthropic API standards | Chat completions, embeddings, Messages; audio later |
| R9 | Agents can name a model or hand the choice to the router | `auto` plus profile aliases |
| R10 | Easy scale-out: add nodes, register models, mix and match, CPU-only nodes for voice | Registration must be one YAML line, discovery automatic |
| R11 | Best means fastest, cheapest, most private, most accurate, without you thinking about it | These conflict; the policy must say which wins when |
| R12 | Your tools benefit without changes | fascicle consumers point `base_url` at it; plumbbob lives inside Claude Code and is unaffected |

## 3. What you already have

**Machines** (from the homelab docs and today's check of this laptop):

| Host | What | Role for this |
|---|---|---|
| **searle** · Mac mini M4 Pro 48 GB · 192.168.1.90 | Ollama on :11434, MLX engine, `qwen3.8:27b-mlx` warmed by nurselog, Immich-ML, shinbun. Parakeet and Kokoro planned over Wyoming. | The inference node. The only one today. |
| **plato** · ThinkCentre · Debian 13 · 192.168.1.89 | AdGuard DNS for `*.lab.robmclarty.com`, NUT primary, Beszel, Uptime Kuma, Docker, nightly config backup, on the UPS, in the rack | Natural gateway host |
| **heidegger** · Proxmox · 192.168.1.79 | HAOS VM, docker CT (.85) with the nurselog hub, ripper CT | Future consumers (n8n, nurselog-router, lodestar-care) |
| **Qualia** · this MacBook M1 Pro 32 GB | Zed, `claude` 2.1.309 logged in, Ollama with 13 models, Node 24, pnpm | The client, and where Claude executes |
| Planned | compute box (Ryzen 9950X, AVX-512), NAS, Mac Studio, kitchen Pi 5 satellite | More nodes, including CPU-only ones |

**Zed today** (`~/.config/zed/settings.json`): `claude-acp` from the registry with model, effort, mode and fast as config options; `opencode`, `codex-acp`, `cursor`; four fascicle ACP entries (`examples/acp-agent`, `examples/acp-coder`, a scoped research agent) and Volley; the native agent's default model is Ollama `qwen3.8:27b-mlx` on searle; OpenRouter `auto` as a second native provider.

**fascicle v0.17.2** already has the pieces the build needs:

- `fascicle/acp`: `serve_acp` turns a flow into a Zed agent with modes, workspace tools and approval. Config options today cover only mode; adding a `model` option (category `model`, which Zed renders as a picker) is the extension point.
- The engine's `native` transports: raw HTTP to Ollama `/api/chat`, to any OpenAI-compatible server, and to the Anthropic Messages API. `custom_providers` for anything else.
- `claude_cli`: spawns `claude -p --output-format stream-json`, `auth_mode: 'oauth'` uses your login, `CLAUDE_CODE_EFFORT_LEVEL` for effort, `--resume` for multi-turn, sandboxing.
- Pricing and cost events, trajectories, the viewer, OpenTelemetry.
- `branch`, `fallback`, `timeout`, `retry`, `model_step` with a schema (for the classifier call).

**Prior art in your own folders:** runciter drives ACP agents and `claude -p` unattended and strips credentials from child environments; nurselog-router is a deterministic dispatch ladder with a classifier fallback and "logs decisions, never transcripts"; the Sophia plan's utterance log written in the target schema, which doubles as a regression set; the October 7 research's `intake` router proposal (embeddings first, then `qwen3:4b-instruct-2507` or `gemma4:e4b` with a fixed output schema).

## 4. Four facts that shape the answer

**4.1 Anthropic's terms draw the line at credentials, not at where the binary runs.** From the Claude Code legal page, fetched today: OAuth login "is designed to support ordinary use of Claude Code and other native Anthropic applications"; developers "may not collect, store, or intermediate Claude.ai credentials or session tokens"; nothing "prevent[s] an end user from signing in to the unmodified Claude Code binary with their own Claude subscription"; usage limits "assume ordinary, individual usage of Claude Code and the Agent SDK"; and a gateway credential, when set, replaces the subscription and its limits. On April 4, 2026 Anthropic stopped counting third-party harness traffic against Pro and Max plans. Consequences:

- The gateway must not hold or forward your Claude session. No `claude -p` service on searle that other processes call through the gateway. That is the "intermediate" case.
- Running `claude` yourself, on your laptop, under your login, from Zed's ACP agent or from fascicle's `claude_cli`, is the permitted case. So the gateway returns a *decision* and the client executes it. This also happens to be what you asked for: "then just printing its response on the screen."
- Anything that must call Claude unattended on the LAN (night-shift, runciter, a nurselog escalation) goes through the gateway with an API key, metered, with budgets. Keep that leg optional.

**4.2 Every local server speaks both wire formats, so the gateway needn't translate.** Ollama, llama.cpp's `llama-server`, LM Studio and oMLX accept OpenAI chat completions and Anthropic Messages natively (Ollama's Anthropic subset lacks `count_tokens`, `tool_choice` and `cache_control`). A request that arrives in either format can be forwarded in the same format to whichever node the router picks, with only `model` rewritten and the host changed. Streaming is a byte pipe. Traefik and nginx can't do this because the routing decision depends on the body; a small Node service can. This is what makes building cheaper than configuring.

**4.3 On a 48 GB Mac, "available" means "resident".** A cold load of the 27B is 8 to 16 seconds (measured for nurselog), against 1.2 s warm. The GPU budget is about 36 GB by default. The catalogue has to track what `GET /api/ps` says is loaded, prefer resident models, and treat a cold load as a cost the policy can decline. Ollama has no auth and no multi-host story, so the gateway is also where per-node access control lives (LAN only, firewall searle to the gateway and known hosts).

**4.4 Most of your profiles are decidable from the request shape alone.** An `/embeddings` call is an embedding. An `/audio/*` call is voice. A request with tools and a repository attached is coding. A 40-token question with no history is chat. Token count, the presence of tools, attachments, and the caller's own tags (`x-penfield-profile`, `metadata.tags`) cover most traffic at zero cost. Only free-form chat without hints needs a classifier, and only to answer two questions: local or Claude, and which Claude.

## 5. Off the shelf

### 5.1 Gateways (route by deployment and key)

| Project | Form, license | Pi 5 / plato | Formats | Routing | Catalogue and health | Verdict for you |
|---|---|---|---|---|---|---|
| **LiteLLM** v1.106 | Python, MIT core plus paid enterprise dir | Runs on a Pi in Docker, but needs Postgres for the UI and ~0.8 to 3 GB RAM | OpenAI everything, `/v1/messages` for all providers | shuffle, least-busy, latency, cost, usage, tag routing, fallbacks, cooldowns; **no intent routing** | background health checks, UI | The most batteries. Also the worst 2026 security record of the set (PyPI backdoor in 1.82.7 and 1.82.8, two exploited CVEs, two criticals since). Daily releases. Too much to run for one person's LAN. |
| **Bifrost** v2.2 | Go single binary, Apache-2.0 | Yes, light | OpenAI, `/anthropic`, `/genai` drop-in bases | fallbacks, weighted keys; adaptive LB is enterprise-only; **no intent routing** | UI config, no discovery | Good keys-and-budgets layer if you ever need one. Doesn't know prompts or nodes. |
| **Portkey Gateway** | Node, MIT | Yes, light (`npx @portkey-ai/gateway`) | OpenAI-style; Anthropic as a provider | conditional routing on metadata, fallbacks, weighted | none documented | Company acquired by Palo Alto, May 2026. Fine, not distinctive. |
| **Helicone AI Gateway** | Rust, licence file says GPL-3 while README says Apache | 30 MB binary | OpenAI | latency, P2C, cost | — | Public beta, 641 stars, Ollama not listed. Skip. |
| **TensorZero** | — | — | — | — | — | Archived June 12, 2026. Skip. |
| **Kong, Envoy AI Gateway, Higress, APISIX** | Envoy or OpenResty stacks | Heavy; Kong's semantic balancer is enterprise-only | OpenAI; some Anthropic | load balancing, quotas | Kong and APISIX have active health checks | Enterprise shapes. Not for a rack of three machines. |
| **Cloudflare AI Gateway, OpenRouter `auto`, Not Diamond, Martian** | Cloud | — | — | OpenRouter's auto router is Not Diamond under the hood | — | Can't see your LAN. OpenRouter `auto` stays useful as a *target* for cloud fallback. |

### 5.2 Intent and semantic routers (route by what the prompt is)

| Project | Form, license | Pi 5 / plato | Formats | How it routes | Verdict for you |
|---|---|---|---|---|---|
| **NeMo Switchyard** v0.3 ("nvidia's switchyard") | Rust core, Python and TS bindings, Apache-2.0, announced Aug 12, 2026, pre-1.0 | Linux x86_64 wheel wants AVX2 (plato should be fine, check the CPU); aarch64 wheel wants a Neoverse-class CPU, so a Pi 5 is unverified; macOS only via a desktop installer | OpenAI chat, OpenAI Responses, Anthropic Messages on one port; `switchyard launch claude` wraps Claude Code | `stage_router` (local heuristics on tool results and errors, no model call), `llm_classifier` (an LLM judge, 2 to 7 s and real cost in one hands-on), `escalation_router` (weak-to-strong latch), composite, and `prefill`, a classifier trained on your own eval data | The most interesting new thing, and built for exactly one shape: weak-vs-strong turn routing inside a coding agent. Not profile routing, no catalogue or health, alpha, "pin the version". Watch it; borrow `prefill`'s idea. Its ancestor, NVIDIA's llm-router blueprint, is deprecated in its favour. NVIDIA Dynamo's router is KV-cache placement inside one cluster, a different thing. |
| **Plano** (was archgw) v0.4 | Envoy data plane with Rust filters, Python CLI, Apache-2.0; Katanemo acquired by DigitalOcean April 2026 | Envoy on arm64 works; it's Docker plus Envoy, a few hundred MB; the router model should run on searle | `/v1/chat/completions` and `/v1/messages` across providers; Ollama via `base_url` | `routing_preferences` in YAML, each a name, a description and an ordered model list; client omits `model` to get auto, names one to override; `selection_policy: cheapest\|fastest`; router model is Arch-Router-1.5B, documented on Ollama (Qwen2.5-1.5B fine-tune, ~1 GB GGUF, Katanemo licence, not OSI) | The closest off-the-shelf match to "intent to model with override". Costs you Envoy, Docker, a non-OSI router model, and still no node catalogue, residency or health. Reasonable on plato, marginal on a Pi. |
| **vLLM Semantic Router** v0.4 | Go core, multi-container, Apache-2.0 | Needs Docker, 4 cores, 8 GB minimum, 32 GB recommended; no arm64 statement | OpenAI; Anthropic tests exist | ModernBERT and its own Decision and Vela classifier families; `vllm-sr/auto` alias | Built for agent harnesses at cluster scale. Too heavy. |
| **Aurelio semantic-router** 1.x | Python library, MIT | Yes, with the FastEmbed local encoder (bge-small, ONNX) | n/a, it's a library | `Route(name, utterances)` embedded once, nearest route wins; `DecisionRouter` asks a model; `fit()` calibrates thresholds | A good *component*, not a product. Its pattern (exemplars per route, embed, nearest, threshold) is ten lines over fascicle plus your embedding model. Use the idea; you don't need the library in a TypeScript service. |
| **RouteLLM** | Python, Apache-2.0 | — | OpenAI | strong-vs-weak only; needs an OpenAI key for embeddings | No release, last activity about a year ago, Switchyard dropped it. Skip. |

### 5.3 Fleet managers and local serving (the node side)

| Tool | Cross-node catalogue, health, routing? | Verdict for you |
|---|---|---|
| **GPUStack** v2.2 | Yes: server, workers, scheduler, catalogue, UI, OpenAI API | v2 workers are Linux amd64/arm64 with vLLM or SGLang; **a Mac mini can't be a worker**. Revisit if the compute box gets a GPU. |
| **llama-swap** | No, single host; spawns and swaps local server processes on demand, `/v1/messages` passthrough, YAML models and aliases, arm64 builds, UI | Ideal *on a node* to multiplex llama-server, whisper and embedding processes under one port. Ollama already does this for its own models. |
| **Olla** | **Yes**: per-provider model discovery, continuous health checks, circuit breakers, priority routing and failover, Anthropic-to-OpenAI translation, under 50 MB, Raspberry Pi builds | The one tool shaped like R4 and R10. 320 stars, small community, no intent routing. Either adopt it as the fleet layer under your router, or copy its shape: it is a few hundred lines of Go. |
| **Paddler** | Balancer plus agents, multi-host | Built-in llama.cpp engine only. Not for Ollama or MLX. |
| **exo** | Discovery plus tensor parallel across Apple Silicon | Splits one big model across Macs over Thunderbolt 5. Not profile routing. Relevant only with a second TB5 Mac. |
| **Ollama** | No multi-host story at all; `OLLAMA_HOST`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_NUM_PARALLEL`; no auth | Stays the node runtime on searle. The gateway is its front door. |
| **LocalAI** v4.11, **LM Studio** `llmster`, **Open WebUI** | LocalAI: fat all-in-one with whisper, kokoro, embeddings, Anthropic API, arm64 images, a distributed mode. llmster: headless, Linux x64 only. Open WebUI: multiple Ollama URLs chosen at random, Pipelines deprecated. | LocalAI is a candidate for the future CPU compute box (one container for voice and embeddings). The other two aren't gateways. |

### 5.4 Exposing Claude Code as an endpoint

- `RichardAtCT/claude-code-openai-wrapper` (FastAPI, 630 stars, pins an old SDK) and `pppp606/cli-agent-openai-adapter` (no streaming) wrap Claude Code behind `/v1/chat/completions`. Both are the "intermediate" pattern §4.1 rules out for anything other than you alone on your own machine, and neither buys you anything fascicle's `claude_cli` doesn't already do.
- `musistudio/claude-code-router` v3 is the opposite direction: it gives *Claude Code* a local endpoint and sends its own requests to other providers. Not what you need.

### 5.5 Small, fast classifiers

| Approach | Where it runs | Latency | Notes |
|---|---|---|---|
| Request shape and rules (endpoint, model prefix, tools present, token count, caller tags) | the gateway | ~0 ms | Covers most of R5 with no model |
| Embedding nearest-exemplar (the semantic-router pattern) with `all-minilm` (22M), `bge-small`, `nomic-embed-text` (both already pulled) or EmbeddingGemma-300M | searle via the catalogue, or on plato via ONNX | tens of ms on x86 (est.); no Pi 5 numbers published | The embedder is just another catalogued model; if the node is down, the ladder stops at rules |
| Small instruct model constrained to a JSON schema: `qwen3:4b-instruct-2507` (0.3 s warm, 10/12 on nurselog's corpus) or `gemma4:e4b` | searle | 0.3 to 1 s warm | Only for free-form chat without hints; returns profile, confidence, and which Claude tier |
| Arch-Router-1.5B | searle via Ollama | no CPU numbers published | Preference-aligned routing from route descriptions. Katanemo licence. Optional later. |
| ModernBERT intent heads (flowxai/intentrouter) | plato CPU | 100 to 160 ms per doc INT8 on x86 | A fine-tune on your own decision log later, Switchyard's `prefill` idea |

## 6. The build option

One Node 24 service on fascicle, named *penfield*, on plato. Five parts:

1. **Catalogue.** `penfield.yaml` lists nodes (`name`, `kind: ollama | openai_compatible | anthropic | wyoming | claude_decision`, `url`, `tags`, `privacy`). The gateway discovers models per node (`/api/tags`, `/v1/models`), merges them with hand-written profile metadata (which profiles a model serves, context, cost, speed class, privacy class), and exposes the result at `/v1/models` and `/catalogue`. Adding a node is one YAML entry plus a DNS name in AdGuard.
2. **Prober.** Every N seconds per node: up or down, which models are resident (`/api/ps`), load, last latency. Circuit-breaks a node that fails. Publishes `/healthz` for Uptime Kuma and a metrics line for Beszel or OpenTelemetry.
3. **Router.** A ladder, cheapest rung first, that returns a `Decision`:
   `explicit model` → `profile alias` (`auto/fast`, `auto/private`, `auto/best`) → `request shape` (endpoint, tools, attachments, tokens) → `rules` (caller tags, size thresholds, privacy class) → `embedding nearest-exemplar` → `small-model classifier` (free-form chat only) → `default`. Then a **placement** step picks a node and model for the chosen profile from what is resident and healthy, with cold-load as a declared cost. A decision carries the target, the effort, the reasons, a confidence, and the alternatives, and every decision is logged in a neutral schema (the Sophia pattern) so the log is also the eval set.
4. **Wire.** OpenAI `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`; Anthropic `/v1/messages`; later `/v1/audio/transcriptions` and `/v1/audio/speech` adapted onto Wyoming. Requests are forwarded in the format they arrived in, `model` rewritten, streamed through. A `/route` endpoint returns the decision alone, for clients that execute themselves (the Claude leg). Bearer tokens per caller, LAN only, with per-caller policy (which privacy classes, whether cloud is allowed, budget).
5. **UI.** One page the gateway serves: nodes and residency, the catalogue, the last hundred decisions with their reasons, and a handful of switches (cloud allowed, prefer fast or prefer accurate, pin a model). Weft later if it earns it.

**Execution of the Claude leg.** The gateway's `claude` target is a *decision* target by default: the response to `/route` says `provider: claude_cli, model: opus, effort: high`, and the caller runs it. A second, optional target `anthropic_api` with an API key executes server-side for unattended agents, with budgets. The gateway never sees a subscription token.

**Size (est.).** Catalogue and prober ~400 lines, router and policy ~600, wire proxy ~600 including SSE passthrough and the Anthropic path, UI ~300, config and tests on top. Two weekends for a usable Phase 0 with your pace and plumbbob's loop. Runtime footprint ~100 to 200 MB; the classifier models live on searle.

**What you reuse.** fascicle's engine for the classifier call (`model_step` with a schema, native Ollama transport), `anthropic` native for the API-key leg, pricing and cost events, trajectory and viewer for debugging a route, `define_agent` for the classifier prompt as a markdown file. Fastify for the server (the fastify-mcp briefing already sketched the shape), checkride as the gate, plumbbob to build it.

**What you'd skip by building.** Envoy, Postgres, a Python stack, a non-OSI router model, and someone else's security record on the box that fronts your models.

## 7. The Zed side

Three ways Zed can reach the gateway. The recommendation is the first two together, and the third stays installed.

**7.1 A fascicle ACP agent, the penfield agent (build, ~300 lines over `serve_acp`).** On each turn it calls `/route` with the prompt, the history length, the attachments and the session's mode. If the decision is local, it streams the answer from the gateway with fascicle's workspace tools (read, search, edit, run, with Zed's permission prompts). If the decision is Claude, it spawns `claude_cli` locally with the chosen model and effort under your login, in the session's `cwd`, and streams that back. It exposes config options Zed renders as pickers: `model` (`auto`, then the catalogue), `effort`, and `mode`. That is R2, R6, R7 and "then just printing its response on the screen" in one agent, inside the terms. The `examples/acp-coder` agent is most of it already; the delta is the `/route` call, the `claude_cli` branch, and a `model` config option fed from `/v1/models`.

**7.2 Zed's native agent through an `openai_compatible` provider (configure, zero code).** Register the gateway once under `language_models.openai_compatible` with `api_url: "http://penfield.lab.robmclarty.com:PORT/v1"`, models `auto`, `auto/fast`, `auto/private`, and the concrete local tags, `reasoning_effort` on the thinking-capable ones, and the key in `PENFIELD_API_KEY`. Zed does tools, streaming, thinking and the model picker against it, per profile. The limit: Zed's native agent can only reach Claude through the gateway's API-key leg, never through your subscription, so this path is for local-first work and for when you want Zed's own tool set.

**7.3 Installed agents.** Keep `claude-acp` for pure Claude sessions with model and effort pickers; it is the permitted path and it already works. OpenCode speaks to any OpenAI-compatible `baseURL` and is in the registry, but its model is fixed at startup (the `session/set_config` issue was closed not-planned in June) and it can't do the decision step, so it would only ever be "Zed talking to the gateway's `auto`", which 7.2 does without a second harness. Codex-ACP exposes a custom gateway option but is OpenAI-shaped. None of them replaces 7.1.

So: custom fascicle ACP, yes; install, keep what's installed; both.

## 8. Comparison

Scores: ✓ fits, ◐ partly, ✗ no.

| Requirement | LiteLLM | Bifrost | Plano | Switchyard | Olla + own router | **Build on fascicle** |
|---|---|---|---|---|---|---|
| R1 small always-on box | ◐ (Postgres, ~1 to 3 GB) | ✓ | ◐ (Envoy, Docker) | ◐ (alpha, arm64 caveat) | ✓ | ✓ |
| R2 Zed sends everything | ✓ via openai_compatible | ✓ | ✓ | ✓ | ✓ | ✓ plus the ACP agent |
| R3 minimal UI | ✓ (big) | ✓ | ◐ | ✗ | ◐ | ✓ (small, yours) |
| R4 catalogue and availability, incl. residency | ◐ health, no residency | ✗ | ✗ | ✗ | ◐ health, no residency | ✓ |
| R5 fast profile routing | ✗ tags only | ✗ | ✓ | ◐ turn routing | ✓ (own) | ✓ |
| R6 Claude pass-through choosing model and effort, inside the terms | ◐ API key only | ◐ API key only | ◐ API key only | ◐ API key only | ✓ decision mode (own) | ✓ decision mode |
| R7 override | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| R8 OpenAI and Anthropic | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (passthrough) |
| R9 agents pick model or auto | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ |
| R10 add nodes easily | ◐ YAML per deployment | ◐ | ◐ | ✗ | ✓ discovery | ✓ discovery |
| R11 policy over speed, cost, privacy, accuracy | ◐ cost and latency LB | ✗ | ◐ cheapest or fastest | ◐ | ✓ (own) | ✓ |
| R12 your tools unchanged | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ and they share the catalogue |
| Operating burden | high | low | medium | medium | low plus own code | low, all yours |
| 2026 security record | poor | one bad release, fixed | n/a | n/a | n/a | yours |
| Code you write | classifier plugin | classifier in front | YAML | TOML | the router | the router plus the proxy |

The honest reading: the two right-hand columns are the same design. "Olla plus own router" saves you the prober and the Anthropic translation (which you don't need, §4.2) at the cost of a second process, a Go dependency you'd read but not own, and no residency awareness. Building the prober yourself is 400 lines. That is why the recommendation is the last column.

## 9. Recommendation and the decisions that are yours

**Recommendation.** Build penfield on fascicle, in TypeScript, as one service on plato. Deterministic ladder first, embeddings second, a small Ollama model on searle third. Claude by decision mode from the laptop's ACP agent; an API key in the gateway only for unattended agents, off by default. Zed gets the fascicle penfield agent as its front door, the gateway as an `openai_compatible` provider for the native agent, and `claude-acp` stays installed. Log every decision in a neutral schema and make the log the regression set.

**Decisions I'd like you to make or confirm before I write the spec:**

| # | Decision | My pick | The alternative |
|---|---|---|---|
| D1 | Host | **plato**, as a Docker container or a systemd service, with the config in a git repo | Buy a Pi 5 8 GB for isolation; or wait for the compute box. Either works later; the service doesn't care. |
| D2 | Core | **Build on fascicle** | Plano on plato with Arch-Router on searle, plus your own catalogue and prober anyway |
| D3 | Claude leg | **Decision mode by default; API key leg optional, off** | API key always, and never use the subscription from the gateway's clients. Simpler, costs money, loses nothing else. |
| D4 | Zed front door | **Penfield ACP agent + native `openai_compatible` provider; keep `claude-acp`** | Native provider only, no ACP agent (loses subscription Claude behind `auto`) |
| D5 | Classifier | **Rules → embeddings (`nomic-embed-text` on searle) → `qwen3:4b-instruct-2507` with a schema, only for free-form chat** | Arch-Router-1.5B, or a ModernBERT fine-tune on the decision log later |
| D6 | Voice | **Phase 3**: Wyoming adapters onto `/v1/audio/*` once Parakeet and Kokoro are up on searle | Leave voice to Home Assistant's pipeline entirely |
| D7 | Name | penfield (decided 2026-10-29) | — |

## 10. What the spec would cover

If you confirm, the spec is written for plumbbob's loop (a frame, decisions with their because, constraints, seams, steps with done-when) and would have:

1. **Frame and non-goals.** No translation between wire formats in Phase 0. No subscription credentials on the gateway, ever. No LLM in the placement step.
2. **The catalogue schema** (`penfield.yaml` and the discovered merge), profiles and aliases, privacy classes.
3. **The Decision type** and the routing ladder, with the policy table (what wins when speed, cost, privacy and accuracy conflict), confidence thresholds, and the decision log schema.
4. **The wire**: endpoints, auth, forwarding rules, streaming, error mapping, timeouts, the `/route` contract, the `x-penfield-*` headers and `metadata` hints.
5. **The prober** and the residency model, warm-up policy, circuit breaking, and what Uptime Kuma and Beszel see.
6. **The penfield ACP agent**: config options, the `/route` call, the local-model branch with workspace tools, the `claude_cli` branch, cancellation, history.
7. **Zed configuration** for both paths, and the fascicle `base_url` recipe for your other tools.
8. **The UI** page and its switches.
9. **Phases and steps**: Phase 0 catalogue, prober, OpenAI chat and embeddings with `auto` by rules, Zed native provider. Phase 1 Anthropic passthrough, `/route`, the penfield ACP agent. Phase 2 embeddings and the classifier, decision log and a `volley matrix`-style replay eval. Phase 3 UI, API-key leg, voice. Phase 4 more nodes, llama-swap on nodes, budgets, mDNS or DNS-SD registration.
10. **Operations**: Docker on plato, backup of the config with the nightly job, firewalling searle, upgrade and rollback.

## 11. Sources

Primary pages fetched 2026-10-29 by the research pass, plus your own docs.

- Zed: `language_models.openai_compatible` and `anthropic_compatible` (zed.dev/docs/ai/use-api-access), local models (zed.dev/docs/ai/use-a-local-model), external agents and `agent_servers` (zed.dev/docs/ai/external-agents), profiles and the model picker (zed.dev/docs/ai/agent-profiles, zed.dev/docs/ai/agent-panel).
- ACP: session config options, stabilized 2026-02-04 (agentclientprotocol.com/protocol/v1/session-config-options), initialization and overview, TypeScript SDK `@agentclientprotocol/sdk`, the registry JSON.
- Claude Code: legal and compliance (code.claude.com/docs/en/legal-and-compliance), LLM gateway notes (code.claude.com/docs/en/llm-gateway), CLI reference, headless mode, Agent SDK TypeScript options; `zed-industries/claude-code-acp`.
- Gateways and routers: BerriAI/litellm and its routing, health and `/v1/messages` docs; maximhq/bifrost; Portkey-AI/gateway; Helicone/ai-gateway; tensorzero (archived); katanemo/plano and docs.planoai.dev (routing preferences, Arch-Router on Ollama); NVIDIA-NeMo/Switchyard (README, INSTALLATION.md, routing algorithms, known issues), NVIDIA-AI-Blueprints/llm-router (deprecated), the Register's Switchyard piece 2026-08-12; vllm-project/semantic-router; aurelio-labs/semantic-router; lm-sys/RouteLLM.
- Nodes: gpustack/gpustack, mostlygeek/llama-swap, thushan/olla, intentee/paddler, exo-explore/exo, mudler/LocalAI, Ollama FAQ, LM Studio llmster docs, Open WebUI docs.
- Classifiers: katanemo/Arch-Router-1.5B, flowxai/intentrouter, Google's Pi 5 LiteRT post 2026-08-11.
- Yours: `fascicle/code/fascicle/docs/{acp,cli,providers,roadmap}.md`, `learning-ai/multi-agent-orchestra/orchestration-layer-research-2026-10-07.md`, `nurselog/docs/nurselog-inference-node.md`, `nurselog/code/nurselog-router/README.md`, `runciter/code/runciter/docs/architecture.md`, `_homelab/sophia-intent-layer-plan.md`, `_homelab/thinkcentre-setup-v2.md`, `~/.config/zed/settings.json`.
