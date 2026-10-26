// Every block is valid against its schema, every schema passes the checks the host makes when it
// imports a game, and the data the schemas can't check (references, orders of values) holds too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { lint, validate, type Schema } from '../src/blocks/validate.ts';
import check from '../src/agent/check.ts';

const ROOT = join(import.meta.dirname, '..');
const json = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const manifest = json('zirbel.build.json') as {
  blocks: { id: string; file: string; schema: string }[];
  assets: string;
};
const load = (p: string): Schema | undefined => {
  try {
    return json(p) as Schema;
  } catch {
    return undefined;
  }
};

test('every block fits its schema', () => {
  for (const b of manifest.blocks) {
    const { problems } = validate(json(b.schema) as Schema, json(b.file), { file: b.schema, load });
    assert.deepEqual(problems, [], `${b.file}`);
  }
});

test('the asset catalogue fits its schema', () => {
  const { problems } = validate(json('assets/assets.schema.json') as Schema, json(manifest.assets), {
    file: 'assets/assets.schema.json',
    load,
  });
  assert.deepEqual(problems, []);
});

test('catalogued asset files are shipped with their declared byte sizes', () => {
  const assets = json(manifest.assets) as { id: string; file: string | null; bytes: number }[];
  for (const asset of assets) {
    if (asset.file === null) continue;
    const file = statSync(join(ROOT, asset.file));
    assert.ok(file.isFile(), `${asset.id} must name a shipped file`);
    assert.equal(file.size, asset.bytes, `${asset.id} byte size`);
  }
});

test('every schema uses only what the host understands, and describes and bounds every field', () => {
  const files = readdirSync(join(ROOT, 'data'))
    .filter((f) => f.endsWith('.schema.json'))
    .map((f) => 'data/' + f);
  for (const f of [...files, 'assets/assets.schema.json']) assert.deepEqual(lint(json(f) as Schema), [], f);
});

test('the manifest lists every block in data/', () => {
  const listed = new Set(manifest.blocks.map((b) => b.file));
  const files = readdirSync(join(ROOT, 'data'))
    .filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'))
    .map((f) => 'data/' + f);
  for (const f of files) assert.ok(listed.has(f), `${f} is not a block in zirbel.build.json`);
});

test('the game-specific checks find nothing wrong with the shipped data', () => {
  const data = Object.fromEntries(manifest.blocks.map((b) => [b.id, json(b.file)]));
  const { problems, counts } = check(data);
  assert.deepEqual(problems, []);
  assert.ok(counts && counts['pieces']! > 30, 'the town has its pieces');
});

test('a bad block is caught, with a pointer to the bad value', () => {
  const kits = structuredClone(json('data/kits.json')) as { kits: { handling: { grip: number } }[] };
  kits.kits[1]!.handling.grip = 9;
  const { problems } = validate(json('data/kits.schema.json') as Schema, kits, {
    file: 'data/kits.schema.json',
    load,
  });
  assert.deepEqual(problems, [{ path: '/kits/1/handling/grip', message: 'should be at most 1.3' }]);
});

test('references to other blocks are collected for the host', () => {
  const { refs } = validate(json('data/layout.schema.json') as Schema, json('data/town.json'), {
    file: 'data/layout.schema.json',
    load,
  });
  assert.ok(refs.length > 30);
  assert.ok(refs.every((r) => r.block === 'pieces' && r.path.startsWith('/pieces/')));
});
