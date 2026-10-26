import type { Car } from './car-types.ts';
import { G } from './state.ts';
import { SFX } from './audio.ts';
import { $ } from './core.ts';

export function feed(html: string) {
  const targets = G.humans.length
    ? G.humans.map((h) => h.hud && h.hud.feed).filter((el): el is HTMLDivElement => !!el)
    : [$('#feed')];
  for (const el of targets) {
    const d = document.createElement('div');
    d.innerHTML = html;
    el.prepend(d);
    setTimeout(() => d.remove(), 6500);
    while (el.children.length > 4) el.lastChild?.remove();
  }
}

export function crewNote(car: Car, text: string, color: string) {
  for (const h of G.humans) {
    if (h.car !== car || !h.hud) continue;
    const d = document.createElement('div'),
      b = document.createElement('b');
    b.textContent = text;
    b.style.setProperty('--c', color);
    d.append(b);
    h.hud.feed.prepend(d);
    setTimeout(() => d.remove(), 3500);
    while (h.hud.feed.children.length > 4) h.hud.feed.lastChild?.remove();
  }
  if (G.humans.some((h) => h.car === car)) SFX.pickup();
}
