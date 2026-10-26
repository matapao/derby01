import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('README stays concise and pure boundaries do not import browser game modules', () => {
  assert.ok(source('README.md').trimEnd().split('\n').length <= 50, 'move detailed documentation into docs/');
  for (const file of ['src/setup.ts', 'src/net/protocol.ts']) {
    const imports = [...source(file).matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      imports,
      [],
      `${file} is a standalone pure boundary; review dependencies explicitly before expanding it`,
    );
  }
  assert.ok(
    !/from\s*['"]\.\/(?:core|world|car|fx)\.ts['"]/.test(source('src/audio.ts')),
    'audio must remain independent of the renderer and game state',
  );
});

test('strict checking covers the complete browser tree and cannot be selectively disabled', () => {
  const config = JSON.parse(source('tsconfig.json').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.compilerOptions.strict, true);
  for (const flag of [
    'noImplicitAny',
    'strictNullChecks',
    'strictFunctionTypes',
    'strictPropertyInitialization',
  ]) {
    assert.notEqual(config.compilerOptions[flag], false, `${flag} must inherit strict checking`);
  }
  assert.ok(config.include.includes('src'));
  assert.ok(config.include.includes('test/types'));
});
