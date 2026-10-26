import type { DropKind } from './gameplay/supplies.ts';
import type { Stock } from './gameplay/model.ts';
import { D, onData } from './data.ts';

export const DROP_TYPES = {
  fuel: { ui: '#ff8f3d', color: '#ff7a1a', letter: 'F', stock: 'fuel', n: 1, note: '+1 FUEL CAN' },
  tyre: { ui: '#43dcef', color: '#2ec8f0', letter: 'T', stock: 'tyres', n: 1, note: '+1 SPARE TYRE' },
  bumper: { ui: '#ff6fcf', color: '#ff4fc4', letter: 'B', stock: 'bumpers', n: 3, note: '+3 BUMPERS' },
  glass: { ui: '#9fe3ff', color: '#8fdcff', letter: 'W', stock: 'glass', n: 1, note: '+1 WINDSCREEN' },
} satisfies Record<
  DropKind,
  { ui: string; color: string; letter: string; stock: keyof Stock; n: number; note: string }
>;
onData(() => {
  for (const k of Object.keys(DROP_TYPES) as (keyof typeof DROP_TYPES)[])
    Object.assign(DROP_TYPES[k], {
      ui: D.drops.types[k].ui,
      color: D.drops.types[k].colour,
      letter: D.drops.types[k].letter,
    });
});
