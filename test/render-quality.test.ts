import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRenderQuality,
  isRenderMode,
  renderDimensions,
  RENDER_BUDGETS,
} from '../src/render-quality.ts';

function run(quality: ReturnType<typeof createRenderQuality>, fps: number, seconds: number): number {
  let changes = 0;
  for (let frame = 0; frame < fps * seconds; frame++) if (quality.observe(1 / fps, true)) changes++;
  return changes;
}

test('the default is crisp at CSS resolution without exceeding its GPU pixel budget', () => {
  const laptop = renderDimensions(1280, 720, RENDER_BUDGETS.auto);
  assert.equal(laptop.pixelRatio, 1);
  assert.equal(laptop.bufferWidth, 1280);
  assert.equal(laptop.bufferHeight, 720);
  for (const [width, height] of [
    [1920, 1080],
    [3840, 2160],
    [2560, 1080],
    [768, 1366],
  ]) {
    const size = renderDimensions(width ?? 1, height ?? 1, RENDER_BUDGETS.auto);
    assert.ok(size.pixelRatio <= 1);
    assert.ok(size.bufferWidth * size.bufferHeight <= RENDER_BUDGETS.auto);
    assert.ok(Math.abs(size.bufferWidth / size.bufferHeight - (width ?? 1) / (height ?? 1)) < 0.01);
  }
});

test('performance and sharp settings have explicit bounded costs', () => {
  const quality = createRenderQuality();
  assert.equal(quality.mode, 'auto');
  assert.equal(quality.budget, 1_000_000);
  quality.setMode('performance');
  assert.equal(quality.budget, 650_000);
  assert.equal(run(quality, 60, 30), 0);
  quality.setMode('sharp');
  assert.equal(quality.budget, 1_500_000);
  assert.equal(run(quality, 20, 30), 0);
  for (const value of ['auto', 'performance', 'sharp']) assert.equal(isRenderMode(value), true);
  for (const value of [null, 'constructor', 'high', '']) assert.equal(isRenderMode(value), false);
});

test('sustained low frame rates reduce cost without dropping below the performance floor', () => {
  const quality = createRenderQuality();
  assert.equal(run(quality, 30, 3), 0);
  assert.equal(quality.budget, 1_000_000);
  assert.ok(run(quality, 30, 3) >= 1);
  assert.equal(quality.budget, 825_000);
  assert.equal(run(quality, 30, 3), 0, 'cooldown prevents immediate repeated resolution changes');
  run(quality, 30, 40);
  assert.equal(quality.budget, 650_000);
  assert.equal(run(quality, 20, 30), 0);
});

test('sustained headroom recovers detail while middling frame rates do not oscillate', () => {
  const quality = createRenderQuality();
  run(quality, 30, 30);
  assert.equal(quality.budget, 650_000);
  assert.equal(run(quality, 48, 30), 0);
  assert.equal(quality.budget, 650_000);
  assert.equal(run(quality, 60, 8), 0);
  assert.ok(run(quality, 60, 30) >= 1);
  assert.equal(quality.budget, 1_000_000);
});

test('menu pauses and invalid timing do not count toward sustained load', () => {
  const quality = createRenderQuality();
  run(quality, 30, 3);
  quality.observe(1 / 30, false);
  assert.equal(run(quality, 30, 3), 0);
  for (const dt of [0, -1, NaN, Infinity, 2]) assert.equal(quality.observe(dt, true), false);
  assert.equal(quality.budget, 1_000_000);
  quality.setMode('performance');
  quality.setMode('auto');
  assert.equal(quality.budget, 1_000_000);
});

test('minimized and malformed dimensions remain finite; invalid budgets fail explicitly', () => {
  for (const value of [0, -100, NaN, Infinity]) {
    const size = renderDimensions(value, value, RENDER_BUDGETS.auto);
    assert.ok(size.bufferWidth >= 1 && size.bufferHeight >= 1);
    assert.ok(Number.isFinite(size.pixelRatio));
  }
  for (const budget of [0, -1, NaN, Infinity])
    assert.throws(() => renderDimensions(1280, 720, budget), RangeError);
});
