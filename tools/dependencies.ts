/** Read the runtime import graph after esbuild erases type-only imports. Never emits files. */
import { readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { build } from 'esbuild';

export type DependencyGraph = Record<string, string[]>;
export async function runtimeDependencies(root: string): Promise<DependencyGraph> {
  const entryPoints = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => join('src', name));
  const result = await build({
    absWorkingDir: root,
    entryPoints,
    outdir: '.dependency-check',
    write: false,
    bundle: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  });
  const graph: DependencyGraph = {};
  for (const output of Object.values(result.metafile!.outputs)) {
    if (!output.entryPoint) continue;
    graph[output.entryPoint] = [
      ...new Set(
        output.imports
          .filter((entry) => entry.path.startsWith('.'))
          .map((entry) => normalize(join(dirname(output.entryPoint!), entry.path)).replaceAll('\\', '/')),
      ),
    ];
  }
  return graph;
}
export function cyclicEdges(graph: DependencyGraph): string[] {
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph[from] ?? []).some((next) => reaches(next, target, seen));
  };
  return Object.entries(graph)
    .flatMap(([from, imports]) => imports.filter((to) => reaches(to, from)).map((to) => `${from} -> ${to}`))
    .sort();
}
