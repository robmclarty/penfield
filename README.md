# penfield

A model gateway and router for the house: dial a setting, get the state you need.

penfield is one small service with one settings file. It keeps a catalogue of inference nodes and the models on them, probes them for health and residency, and answers requests in the OpenAI and Anthropic wire formats. A request that names a real model is forwarded to the node that has it. A request that names `auto`, an alias or a profile is routed by a cheap ladder of rules to a profile, placed on a model that is resident, healthy and free, and forwarded unchanged. When the answer is "this needs Claude", penfield says so, and the requester's own client runs Claude under its own login. Every decision is logged.

Named after the Penfield mood organ in *Do Androids Dream of Electric Sheep?*

> **Status:** pre-release. The workspace and its check gate are in place, and Stage A is being built from the spec. Nothing runs yet.

## What it isn't

- **A translator.** Requests are forwarded in the format they arrived in, with only `model` rewritten.
- **A holder of Claude subscription credentials.** It never reads, stores or forwards one; a Claude target is a decision, not an execution.
- **An inference server.** Models run on the nodes (Ollama, llama.cpp, LM Studio, MLX); penfield runs on the control plane in front of them.
- **A team gateway.** No SSO, spend dashboards or multi-tenant admin.

## Stages

| Stage | What lands |
|---|---|
| A | `auto` by rules for any OpenAI-format client: config, catalogue and prober, the routing ladder, placement with leases, the streaming proxy, the decision log, a status page, deploy files. |
| B | Anthropic `/v1/messages`, admin recovery endpoints, and the penfield ACP agent for Zed with its Claude branch. |
| C | The model-backed rungs (embedding and classifier) and an eval loop over the decision log. |
| D | A real wait queue, per-caller budgets for an optional Anthropic API key, approval-gated recovery, metrics. |
| E | More nodes, and voice. |

## Layout

```text
packages/penfield/   the service
packages/agent/      the penfield ACP agent (Stage B, not yet created)
rules/               ast-grep rules the struct check runs
docs/specs/          the spec, the playbook, and the options note behind them
```

## Development

Needs Node 24 and pnpm 11.

```bash
pnpm install
pnpm check          # the whole gate; exit 0 means done
pnpm check --bail   # stop at the first failure while iterating
pnpm test:watch
pnpm build          # tsc --build into packages/*/dist
```

`pnpm check` runs [checkride](https://www.npmjs.com/package/checkride): TypeScript, oxlint, ast-grep structure rules, fallow dead-code analysis, vitest with coverage, markdownlint, link checks and cspell. Each check's raw output lands in `.check/`. CI runs the same gate on every push to `main` and every pull request.

Besides holding the module layout, the rules in `rules/` enforce three of the spec's constraints mechanically: no Claude subscription credential anywhere in the code (C2); no classes, `this` or decorators (C6); and no suppression comments (C7).

Releases are cut in Claude Code with `/version patch|minor|major` from the `version` plugin. It bumps the root and every package in lockstep, adds a section to [CHANGELOG.md](./CHANGELOG.md), commits `vX.Y.Z` and tags it. The config is `.claude/version.json`, and the reasons behind it are in [`.claude/version.md`](./.claude/version.md).

## Docs

- [Spec](./docs/specs/first-spec/penfield_first_spec.md): frame, decisions, constraints, interfaces, seams, and the staged build plan.
- [Playbook](./docs/specs/first-spec/playbook.md): preparing the nodes, installing on plato, configuring `penfield.yaml`, wiring Zed and the other tools, operating.
- [Gateway and router options](./docs/specs/first-spec/gateway-and-router-options.md): what exists off the shelf, and why penfield is built instead.
- [AGENTS.md](./AGENTS.md): the contract for coding agents working here.
