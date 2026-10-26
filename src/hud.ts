import type { HumanHud } from './hud-types.ts';

/** Validate the complete HUD at construction, so a changed HTML class fails at its source. */
export function bindHumanHud(root: HTMLElement): HumanHud {
  function element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`HUD is missing ${selector}`);
    return found;
  }
  function canvas(selector: string): { element: HTMLCanvasElement; context: CanvasRenderingContext2D } {
    const found = element<HTMLCanvasElement>(selector);
    if (typeof found.getContext !== 'function') throw new Error(`HUD ${selector} must be a canvas`);
    const context = found.getContext('2d');
    if (!context) throw new Error(`HUD ${selector} requires a 2D context`);
    return { element: found, context };
  }
  const display = canvas('.vp-canvas'),
    paint = canvas('.vp-paint'),
    map = canvas('.vp-map');
  return {
    el: root,
    canvas: display.element,
    ctx: display.context,
    paint: paint.element,
    paintCtx: paint.context,
    map: map.element,
    role: element('.role'),
    cross: element('.cross'),
    hit: element('.hitmark'),
    flash: element('.dmgflash'),
    msg: element('.vp-msg'),
    lock: element('.lockhint'),
    status: element('.vp-status'),
    carname: element('.carname'),
    hpnum: element('.hpnum'),
    hpbar: element('.bar > i'),
    big: element('.vp-info .big'),
    small: element('.vp-info .small'),
    meter: element('.vp-info .meter'),
    meterFill: element('.vp-info .meter > i'),
    hint: element('.vp-hint'),
    scores: element('.vp-scores'),
    feed: element('.vp-feed'),
    info: element('.vp-info'),
    burn: element('.vp-burn'),
    pts: element('.vp-pts'),
    camtag: element('.camtag'),
    camdata: element('.camdata'),
    last: {},
  };
}
