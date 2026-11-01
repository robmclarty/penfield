import type { Answer } from '../types.js';

// D35: when no rung above clears the threshold, `chat` at 0.5. That is below the
// threshold, and it stands only because no rung sits beneath it.
export const by_default = (): Answer => ({
  kind: 'answer',
  profile: 'chat',
  confidence: 0.5,
  reason: 'default: no rung above cleared the threshold, so chat',
});
