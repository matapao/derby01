import { requireValue } from './required-fields.ts';
import type { Car } from './car.ts';
import { G } from './state.ts';
import { TEAMS } from './core.ts';

export function shakeCarCrew(car: Car, amount: number) {
  for (const h of G.humans) if (h.car === car || h.watch === car) h.shake = Math.min(1.2, h.shake + amount);
}

// "#2 Blue (P1, B2)", as HTML for the kill feed (so the names are escaped): the short form of each name
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
export function carLabel(car: Car) {
  const names = car.occ.flatMap((o) => (o?.kind === 'human' ? [o.h.tag ?? o.h.name] : []));
  return escapeHtml(
    `#${car.num} ${requireValue(TEAMS[car.team]).name}${names.length ? ' (' + names.join(', ') + ')' : ''}`,
  );
}
