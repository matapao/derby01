import { gunAt } from './gameplay/guns.ts';
import type { Car } from './car-types.ts';
import { G } from './state.ts';
import { SFX } from './audio.ts';

export function jamGun(car: Car, s: number) {
  const g = gunAt(car, s);
  if (!g || g.jam) return;
  g.jam = true;
  g.firing = false;
  const o = car.occ[s];
  if (o && o.kind === 'human' && o.h.remote === false && G.humans.includes(o.h)) SFX.fail(); // only the gunner on this screen who has to clear it hears it
}
