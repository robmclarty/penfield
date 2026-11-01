import { describe, expect, test } from 'vitest';

import { merge_catalogue } from '../../catalogue/index.js';
import type { Discovery } from '../../catalogue/index.js';
import { format_issues, load_config } from '../../config/index.js';
import { place } from '../../place/index.js';
import type { RouteInput, RoutedProfile } from '../../route/index.js';
import type { Caller } from '../auth.js';
import { send_error } from '../errors.js';
import { models_list } from '../openai.js';
import { check_policy } from '../policy.js';
import { create_server } from '../server.js';

const AT = '2026-10-31T12:00:00.000Z';

// searle is lan with the two chat models; cloudbox is a cloud copy of the 35B, so
// one tag sits at two privacy classes; claude is a decision node.
const loaded = load_config(`version: 1
nodes:
  searle: { kind: ollama, url: http://searle.test:11434, privacy: lan }
  cloudbox: { kind: openai_compatible, url: https://cloudbox.test/v1, privacy: cloud, discover: false, models: [qwen3.6:35b-mlx] }
  claude: { kind: claude_decision, models: [sonnet, opus] }
profiles:
  chat: { candidates: [qwen3.6:35b-mlx, qwen3.8:27b-mlx, claude/sonnet@low] }
callers:
  rob:         { max_privacy: cloud }
  night-shift: { max_privacy: lan }
  kiosk:       { max_privacy: local }
  nurselog:    { max_privacy: lan, models: [qwen3.8:27b-mlx] }
`);
if (!loaded.ok) throw new Error(format_issues('penfield.yaml', loaded.issues));
const { config } = loaded;

const searle: Discovery = {
  node: 'searle',
  state: 'up',
  models: ['qwen3.8:27b-mlx', 'qwen3.6:35b-mlx'].map((id) => ({ id, node: 'searle', residency: 'resident', size_bytes: 16e9, context_length: null })),
};

const catalogue = merge_catalogue(config, {
  seen: { searle: { discovery: searle, at: AT }, cloudbox: { discovery: { node: 'cloudbox', state: 'up', models: [] }, at: AT } },
  breakers: { nodes: {}, models: {} },
});

const caller = (name: string): Caller => {
  const policy = config.callers[name];
  if (policy === undefined) throw new Error(`no caller ${name}`);
  return { ...policy, name };
};

const named = (model: string): RoutedProfile => ({ kind: 'model', model, rung: 'explicit', confidence: 1, reasons: [`explicit: "${model}" is in the catalogue`] });

const input_for = (name: string, model: string): RouteInput => ({
  request_id: 'req-1',
  caller: caller(name),
  format: 'openai',
  endpoint: 'chat',
  model,
  text: 'hello',
  system_text: '',
  history_turns: 0,
  tokens_estimate: 2,
  tools: false,
  attachments: 'none',
  hints: {},
});

const placed = (name: string, routed: RoutedProfile) =>
  place(check_policy(routed, caller(name), catalogue).routed, input_for(name, 'x'), catalogue, {}, config, { id: 'dec-1', at: AT });

describe('a named model the caller may not use fails closed (C11)', () => {
  test("a model above the caller's max_privacy is refused with the reason, and placement keeps the refusal", () => {
    const checked = check_policy(named('claude/opus'), caller('night-shift'), catalogue);
    const reason = 'caller night-shift may not use "claude/opus": node claude is cloud, above its max_privacy lan';
    expect(checked).toEqual({
      forbidden: true,
      routed: {
        kind: 'refused',
        reason,
        rung: 'explicit',
        confidence: 1,
        reasons: ['explicit: "claude/opus" is in the catalogue', `policy: refused: ${reason}`],
      },
    });
    // Never a silent downgrade: no other model takes its place.
    expect(placed('night-shift', named('claude/opus'))).toMatchObject({
      target: { kind: 'refused', reason },
      alternatives: [],
      reasons: checked.routed.reasons,
    });
  });

  test("a model outside the caller's models list is refused with the reason (D38)", () => {
    expect(check_policy(named('qwen3.6:35b-mlx'), caller('nurselog'), catalogue)).toMatchObject({
      forbidden: true,
      routed: {
        kind: 'refused',
        reason: `caller nurselog may not use "qwen3.6:35b-mlx": it is not in the caller's models list; node cloudbox is cloud, above its max_privacy lan`,
      },
    });
    expect(placed('nurselog', named('qwen3.6:35b-mlx')).target.kind).toBe('refused');
  });

  test('a tag on two nodes is refused only when the caller may use neither, naming both', () => {
    expect(check_policy(named('qwen3.6:35b-mlx'), caller('kiosk'), catalogue)).toMatchObject({
      forbidden: true,
      routed: {
        reason: 'caller kiosk may not use "qwen3.6:35b-mlx": node searle is lan, above its max_privacy local; node cloudbox is cloud, above its max_privacy local',
      },
    });
    // One node it may use is enough, and placement chooses only among those (D6).
    expect(check_policy(named('qwen3.6:35b-mlx'), caller('night-shift'), catalogue).forbidden).toBe(false);
    expect(placed('night-shift', named('qwen3.6:35b-mlx')).target).toEqual({ kind: 'proxy', node: 'searle', model: 'qwen3.6:35b-mlx', format: 'openai' });
  });

  test('a model the caller may use passes untouched', () => {
    const routed = named('qwen3.8:27b-mlx');
    expect(check_policy(routed, caller('nurselog'), catalogue)).toEqual({ routed, forbidden: false });
    expect(check_policy(named('claude/opus'), caller('rob'), catalogue).forbidden).toBe(false);
  });

  test('an auto, alias or profile route passes untouched, for placement to filter (D38)', () => {
    const chat: RoutedProfile = { kind: 'profile', profile: 'chat', rung: 'rule', confidence: 1, reasons: [] };
    expect(check_policy(chat, caller('nurselog'), catalogue)).toEqual({ routed: chat, forbidden: false });
    expect(placed('nurselog', chat).target).toMatchObject({ kind: 'proxy', model: 'qwen3.8:27b-mlx' });
  });
});

describe('/v1/models and the 403 read the same rule', () => {
  test.each(['rob', 'night-shift', 'kiosk', 'nurselog'])('%s is refused exactly the models it is not shown', (name) => {
    const listed = new Set(
      models_list(catalogue, config, caller(name)).data.flatMap(({ penfield }) => (penfield.kind === 'model' ? [penfield.ref] : [])),
    );
    for (const model of catalogue.models) {
      const forbidden = check_policy(named(model.ref), caller(name), catalogue).forbidden;
      expect([model.ref, forbidden]).toEqual([model.ref, !listed.has(model.ref)]);
    }
  });
});

describe("the endpoint's answer", () => {
  test('a named model the caller may not use leaves as a 403 with the reason and the decision id', async () => {
    const tokens = new Map([['tok_night-shift_1c8e6f2b', 'night-shift']]);
    const app = create_server({ config, tokens, snapshot: () => catalogue, in_use: () => ({}) });
    // What an endpoint that takes a model does: check, place, and send the refusal.
    app.post<{ Params: { model: string } }>('/named/:model', (request, reply) => {
      const routed = named(decodeURIComponent(request.params.model));
      const decision = placed('night-shift', routed);
      const { forbidden } = check_policy(routed, caller('night-shift'), catalogue);
      return forbidden && decision.target.kind === 'refused'
        ? send_error(reply, 'forbidden', decision.target.reason, decision.id)
        : reply.send(decision);
    });
    const headers = { authorization: 'Bearer tok_night-shift_1c8e6f2b' };
    const response = await app.inject({ method: 'POST', url: `/named/${encodeURIComponent('claude/opus')}`, headers });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        message: 'caller night-shift may not use "claude/opus": node claude is cloud, above its max_privacy lan',
        code: 'forbidden',
        decision_id: 'dec-1',
      },
    });
    const allowed = await app.inject({ method: 'POST', url: '/named/qwen3.8:27b-mlx', headers });
    expect(allowed.json()).toMatchObject({ target: { kind: 'proxy', node: 'searle', model: 'qwen3.8:27b-mlx' } });
    await app.close();
  });
});
