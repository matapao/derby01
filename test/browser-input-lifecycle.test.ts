import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindInputFocusLoss,
  gameControlsActive,
  releaseTouchInput,
  type TouchInputState,
} from '../src/browser-input-lifecycle.ts';
import { createInputState, releaseInput } from '../src/gameplay/input.ts';

function heldTouch(): TouchInputState<{ kind: 'pedal' | 'fire' }> {
  return {
    fingers: new Map([
      [1, { kind: 'pedal' }],
      [2, { kind: 'fire' }],
    ]),
    presses: new Set(['act', 'seat']),
    dirs: ['left', 'up'],
    look: { dx: 14, dy: -8 },
    listTap: { x: 30, y: 50 },
    zoomed: true,
  };
}

function assertReleased(state: TouchInputState<{ kind: 'pedal' | 'fire' }>): void {
  assert.equal(state.fingers.size, 0);
  assert.equal(state.presses.size, 0);
  assert.deepEqual(state.dirs, []);
  assert.deepEqual(state.look, { dx: 0, dy: 0 });
  assert.equal(state.listTap, null);
  assert.equal(state.zoomed, false);
}

test('focus loss cancels held touch gestures together with keyboard and mouse input', () => {
  const focus = new EventTarget();
  const visibility = new EventTarget();
  const touch = heldTouch();
  const input = createInputState();
  input.keys.add('KeyW');
  input.pressed.add('Space');
  input.mouse.buttons = 1;
  const dispose = bindInputFocusLoss(
    focus,
    visibility,
    () => false,
    () => {
      releaseTouchInput(touch);
      releaseInput(input);
    },
  );
  focus.dispatchEvent(new Event('blur'));
  assertReleased(touch);
  assert.equal(input.keys.size, 0);
  assert.equal(input.pressed.size, 0);
  assert.equal(input.mouse.buttons, 0);
  // Cleanup is safe if blur and visibility changes both report the same loss.
  focus.dispatchEvent(new Event('blur'));
  assertReleased(touch);
  dispose();
});

test('hiding a document cancels touch input without synthesizing a pointer cancellation', () => {
  const focus = new EventTarget();
  const visibility = new EventTarget();
  const touch = heldTouch();
  let hidden = false;
  const dispose = bindInputFocusLoss(
    focus,
    visibility,
    () => hidden,
    () => releaseTouchInput(touch),
  );
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(touch.fingers.size, 2, 'visible visibility changes preserve current gestures');
  hidden = true;
  visibility.dispatchEvent(new Event('visibilitychange'));
  assertReleased(touch);
  hidden = false;
  visibility.dispatchEvent(new Event('visibilitychange'));
  assertReleased(touch);
  dispose();
});

test('input focus bindings remove both listeners and tolerate repeated disposal', () => {
  const focus = new EventTarget();
  const visibility = new EventTarget();
  let releases = 0;
  const dispose = bindInputFocusLoss(
    focus,
    visibility,
    () => true,
    () => releases++,
  );
  dispose();
  dispose();
  focus.dispatchEvent(new Event('blur'));
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(releases, 0);
});

test('touch controls close for pause, setup, hidden documents and the online pause menu', () => {
  for (const phase of ['countdown', 'playing', 'over'] as const) {
    assert.equal(gameControlsActive(phase, false, false), true);
    assert.equal(gameControlsActive(phase, true, false), false);
    assert.equal(gameControlsActive(phase, false, true), false);
  }
  for (const phase of ['loading', 'menu', 'paused'] as const)
    assert.equal(gameControlsActive(phase, false, false), false);
});

test('cancelled touch state can accept a fresh gesture without restoring old presses', () => {
  const touch = heldTouch();
  releaseTouchInput(touch);
  touch.fingers.set(3, { kind: 'pedal' });
  assert.deepEqual([...touch.fingers.keys()], [3]);
  assert.equal(touch.presses.size, 0);
  assert.equal(touch.zoomed, false);
  releaseTouchInput(touch);
  assertReleased(touch);
});
