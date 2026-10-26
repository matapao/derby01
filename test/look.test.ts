// look() draws the town as an SVG the host's small rasteriser can draw: only its elements, attributes
// and colours, quickly, and the same picture every time for the same data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import look from '../src/agent/look.ts';

const ROOT = join(import.meta.dirname, '..');
const json = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const data = {
  town: json('data/town.json'),
  pieces: json('data/pieces.json'),
  prefabs: json('data/prefabs.json'),
  rounds: json('data/rounds.json'),
};

const ELEMENTS = new Set([
  'svg',
  'g',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
]);
const ATTRIBUTES = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'd',
  'fill',
  'stroke',
  'stroke-width',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'fill-rule',
  'transform',
  'style',
  'font-size',
  'text-anchor',
]);
const COLOUR =
  /^(#[0-9a-f]{3}|#[0-9a-f]{6}|none|rgb\(\d+,\s*\d+,\s*\d+\)|black|silver|gray|white|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua)$/i;

test('the plan uses only what the host can draw', () => {
  const { svg, legend } = look(data);
  for (const [, name, attrs] of svg.matchAll(/<([a-z]+)((?:\s+[a-zA-Z:-]+="[^"]*")*)\s*\/?>/g)) {
    assert.ok(ELEMENTS.has(name!), `<${name}> isn't drawn`);
    for (const [, k, v] of attrs!.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) {
      assert.ok(ATTRIBUTES.has(k!), `${k} isn't drawn`);
      if (k === 'fill' || k === 'stroke') assert.match(v!, COLOUR, `${k}="${v}"`);
    }
  }
  assert.doesNotMatch(svg, /<(linearGradient|radialGradient|pattern|filter|mask|clipPath|image|use|style)\b/);
  assert.ok(legend.length >= 10 && legend.every((l) => /^#[0-9a-f]{6}$/.test(l.color)));
  assert.equal(new Set(legend.map((l) => l.color)).size, legend.length, 'every legend colour is its own');
});

test('every legend colour is one the plan uses', () => {
  const { svg, legend } = look(data);
  const used = legend.filter(
    (l) => svg.includes(`fill="${l.color}"`) || svg.includes(`stroke="${l.color}"`),
  ).length;
  assert.ok(used >= legend.length - 4, `${used} of ${legend.length}`); // ramps, pads, walls and the like may be missing from a town
});

test('it is quick, and the same every time', () => {
  look(data);
  const t = performance.now();
  const a = look(data);
  assert.ok(performance.now() - t < 200, "well within the host's 200 ms");
  assert.equal(look(data).svg, a.svg);
});

test('a region shows just that part, in its own scale', () => {
  const { svg } = look(data, { region: [-40, -30, 40, 30] });
  assert.match(svg, /viewBox="-40 -30 /);
  assert.ok(svg.length > 1000);
});

test('without a town it says so instead of failing', () => {
  assert.match(look({}).svg, /No town/);
});

test("a layout can be asked for by id: the hand-made town, or the generator's for a map and cars", () => {
  const generated = { ...data, rounds: { map: 'generated' }, generator: json('data/generator.json') };
  assert.match(look(generated, { layout: 'town-42-6' }).svg, /a generated town: map 42, 6 cars/);
  assert.doesNotMatch(look(generated, { layout: 'town' }).svg, /a generated town/);
  assert.notEqual(look(generated, { layout: 'town-42-6' }).svg, look(generated, { layout: 'town-42-2' }).svg);
});

test('a piece is drawn as its asset looks, whatever it is called', () => {
  const pieces = structuredClone(data.pieces) as { pieces: { id: string; asset: string }[] };
  pieces.pieces.push({ ...pieces.pieces.find((p) => p.id === 'rowan')!, id: 'big-rowan' });
  const town = structuredClone(data.town) as { pieces: { piece: string; x: number; z: number }[] };
  town.pieces.push({ piece: 'big-rowan', x: 0, z: 0 });
  assert.match(
    look({ ...data, pieces, town }, { layout: 'town' }).svg,
    /<circle cx="0" cy="0" r="1.6" fill="#2e6b24"/,
  );
});
