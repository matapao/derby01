import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const content = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1];
const policy = new Map(
  (content ?? '')
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .filter((d) => d[0])
    .map(([name = '', ...sources]) => [name, sources.join(' ')]),
);

test('the page keeps scripts its own, and no plugins, base or form posts', () => {
  assert.ok(content, 'index.html has its policy');
  assert.equal(policy.get('script-src'), "'self'");
  assert.equal(policy.get('object-src'), "'none'");
  assert.equal(policy.get('base-uri'), "'none'");
  assert.equal(policy.get('form-action'), "'none'");
});

test("the page server says where the game loads from: a host's sandboxed frame matches 'self' to nothing in Safari", () => {
  // With a 'self' limit here, Safari refused derby01 its own car model and data inside a zirbel host.
  for (const directive of ['default-src', 'connect-src', 'img-src', 'font-src', 'media-src'])
    assert.equal(policy.has(directive), false, directive);
});
