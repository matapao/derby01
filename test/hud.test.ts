/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindHumanHud } from '../src/hud.ts';

/** Minimal DOM boundary double: the binding itself does not require a renderer or a global document. */
function root(missing = '', invalidCanvas = '', nullContext = ''): HTMLElement {
  return {
    querySelector(selector: string) {
      if (selector === missing) return null;
      if (['.vp-canvas', '.vp-paint', '.vp-map'].includes(selector)) {
        return selector === invalidCanvas ? {} : { getContext: () => (selector === nullContext ? null : {}) };
      }
      return {};
    },
  } as unknown as HTMLElement;
}
test('HUD construction binds canvas contexts and gives each player a separate cache', () => {
  const first = bindHumanHud(root()),
    second = bindHumanHud(root());
  assert.ok(first.ctx);
  assert.ok(first.paintCtx);
  assert.ok(first.map);
  assert.ok(first.feed);
  first.last.hp = '50';
  assert.equal(second.last.hp, undefined);
});
test('HUD markup mistakes fail at construction with the missing selector', () => {
  for (const selector of ['.vp-canvas', '.vp-paint', '.vp-map', '.role', '.vp-pts', '.vp-feed', '.camdata']) {
    assert.throws(() => bindHumanHud(root(selector)), /HUD is missing/);
  }
});
test('non-canvas replacements and unavailable canvas contexts fail explicitly', () => {
  assert.throws(() => bindHumanHud(root('', '.vp-paint')), /must be a canvas/);
  assert.throws(() => bindHumanHud(root('', '', '.vp-canvas')), /requires a 2D context/);
});
