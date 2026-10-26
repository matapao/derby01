import type { CarSystems, HandlingModifiers, Stock } from './model.ts';

/** Each car owns all mutable arrays and stock. No renderer or mechanic UI is needed to create it. */
export function createSystems(
  maxHp: number,
  stock: Readonly<Stock>,
): { sys: CarSystems; mods: HandlingModifiers; stock: Stock } {
  return {
    sys: {
      engine: 100,
      fuel: 100,
      leak: false,
      fire: 0,
      fireAge: 0,
      maxHp,
      tires: [1, 1, 1, 1],
      tireHp: [100, 100, 100, 100],
      rim: [100, 100, 100, 100],
      wheelOff: [false, false, false, false],
      axles: [1, 1],
    },
    mods: { power: 1, vmax: 1, grip: 1, steer: 1, bias: 0, wobble: 0 },
    stock: { ...stock },
  };
}
