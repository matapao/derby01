import type { CarSystems, GamePhase } from './model.ts';

interface Damageable {
  alive: boolean;
  hp: number;
  sys: Pick<CarSystems, 'maxHp'>;
}
/** Chassis math only. The caller owns scoring, hit credit, visuals, and the destruction transition. */
export function applyChassisDamage(
  car: Damageable,
  amount: number,
  phase: GamePhase,
  toughness: number,
  fatigue: number,
): number {
  if (
    !car.alive ||
    phase !== 'playing' ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(toughness) ||
    toughness <= 0
  )
    return 0;
  const damage = amount / toughness;
  if (damage <= 0.02) return 0;
  const dealt = Math.min(damage, car.hp);
  car.hp -= dealt;
  car.sys.maxHp = Math.max(car.hp, car.sys.maxHp - dealt * fatigue);
  return dealt;
}
