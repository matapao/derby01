import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AREA_FILL, GRAIN_TILE, GROUND_PX, paintGround, type GroundContext } from '../src/ground-paint.ts';
import { generateLayout, mulberry32, type Recipe } from '../src/layout.ts';
import { fromPlan } from '../src/town/from-plan.ts';
import type { Layout } from '../src/town/types.ts';

type Style = string | CanvasGradient | CanvasPattern;

/** Records every canvas call, and the fill style each fill used. */
class CanvasCalls implements GroundContext {
  fillStyle: Style = '#000';
  strokeStyle: Style = '#000';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  readonly calls: string[] = [];
  readonly fills: Style[] = [];
  fillRect(): void {
    this.calls.push('fillRect');
    this.fills.push(this.fillStyle);
  }
  fill(): void {
    this.calls.push('fill');
    this.fills.push(this.fillStyle);
  }
  beginPath(): void {
    this.calls.push('beginPath');
  }
  closePath(): void {
    this.calls.push('closePath');
  }
  moveTo(): void {
    this.calls.push('moveTo');
  }
  lineTo(): void {
    this.calls.push('lineTo');
  }
  arc(): void {
    this.calls.push('arc');
  }
  ellipse(): void {
    this.calls.push('ellipse');
  }
  stroke(): void {
    this.calls.push('stroke');
  }
  clip(): void {
    this.calls.push('clip');
  }
  save(): void {
    this.calls.push('save');
  }
  restore(): void {
    this.calls.push('restore');
  }
  translate(): void {
    this.calls.push('translate');
  }
  rotate(): void {
    this.calls.push('rotate');
  }
  setLineDash(): void {
    this.calls.push('setLineDash');
  }
  createRadialGradient(): CanvasGradient {
    this.calls.push('createRadialGradient');
    return { addColorStop: () => undefined };
  }
}

const office = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'data', 'town.json'), 'utf8'),
) as Layout;

function paint(town: Layout, px: number) {
  const ground = new CanvasCalls(),
    tiles: { side: number; calls: number }[] = [];
  paintGround(ground, town, {
    px,
    dropPads: [{ x: 10, z: -20 }],
    random: mulberry32(11),
    pattern: (side, draw) => {
      const tile = new CanvasCalls();
      draw(tile);
      tiles.push({ side, calls: tile.calls.length });
      return { setTransform: () => undefined };
    },
  });
  return { ground, tiles, total: ground.calls.length + tiles.reduce((sum, t) => sum + t.calls, 0) };
}

test('the office ground is painted in a bounded number of canvas calls', () => {
  // Dot by dot, its grain alone took some 165,000 calls, and on iPhones the ground came out as plain grass.
  const { ground, tiles, total } = paint(office, GROUND_PX);
  assert.ok(total < 10_000, `${total} canvas calls`);
  assert.ok(tiles.length > 0 && tiles.every((t) => t.side === GRAIN_TILE));
  // the grass first, then the tarmac, car parks and pavements over it
  assert.equal(ground.fills[0], AREA_FILL.grass);
  for (const surface of [AREA_FILL.road, AREA_FILL.lot, AREA_FILL.pave])
    assert.ok(ground.fills.includes(surface));
});

test('painting the ground takes the same canvas calls at any resolution', () => {
  const recipe = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'data', 'generator.json'), 'utf8'),
  ) as Recipe;
  const generated = fromPlan(generateLayout(8411, 8, recipe), 8, recipe.pieces); // with a park
  assert.ok(generated.ground?.some((a) => a.surface === 'grass'));
  for (const town of [office, generated])
    assert.equal(paint(town, GROUND_PX * 2).total, paint(town, GROUND_PX / 2).total);
});
