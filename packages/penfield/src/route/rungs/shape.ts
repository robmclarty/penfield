import type { Endpoint, RouteInput, RungResult } from '../types.js';

// D35: the shape rung answers from the endpoint alone, at 1.0. A chat endpoint has
// no shape of its own and passes to the rules.
const SHAPES: Partial<Record<Endpoint, string>> = {
  embeddings: 'embed',
  audio_transcriptions: 'stt',
  audio_speech: 'tts',
};

export const shape = ({ endpoint }: RouteInput): RungResult => {
  const profile = SHAPES[endpoint];
  return profile === undefined
    ? { kind: 'pass', reason: null }
    : { kind: 'answer', profile, confidence: 1, reason: `shape: the ${endpoint} endpoint is ${profile}` };
};
