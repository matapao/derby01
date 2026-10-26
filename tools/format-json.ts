/**
 * Writes JSON files the way data/ keeps them: short things (a point, a placement, a small object)
 * on one line, longer ones opened up, two spaces in.
 *
 *   node tools/format-json.ts data/*.json zirbel.build.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

export function formatJson(v: unknown, indent = ''): string {
  const flat = JSON.stringify(v);
  if (flat.length + indent.length <= 140 || v === null || typeof v !== 'object') return flat;
  const next = indent + '  ';
  if (Array.isArray(v))
    return '[\n' + v.map((x) => next + formatJson(x, next)).join(',\n') + '\n' + indent + ']';
  return (
    '{\n' +
    Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => next + JSON.stringify(k) + ': ' + formatJson(x, next))
      .join(',\n') +
    '\n' +
    indent +
    '}'
  );
}

if (import.meta.main)
  for (const f of process.argv.slice(2))
    writeFileSync(f, formatJson(JSON.parse(readFileSync(f, 'utf8'))) + '\n');
