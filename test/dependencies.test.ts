import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runtimeDependencies, cyclicEdges } from '../tools/dependencies.ts';

test('cycle detection finds transitive cycles but ignores a dependency on a leaf', () => {
  assert.deepEqual(cyclicEdges({ a: ['b', 'leaf'], b: ['c'], c: ['a'], leaf: [] }), [
    'a -> b',
    'b -> c',
    'c -> a',
  ]);
  assert.deepEqual(cyclicEdges({ a: ['b'], b: [] }), []);
});
test('the entire runtime graph remains acyclic and rules stay independent', async () => {
  const graph = await runtimeDependencies(fileURLToPath(new URL('..', import.meta.url)));
  const cycles = cyclicEdges(graph);
  assert.deepEqual(cycles, [], 'runtime imports must form a DAG; inject reverse lifecycle calls at main.ts');
  for (const [file, imports] of Object.entries(graph)) {
    if (!file.startsWith('src/gameplay/')) continue;
    assert.ok(
      imports.every((path) => path.startsWith('src/gameplay/')),
      `${file} must not import browser modules or global state: ${imports.join(', ')}`,
    );
  }
  for (const [file, imports] of Object.entries(graph)) {
    if (file !== 'src/main.ts')
      assert.ok(
        !imports.includes('src/flow.ts'),
        `${file} must use the lifecycle port rather than import flow`,
      );
    if (file !== 'src/flow.ts')
      assert.ok(
        !imports.includes('src/net/session.ts'),
        `${file} must use net/context.ts for connection state`,
      );
  }
});
