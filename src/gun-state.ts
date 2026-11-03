import { gunAt } from './gameplay/guns.ts';
import type { Car } from './car-types.ts';

export function jamGun(car: Car, s: number) {
  const g = gunAt(car, s);
  if (!g) return;
  g.jam = false;
}
