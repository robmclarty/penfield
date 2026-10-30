# AGENTS.md

Instructions for any coding agent working in this repository.

<!-- checkride:begin hash=v1b1ff96acd70b4088 -->

## Checkride: the definition of done

`pnpm check` is the single source of truth for "done". Exit 0 means the work is
complete; any other exit code means it is not. Never claim a task is finished while
`pnpm check` is red.

When it fails:

1. Read `.check/summary.json` to see which check failed.
2. Read that check's raw output: `.check/<slot>.json` or `.jsonl`, `.check/<slot>.stdout.txt`,
   or `.check/<slot>.stderr.txt`, where a check refused before it ran says why. A
   target's check writes under `.check/<target>/` instead.
3. Fix the root cause, then re-run.

`pnpm check --digest` prints a capped excerpt of what failed below its report,
each section naming the raw file that holds the rest, so start from that.

`pnpm exec checkride triage` runs this procedure in full and reads `.check/` for you
(`/checkride:check` and `/checkride-check` are the same thing as a skill).

Tight feedback loops: `pnpm check --bail`, `pnpm check --only types,lint`, and
`pnpm check --changed`.

If a stop-gate hook is configured (`.claude/settings.json` or `.cursor/hooks.json`),
it runs the check when a turn ends — so while iterating, prefer the narrow commands
above rather than running the full check yourself every loop. Read the gate's verdict
rather than assuming it covered everything: a repo can narrow the gate with `gate` in
`checkride.config.json`, and a narrowed one names its narrowing (`only …`, `without …`,
`affected-only`) in every verdict. That green is not the "done" defined above; run
`pnpm check` in full before you claim the work is finished.

### Baseline

If `checkride.baseline.json` is present, checkride grandfathers the diagnostics it
lists: a slot is green as long as only baselined findings remain, while a genuinely
new diagnostic still fails it. Fixing a baselined finding prunes it from the file —
the ratchet, so the baseline only ever shrinks. Never add to the baseline to make a
check pass; fix the finding.

### Module boundaries

The `struct` check runs whatever ast-grep rules `sgconfig.yml` points at
(`rules/` by default). Those files are this repo's boundary convention —
read them rather than assuming one.

Active checks in this repo: types, lint, struct, dead, test, docs, links, spell, typecheck-tests.

<!-- checkride:end -->

## Penfield

A model gateway and router: one service, one settings file (`penfield.yaml`), requests
in the OpenAI and Anthropic wire formats forwarded unchanged to the node that has the
model. The governing spec is
[`docs/specs/first-spec/penfield_first_spec.md`](./docs/specs/first-spec/penfield_first_spec.md).
Its decisions (§3) are settled: re-open one in a spike, not inside a change. Read order
when returning cold: §1 Frame → §4 Constraints → §7 Seams → the current stage in §8.

### Constraints the code holds

The spec's §4 is the full list; the reviewer checks every one. These are the ones a
change is most likely to break:

- **C1, proxy, don't translate.** Forward the body in the format it arrived in and
  rewrite `model`, nothing else. A node that lacks the incoming format is a refused
  candidate.
- **C2, no subscription credential, anywhere.** Never read, store, forward or log a
  Claude OAuth token or session file; a Claude target is a decision, not an execution.
  The `no-subscription-credentials` rule blocks the names.
- **C3, no model call in placement.** The classifier rung (Stage C) is the only model
  call in the routing path.
- **C4, stream, never buffer.** Read the request body once; pipe the response.
- **C6, functional TypeScript.** No `class`, `this`, `extends` or decorators (`no-class`,
  `no-this`, `no-decorator`). Config is parsed once with zod and passed down; no
  ambient singletons.
- **C7, no silenced findings.** No `any`, no `@ts-ignore`, no suppression comments
  (`no-suppression-comments`).
- **C11, fail closed.** An unknown caller, or a target above the caller's privacy, is a
  403 with a reason, never a silent downgrade.

### Layout and conventions

- `packages/penfield/` is the service, with the seams of spec §7 under `src/`
  (`config/`, `catalogue/`, `probe/`, `place/`, `route/`, `wire/`, `log/`, `ui/`,
  `cli.ts`). `packages/agent/`, the ACP agent, arrives in Stage B.
- snake_case for files, functions and values, as the spec names them
  (`discover_ollama.ts`, `route_endpoint.ts`); PascalCase for types. Named exports
  only; relative imports end in `.js`.
- Unit tests sit beside their code in `src/**/__tests__/<name>.test.ts`. Tests that
  span modules go in `packages/<pkg>/test/integration/` or `test/e2e/`. Fakes and
  shared helpers go in `test/helpers/`, including the spec's fake Ollama and fake
  OpenAI servers. Data goes in `test/fixtures/`. The `test-dir-layout` rule admits
  nothing else under `test/`.
