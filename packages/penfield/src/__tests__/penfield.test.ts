import { expect, test } from 'vitest';

import { PENFIELD } from '../index.js';

test('penfield smoke', () => {
  expect(PENFIELD).toBe('penfield');
});
