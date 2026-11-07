import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawPaintLayer,
  fadeCameraPaint,
  paintViewSurface,
  wipeShieldPaint,
  type PaintLayerContext,
  type PaintSurface,
  type WipeContext,
} from '../src/paint-view.ts';

interface DrawState {
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
}

type Operation =
  | { kind: 'image'; image: CanvasImageSource; alpha: number }
  | { kind: 'clear'; bounds: number[] }
  | {
      kind: 'fill';
      bounds: number[];
      alpha: number;
      composite: GlobalCompositeOperation;
      style: DrawState['fillStyle'];
    }
  | { kind: 'path' }
  | { kind: 'arc'; x: number; y: number; r: number }
  | { kind: 'close' }
  | { kind: 'paint'; alpha: number; composite: GlobalCompositeOperation; style: DrawState['fillStyle'] }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'line'; x: number; y: number }
  | { kind: 'stroke'; alpha: number; style: DrawState['strokeStyle']; width: number; cap: CanvasLineCap };

function canvasTrace() {
  const operations: Operation[] = [];
  const stack: DrawState[] = [];
  const initial: DrawState = {
    globalAlpha: 0.37,
    globalCompositeOperation: 'source-over',
    fillStyle: '#246',
    strokeStyle: '#468',
    lineWidth: 7,
    lineCap: 'square',
  };
  function state(): DrawState {
    return {
      globalAlpha: context.globalAlpha,
      globalCompositeOperation: context.globalCompositeOperation,
      fillStyle: context.fillStyle,
      strokeStyle: context.strokeStyle,
      lineWidth: context.lineWidth,
      lineCap: context.lineCap,
    };
  }
  const context: PaintLayerContext & WipeContext = {
    ...initial,
    save() {
      stack.push(state());
    },
    restore() {
      const saved = stack.pop();
      assert.ok(saved, 'each restore must have a matching save');
      Object.assign(context, saved);
    },
    clearRect(...bounds) {
      operations.push({ kind: 'clear', bounds });
    },
    drawImage(image) {
      operations.push({ kind: 'image', image, alpha: context.globalAlpha });
    },
    fillRect(...bounds) {
      operations.push({
        kind: 'fill',
        bounds,
        alpha: context.globalAlpha,
        composite: context.globalCompositeOperation,
        style: context.fillStyle,
      });
    },
    beginPath() {
      operations.push({ kind: 'path' });
    },
    moveTo(x, y) {
      operations.push({ kind: 'move', x, y });
    },
    arc(x, y, r) {
      operations.push({ kind: 'arc', x, y, r });
    },
    closePath() {
      operations.push({ kind: 'close' });
    },
    fill() {
      operations.push({
        kind: 'paint',
        alpha: context.globalAlpha,
        composite: context.globalCompositeOperation,
        style: context.fillStyle,
      });
    },
    lineTo(x, y) {
      operations.push({ kind: 'line', x, y });
    },
    stroke() {
      operations.push({
        kind: 'stroke',
        alpha: context.globalAlpha,
        style: context.strokeStyle,
        width: context.lineWidth,
        cap: context.lineCap,
      });
    },
  };
  return {
    context,
    operations,
    assertRestored() {
      assert.deepEqual(state(), initial);
      assert.equal(stack.length, 0, 'drawing must not leak saved canvas state');
    },
  };
}

function surface(): PaintSurface {
  // Identity-only canvas fixtures: the adapter passes these through without reading DOM properties.
  const paint = {} as HTMLCanvasElement;
  const crack = {} as HTMLCanvasElement;
  return {
    cv: paint,
    w: 100,
    h: 50,
    cover: 0.5,
    ang: 0,
    wipers: [{ x: 10, y: 20, len: 30 }],
    crack: { cv: crack, level: 1 },
  };
}

test('paint surfaces follow active seats without duplicating cockpit windshield effects', () => {
  assert.equal(paintViewSurface(0, 'chase', true), 'shield');
  assert.equal(paintViewSurface(0, 'cockpit', true), null);
  assert.equal(paintViewSurface(0, 'unknown', true), null);
  for (const mode of ['chase', 'cockpit', 'unknown']) {
    assert.equal(paintViewSurface(1, mode, true), 'hood');
    assert.equal(paintViewSurface(2, mode, true), 'trunk');
    assert.equal(paintViewSurface(3, mode, true), null);
  }
  for (const seat of [0, 1, 2, 3, -1, 4, NaN, Infinity]) {
    assert.equal(paintViewSurface(seat, 'chase', false), null);
    if (seat < 0 || seat > 3 || !Number.isFinite(seat))
      assert.equal(paintViewSurface(seat, 'chase', true), null);
  }
});

test('camera feeds retain lens paint but never draw cracks or wipers, even with contaminated state', () => {
  const trace = canvasTrace();
  const lens = surface();
  drawPaintLayer(trace.context, lens, 640, 360, false);
  assert.deepEqual(trace.operations, [{ kind: 'image', image: lens.cv, alpha: 0.94 }]);
  trace.assertRestored();
});

test('the driver windshield retains cracks, painted glass and scaled moving blades', () => {
  const trace = canvasTrace();
  const shield = surface();
  drawPaintLayer(trace.context, shield, 200, 100, true);
  const images = trace.operations.filter((operation) => operation.kind === 'image');
  assert.equal(images.length, 2);
  assert.equal(images[0]?.image, shield.crack?.cv, 'cracks remain beneath windshield paint');
  assert.equal(images[1]?.image, shield.cv);
  assert.equal(images[1]?.alpha, 0.8);
  const strokes = trace.operations.filter((operation) => operation.kind === 'stroke');
  assert.deepEqual(strokes, [
    { kind: 'stroke', alpha: 1, style: 'rgba(10,10,12,0.9)', width: 3, cap: 'round' },
    { kind: 'stroke', alpha: 1, style: 'rgba(255,255,255,0.22)', width: 1, cap: 'round' },
  ]);
  const moves = trace.operations.filter((operation) => operation.kind === 'move');
  const lines = trace.operations.filter((operation) => operation.kind === 'line');
  assert.deepEqual(moves, [
    { kind: 'move', x: 20, y: 40 },
    { kind: 'move', x: 18, y: 39 },
  ]);
  assert.equal(lines.length, 2);
  assert.ok(Math.abs((lines[0]?.x ?? Infinity) + 40) < 1e-10);
  assert.ok(Math.abs((lines[0]?.y ?? Infinity) - 40) < 1e-10);
  shield.ang = Math.PI / 2;
  const rotated = canvasTrace();
  drawPaintLayer(rotated.context, shield, 200, 100, true);
  const endpoint = rotated.operations.find((operation) => operation.kind === 'line');
  assert.ok(endpoint?.kind === 'line');
  assert.ok(Math.abs(endpoint.x - 20) < 1e-10);
  assert.ok(Math.abs(endpoint.y + 20) < 1e-10);
  trace.assertRestored();
  rotated.assertRestored();
});

test('clean driver glass has no crack image and keeps its fainter wiper blades', () => {
  const trace = canvasTrace();
  const shield = surface();
  shield.cover = 0;
  if (shield.crack) shield.crack.level = 0;
  drawPaintLayer(trace.context, shield, 200, 100, true);
  assert.equal(trace.operations.filter((operation) => operation.kind === 'image').length, 1);
  assert.equal(
    trace.operations.find((operation) => operation.kind === 'stroke')?.style,
    'rgba(10,10,12,0.5)',
  );
  trace.assertRestored();
});

test('camera paint fades uniformly with frame-rate independent retention and bounded resume jumps', () => {
  const trace = canvasTrace();
  const once = fadeCameraPaint(trace.context, 320, 180, 0.7, 0.1);
  assert.ok(once > 0 && once < 0.7);
  assert.equal(trace.operations.length, 1);
  const fill = trace.operations[0];
  assert.ok(fill?.kind === 'fill');
  assert.deepEqual(fill.bounds, [0, 0, 320, 180]);
  assert.equal(fill.composite, 'destination-out');
  assert.equal(fill.alpha, 1);
  assert.match(String(fill.style), /^rgba\(0,0,0,0\./);
  const halves = canvasTrace();
  const half = fadeCameraPaint(halves.context, 320, 180, 0.7, 0.05);
  const twice = fadeCameraPaint(halves.context, 320, 180, half, 0.05);
  assert.ok(Math.abs(once - twice) < 1e-12);
  const resumed = canvasTrace();
  const capped = canvasTrace();
  assert.equal(
    fadeCameraPaint(resumed.context, 320, 180, 0.7, 100),
    fadeCameraPaint(capped.context, 320, 180, 0.7, 0.25),
  );
  assert.deepEqual(resumed.operations, capped.operations);
  assert.ok(fadeCameraPaint(trace.context, 320, 180, 2, 0.1) < 1);
  trace.assertRestored();
  halves.assertRestored();
  resumed.assertRestored();
  capped.assertRestored();
});

test('paused or malformed timing never mutates camera paint; tiny residue clears completely', () => {
  for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
    const trace = canvasTrace();
    assert.equal(fadeCameraPaint(trace.context, 320, 180, 0.5, dt), 0.5);
    assert.deepEqual(trace.operations, []);
    trace.assertRestored();
  }
  for (const cover of [0, -1, NaN, Infinity]) {
    const trace = canvasTrace();
    assert.ok(Object.is(fadeCameraPaint(trace.context, 320, 180, cover, 0.1), cover));
    assert.deepEqual(trace.operations, []);
    trace.assertRestored();
  }
  const trace = canvasTrace();
  assert.equal(fadeCameraPaint(trace.context, 320, 180, 0.002, 0.1), 0);
  assert.deepEqual(trace.operations, [{ kind: 'clear', bounds: [0, 0, 320, 180] }]);
  trace.assertRestored();
});

const shieldGlass = (cover: number) => ({
  w: 448,
  h: 208,
  cover,
  wipers: [
    { x: 90, y: 214, len: 190 },
    { x: 270, y: 214, len: 170 },
  ],
});

test('windshield paint stays put until a wiper blade sweeps over it', () => {
  for (const [from, to] of [
    [2, 2],
    [2, 2 + 1e-6],
    [NaN, 2],
    [2, NaN],
  ] as const) {
    const trace = canvasTrace();
    assert.equal(wipeShieldPaint(trace.context, shieldGlass(0.4), from, to), 0.4);
    assert.deepEqual(trace.operations, []);
    trace.assertRestored();
  }
  const trace = canvasTrace();
  assert.equal(wipeShieldPaint(trace.context, { ...shieldGlass(0.4), wipers: [] }, 1.3, 3), 0.4);
  trace.assertRestored();
});

test('the wipers only erase the paint they sweep, and one sweep leaves most of it', () => {
  const trace = canvasTrace();
  const cover = wipeShieldPaint(trace.context, shieldGlass(0.4), 1.3, 3);
  assert.ok(cover < 0.4 && cover > 0.3, `${cover} cover left after one sweep`);
  const paints = trace.operations.filter((operation) => operation.kind === 'paint');
  assert.equal(paints.length, 4, 'one blade pass and its streaks per wiper');
  for (const paint of paints) assert.equal(paint.composite, 'destination-out');
  assert.deepEqual(
    paints.map((paint) => paint.style),
    ['rgba(0,0,0,0.2)', 'rgba(0,0,0,0.12)', 'rgba(0,0,0,0.2)', 'rgba(0,0,0,0.12)'],
  );
  for (const operation of trace.operations)
    if (operation.kind === 'arc') assert.ok([90, 270].includes(operation.x) && operation.y === 214);
  assert.equal(
    trace.operations.some((operation) => operation.kind === 'fill' || operation.kind === 'clear'),
    false,
    'nothing clears the glass outright',
  );
  // sweeping back the other way erases the same arc
  const back = canvasTrace();
  assert.equal(wipeShieldPaint(back.context, shieldGlass(0.4), 3, 1.3), cover);
  assert.deepEqual(back.operations, trace.operations);
  trace.assertRestored();
  back.assertRestored();
});

test('a few seconds of wiping thin heavy windshield paint gradually', () => {
  const trace = canvasTrace();
  let cover = 0.6;
  for (let sweep = 0; sweep < 4; sweep++)
    cover = wipeShieldPaint(trace.context, shieldGlass(cover), sweep % 2 ? 3 : 1.3, sweep % 2 ? 1.3 : 3);
  assert.ok(cover > 0.3 && cover < 0.6, `${cover} cover left after four sweeps`);
  const tiny = canvasTrace();
  assert.equal(wipeShieldPaint(tiny.context, shieldGlass(0.002), 1.3, 3), 0);
  assert.deepEqual(tiny.operations, []);
  trace.assertRestored();
  tiny.assertRestored();
});
