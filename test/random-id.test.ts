import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomId } from '../src/random-id.ts';

test('playlist ids work on a plain-http host page, where crypto.randomUUID is missing', () => {
  const plain: Pick<Crypto, 'getRandomValues'> = {
    getRandomValues: (array) => crypto.getRandomValues(array),
  };
  const ids = Array.from({ length: 200 }, () => randomId(plain));
  for (const id of ids)
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, ids.length);
  const zero: Pick<Crypto, 'getRandomValues'> = { getRandomValues: (array) => array };
  assert.equal(randomId(zero), '00000000-0000-4000-8000-000000000000');
});
