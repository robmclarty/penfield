# Penfield: playbook

**For:** installing, configuring and operating penfield on plato, wiring Zed and the other tools to it, and running the Stage A build. Companion to [`penfield_first_spec.md`](./penfield_first_spec.md).
**Date:** 2026-10-29. Values below are today's; the newest `_homelab` doc wins if they drift.

## Contents

1. [Before the build: prepare searle and plato](#1-before-the-build)
2. [Build Stage A with plumbbob](#2-build-stage-a-with-plumbbob)
3. [Install on plato](#3-install-on-plato)
4. [Configure `penfield.yaml` for the house](#4-configure-penfieldyaml-for-the-house)
5. [Wire Zed](#5-wire-zed)
6. [Wire everything else](#6-wire-everything-else)
7. [Check it works](#7-check-it-works)
8. [Operate](#8-operate)
9. [The office variant](#9-the-office-variant)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Before the build

Thirty minutes on the nodes, once.

**searle (Mac mini).** The inference-node runbook already covers keep-alive, never-sleep and `OLLAMA_HOST`. Add:

```bash
# on searle: Ollama context and residency defaults, then relaunch Ollama
launchctl setenv OLLAMA_CONTEXT_LENGTH 65536
launchctl setenv OLLAMA_MAX_LOADED_MODELS 2
launchctl setenv OLLAMA_NUM_PARALLEL 2
launchctl setenv OLLAMA_NO_CLOUD 1
osascript -e 'quit app "Ollama"'; open -a Ollama
```

Then confirm what is there and what is resident:

```bash
curl -s http://192.168.1.90:11434/api/tags | jq '.models[].name'
```

```bash
curl -s http://192.168.1.90:11434/api/ps | jq '.models[] | {name, size_vram, expires_at}'
```

Firewall: searle's port 11434 should answer plato (`.89`), heidegger's docker CT (`.85`, for nurselog) and your laptop, and nothing else. On the UCG-Fiber, a LAN-to-LAN rule to port 11434 from those three addresses, then a deny. Ollama has no auth; the gateway is its front door from now on.

**plato.** Confirm the CPU supports AVX2 (only matters for the Stage C embedder if it ever runs locally):

```bash
grep -o -m1 avx2 /proc/cpuinfo
```

Reserve the name in AdGuard: a DNS rewrite `penfield.lab.robmclarty.com → 192.168.1.89`. Create the state and secrets directories:

```bash
sudo mkdir -p /var/lib/penfield /etc/penfield && sudo chmod 700 /etc/penfield
```

Tokens, one per caller, kept out of the repo:

```bash
for c in rob zed-native night-shift nurselog; do echo "$c: $(openssl rand -hex 24)"; done | sudo tee /etc/penfield/tokens >/dev/null && sudo chmod 600 /etc/penfield/tokens
```

Record the `rob` and `zed-native` tokens somewhere you'll find them for §5; they go into Zed's keychain, not into `settings.json`.

## 2. Build Stage A with plumbbob

1. Pick the name (spec Q6). Create the repo from trailhead:

```bash
cd ~/Projects && mkdir penfield && cd penfield && git init && pnpm dlx trailhead init --name penfield --packages penfield
```

   (Substitute trailhead's actual scaffold command; its README is the source of truth.)

2. Copy the spec in as `docs/spec.md` and the playbook as `docs/playbook.md`.
3. In Claude Code, in the repo: `/plumbbob:plan docs/spec.md`. The spec's §8 is the step list; keep the five ranges as the build ranges. The first run stops after step 4 for the schema review.
4. Per range: `/plumbbob:run`, read what landed, advance. Steps 8, 12 and 16 need searle up; run them from this laptop with `PENFIELD_CONFIG=deploy/penfield.example.yaml` pointed at `192.168.1.90`.
5. After step 20: `/plumbbob:finish`, tag 0.1.0, then §3.

Model seats for the build, following your Build-runs convention: Opus for ranges 1 and 3 (schema, ladder, placement), Sonnet for 2, 4 and 5. Mark steps 11 and 14 as pauses: the lease rules and the stream piping are where a wrong call costs the most.

## 3. Install on plato

Docker, alongside AdGuard and Kuma. From the repo on plato (clone it, or `rsync` the checkout):

```bash
git clone git@github.com:robmclarty/penfield.git /opt/penfield && cd /opt/penfield
```

```bash
sudo cp deploy/penfield.example.yaml /etc/penfield/penfield.yaml && sudo $EDITOR /etc/penfield/penfield.yaml
```

`deploy/compose.yaml` (shape; the shipped file is authoritative):

```yaml
services:
  penfield:
    build: .
    image: penfield:0.1.0
    restart: unless-stopped
    user: "1000:1000"
    ports: ["192.168.1.89:7777:7777"]        # LAN address only
    volumes:
      - /etc/penfield:/etc/penfield:ro
      - /var/lib/penfield:/var/lib/penfield
    environment:
      PENFIELD_CONFIG: /etc/penfield/penfield.yaml
      OPENROUTER_API_KEY_FILE: /etc/penfield/openrouter.key   # optional, only if the cloud node is enabled
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:7777/healthz"]
      interval: 30s
```

```bash
cd /opt/penfield && docker compose -f deploy/compose.yaml up -d --build
```

```bash
curl -s http://penfield.lab.robmclarty.com:7777/healthz | jq
```

If you prefer no Docker: `deploy/penfield.service` runs `node packages/penfield/dist/cli.js serve` as a `penfield` user with `Restart=on-failure`, `WatchdogSec=60` (Stage B) and the same paths.

**Uptime Kuma:** an HTTP monitor on `http://192.168.1.89:7777/healthz`, 60 s, keyword `"ok"`.
**Beszel:** nothing to add; the container shows under plato's agent.
**Backup:** add `/etc/penfield` and `/var/lib/penfield/penfield.db` to `plato-backup.sh`'s list. SQLite in WAL mode copies safely with `sqlite3 penfield.db ".backup /tmp/penfield.db"`; the script should use that rather than `cp`.

## 4. Configure `penfield.yaml` for the house

The spec's §5.1 is the full schema; this is the first real file. Things that are yours to tune are marked.

```yaml
version: 1
server:
  listen: 192.168.1.89:7777
  name: penfield
  state_dir: /var/lib/penfield
  tokens_file: /etc/penfield/tokens

nodes:
  searle:
    kind: ollama
    url: http://192.168.1.90:11434
    privacy: lan
    discover: true
    memory_gb: 48
    slots: { default: 2, "qwen3.8:27b-mlx": 1 }      # tune: the 27B dense is slow; one at a time
    pinned: [qwen3.8:27b-mlx]                        # nurselog depends on it being warm
    probe: { every_ms: 10000, timeout_ms: 3000, ready_prompt: true }
    recover: { unload_on_hang: true }
  claude:
    kind: claude_decision
    privacy: cloud
    models: [haiku, sonnet, opus]
  # openrouter: enable later if you want a cloud fallback the gateway can execute itself
  # anthropic: Stage D

models:
  "qwen3.8:27b*":       { profiles: [code-light, reason, chat, summarize], speed: slow, quality: high, context: 65536 }
  "qwen3.6:35b*":       { profiles: [code-light, chat, summarize, extract], speed: fast, quality: medium, context: 65536 }
  "gemma4:26b*":        { profiles: [chat, summarize, classify], speed: fast, quality: medium }
  "gemma4:e4b*":        { profiles: [classify, extract, route], speed: fastest, quality: low }
  "qwen3:4b-instruct*": { profiles: [classify, extract, route], speed: fastest, quality: low }
  "glm-4.7-flash*":     { profiles: [summarize, extract], speed: fast, quality: medium }
  "nomic-embed-text*":  { profiles: [embed] }
  "qwen3-embedding*":   { profiles: [embed] }
  "claude/opus":        { profiles: [code-heavy, reason], quality: frontier, cost: high }
  "claude/sonnet":      { profiles: [code-heavy, code-light, chat], quality: frontier, cost: medium }
  "claude/haiku":       { profiles: [chat, summarize, classify], quality: high, cost: low }

profiles:
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

policy:
  precedence: [privacy, quality, speed, cost]
  confidence_threshold: 0.7
  cold_load: avoid
  busy: { default: degrade, wait_ms: 5000 }
  on_claude_for_proxy: hint
  stall_ms: { default: 30000, first_token_cold: 90000, code-light: 60000, code-heavy: 120000 }
  deadline_ms: { default: 600000 }

router:
  rules:
    - { when: { endpoint: embeddings }, profile: embed }
    - { when: { hint: present }, profile: $hint }
    - { when: { tools: true, tokens_gt: 12000 }, profile: code-heavy }
    - { when: { tools: true }, profile: code-light }
    - { when: { attachments: code, tokens_gt: 4000 }, profile: code-light }
    - { when: { tokens_gt: 24000 }, profile: summarize }
    - { when: { system_matches: "(?i)classif|categori|label" }, profile: classify }
    - { when: { chat: true }, profile: chat }

callers:
  rob:          { max_privacy: cloud, claude: decision, priority: interactive, keep_prompts: true }
  zed-native:   { max_privacy: cloud, claude: hint, priority: interactive }
  night-shift:  { max_privacy: lan, priority: batch, busy: wait, wait_ms: 120000 }
  nurselog:     { max_privacy: lan, priority: interactive, models: [qwen3.8:27b-mlx, nomic-embed-text] }
```

Check it before it goes live:

```bash
docker compose -f deploy/compose.yaml run --rm penfield check-config
```

Note the tag names: searle has `qwen3.8:27b-mlx`, this laptop has `qwen3.8:27b`. Candidates are matched against what discovery finds, so a candidate no node has is a boot error, by design.

## 5. Wire Zed

**Native agent (Stage A).** Add to `~/.config/zed/settings.json` under `language_models`:

```json
"openai_compatible": {
  "penfield": {
    "api_url": "http://penfield.lab.robmclarty.com:7777/v1",
    "available_models": [
      { "name": "auto",         "display_name": "Penfield · auto",    "max_tokens": 65536, "reasoning_effort": "medium",
        "capabilities": { "tools": true, "images": false, "parallel_tool_calls": false, "prompt_cache_key": false, "chat_completions": true, "interleaved_reasoning": false, "max_tokens_parameter": false } },
      { "name": "auto/fast",    "display_name": "Penfield · fast",    "max_tokens": 65536 },
      { "name": "auto/private", "display_name": "Penfield · private", "max_tokens": 65536 },
      { "name": "auto/best",    "display_name": "Penfield · best",    "max_tokens": 65536 },
      { "name": "qwen3.8:27b-mlx", "display_name": "searle · qwen3.8 27b", "max_tokens": 65536, "reasoning_effort": "medium" },
      { "name": "qwen3.6:35b-mlx", "display_name": "searle · qwen3.6 35b", "max_tokens": 65536 }
    ]
  }
}
```

The key: Zed reads it from `PENFIELD_API_KEY` (provider id upper-snake plus `_API_KEY`) or from Settings → AI → LLM Providers, which stores it in the keychain. Use the `zed-native` token. Then set a default, for example in a profile:

```json
"agent": {
  "profiles": {
    "penfield": { "name": "Penfield", "default_model": { "provider": "openai_compatible/penfield", "model": "auto" } }
  }
}
```

(Confirm the provider key format in Zed's docs when you add it; `zed: open default settings` shows the current shape.) Switch models with `cmd-alt-/`; `auto` and the aliases sit beside the concrete tags.

**The penfield ACP agent (Stage B).** Under `agent_servers`:

```json
"Penfield": {
  "type": "custom",
  "command": "node",
  "args": ["/Users/robmclarty/Projects/penfield/packages/agent/dist/main.js"],
  "env": { "PENFIELD_URL": "http://penfield.lab.robmclarty.com:7777", "PENFIELD_TOKEN": "<rob token>", "PATH": "/usr/local/bin:/usr/bin:/bin:/Users/robmclarty/.local/bin" }
}
```

`PATH` must include where `claude` and `npx` live, because the Claude branch spawns `claude-agent-acp` in the session's `cwd`. The agent's thread shows `model`, `effort` and `mode` pickers; `auto` asks the gateway, anything else is an override. `claude-acp` from the registry stays installed for pure Claude threads.

## 6. Wire everything else

**fascicle consumers** (volley, night-shift, shinbun, lodestar, paceline's scribe): the compat recipe from fascicle's providers doc, pointed at the gateway. Each tool keeps its own caller token.

```ts
const engine = create_engine({
  providers: {
    openai: { api_key: process.env.PENFIELD_TOKEN!, base_url: 'http://penfield.lab.robmclarty.com:7777/v1', transport: 'native' },
  },
})
await engine.generate({ provider: 'openai', model: 'auto/private', prompt: '…' })
```

`model` can be `auto`, an alias, a profile name (`summarize`), or a concrete tag. A hint goes in `provider_options.openai.metadata.penfield` or an `x-penfield-profile` header. Pricing for the `openai` name records `pricing_missing` for local tags; add rows or use the `lmstudio` provider name for a tolerant, keyless path.

**nurselog's normalizer:** keep `CLASSIFIER_URL` pointed straight at searle for now. Its config loader refuses anything that isn't LAN, the gateway is LAN, so moving it is a one-line change once Stage A has run for a couple of weeks; the `nurselog` caller in `penfield.yaml` is already restricted to the two models it may use.

**n8n, Home Assistant, curl:** OpenAI format with `Authorization: Bearer <token>`; Anthropic format from Stage B.

**runciter and plumbbob:** unchanged. Both drive Claude Code directly under your login, which is the permitted path. Runciter's `acp` kind can run the penfield agent as any other ACP agent once Stage B lands.

## 7. Check it works

From the laptop, with `T=<rob token>` and `H=http://penfield.lab.robmclarty.com:7777`:

```bash
curl -s -H "Authorization: Bearer $T" $H/v1/models | jq '.data[] | {id, owned_by, penfield}'
```

```bash
curl -s -N -H "Authorization: Bearer $T" -H 'content-type: application/json' $H/v1/chat/completions -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Summarize the plot of Moby-Dick in two sentences."}]}'
```

```bash
curl -s -D - -o /dev/null -H "Authorization: Bearer $T" -H 'content-type: application/json' $H/v1/chat/completions -d '{"model":"qwen3.8:27b-mlx","messages":[{"role":"user","content":"hi"}]}' | grep -i x-penfield
```

```bash
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' $H/v1/embeddings -d '{"model":"auto","input":"a plumb bob"}' | jq '.data[0].embedding | length'
```

```bash
curl -s -H "Authorization: Bearer $T" "$H/decisions?limit=5" | jq '.[] | {profile, rung, target_model, outcome, total_ms}'
```

Then the busy path: start two long `qwen3.8:27b-mlx` requests, send a third with `auto`, and confirm in `/decisions` that it degraded to the 35B with `degraded_from` set. Then the stall path: `docker pause` nothing, but on searle `kill -STOP` the Ollama runner for a moment during a stream, watch `/leases` mark it stalled, and `kill -CONT` it; the incident should read `stall` and the breaker should stay closed after one.

## 8. Operate

- **Upgrade:** `git pull`, `docker compose … up -d --build`; the boot sweep orphans any lease from the old instance. Pin an image tag per release; roll back by tag.
- **Add a node:** a `nodes:` entry and a DNS rewrite; restart; check `/catalogue`. A node that cannot be discovered lists its models by hand.
- **Add a model:** pull it on the node; discovery picks it up on the next tick; add an overlay line if it needs profiles beyond the defaults.
- **Pin or unpin:** edit `pinned:` and restart, or Stage B's `/admin/pins`.
- **Read the log:** the UI page, or `penfield decisions --since 24h --caller rob` for a table of profile, rung, target, outcome and timings.
- **Tune rules:** edit, run `penfield replay --since 7d` to see which past decisions would change, then restart.
- **Tokens:** rotate by editing `/etc/penfield/tokens` and restarting; a caller with no token line is refused.
- **Recovery, by hand, in order:** `/leases` → release the stuck one; `/catalogue` → reset the breaker; `/admin/nodes/searle/unload/<model>` to evict a wedged model; on searle, `brew services restart ollama` or relaunch the app; the UI shows the same ladder with buttons from Stage B.
- **What never happens here:** no subscription credential on plato. If a step ever seems to need one, the design is wrong, not the config.

## 9. The office variant

Same binary, a different file. The shape of `deploy/office.example.yaml`:

```yaml
version: 1
server: { listen: 10.0.4.20:7777, name: office-penfield, state_dir: /var/lib/penfield, tokens_file: /etc/penfield/tokens }
nodes:
  studio-1: { kind: ollama, url: http://10.0.4.31:11434, privacy: lan, discover: true, memory_gb: 128, slots: { default: 4 } }
  studio-2: { kind: ollama, url: http://10.0.4.32:11434, privacy: lan, discover: true, memory_gb: 128, slots: { default: 4 } }
  closet-lap-1: { kind: openai_compatible, url: http://10.0.4.41:8080/v1, privacy: lan, discover: true }   # llama-server or LM Studio
  bedrock: { kind: anthropic_api, enabled: true, privacy: cloud, api_key_env: ANTHROPIC_API_KEY }           # the company's key, budgeted per caller
  claude: { kind: claude_decision, privacy: cloud, models: [sonnet, opus] }                                   # each person's own login, on their own laptop
profiles: { … same profile names, office candidates … }
policy: { precedence: [privacy, quality, speed, cost], busy: { default: wait, wait_ms: 30000 }, on_claude_for_proxy: api_key }
callers:
  rob: { max_privacy: cloud, claude: decision, priority: interactive }
  ci:  { max_privacy: lan, priority: batch, busy: wait, wait_ms: 600000 }
```

Two Mac Studios with the same models give placement real choice; the lease table balances across them with no extra code. The company's API key is the permitted path for shared Claude use; personal logins stay on personal laptops via decision mode.

## 10. Troubleshooting

| Symptom | Look at | Likely cause |
|---|---|---|
| `401` from everything | `/etc/penfield/tokens`, the `Authorization` header | Token not in the file, or Zed's keychain entry missing |
| `403 max_privacy` | the caller's policy | A `cloud` candidate reached for a `lan`-only caller; fix the profile's candidates or the caller |
| `auto` always picks the 35B | `/decisions` reasons | The 27B is busy or not resident and `cold_load: avoid`; check `/catalogue` residency |
| First token takes a minute | `placement.cold_load` in the decision | A cold load; pin the model or raise `first_token_cold` |
| Stalls on the 27B | `/leases`, `incidents` | Context overflow on searle (set `OLLAMA_CONTEXT_LENGTH`), or memory thrash from an unpinned load |
| Breaker open, node fine by hand | `incidents` | Probe timeout too tight for a loaded box; raise `probe.timeout_ms` |
| Zed shows "No tools" on `auto` | the model's `capabilities` | Add `"tools": true` to the `available_models` entry |
| Decision says `hint` in Zed's native agent | `on_claude_for_proxy` | Expected: open the thread in the Penfield ACP agent or `claude-acp` with the named model and effort |
| Catalogue missing a tag | `/catalogue`, `ollama list` on the node | Different tag on searle than on the laptop (`-mlx`); candidates name the node's tag |
| Leases pile up after a crash | boot log | The boot sweep marks them orphaned; if not, the instance id did not change, which means the process never restarted |
