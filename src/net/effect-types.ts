/** Argument tuples are derived from each effect implementation; wire ids remain append-only. */
import type { dentCar } from '../car.ts';
import type {
  paintHitCar,
  paintImpact,
  groundSplat,
  wallSplat,
  paintBurst,
  crackFromKnock,
  crackWindshield,
  crackGlassAt,
} from '../paint.ts';
import type {
  crashFx,
  knockFx,
  wreckFx,
  shotFx,
  hitMarkFx,
  awardFx,
  feedRadarFx,
  feedBurnFx,
  noteFx,
  headshotMarkFx,
  burnEndFx,
  radarHitFx,
} from '../sharedfx.ts';
import type { knockOver } from '../breakables.ts';
import type { placeDrop, takeDrop } from '../drops.ts';
export interface EffectArguments {
  1: Parameters<typeof dentCar>;
  2: Parameters<typeof paintHitCar>;
  3: Parameters<typeof paintImpact>;
  4: Parameters<typeof groundSplat>;
  5: Parameters<typeof wallSplat>;
  6: Parameters<typeof paintBurst>;
  7: Parameters<typeof crackFromKnock>;
  8: Parameters<typeof crackWindshield>;
  9: Parameters<typeof crackGlassAt>;
  10: Parameters<typeof crashFx>;
  11: Parameters<typeof knockFx>;
  12: Parameters<typeof wreckFx>;
  13: Parameters<typeof shotFx>;
  14: Parameters<typeof hitMarkFx>;
  15: Parameters<typeof awardFx>;
  16: Parameters<typeof feedRadarFx>;
  17: Parameters<typeof feedBurnFx>;
  18: Parameters<typeof noteFx>;
  22: Parameters<typeof headshotMarkFx>;
  23: Parameters<typeof burnEndFx>;
  24: Parameters<typeof radarHitFx>;
  19: Parameters<typeof knockOver>;
  20: Parameters<typeof placeDrop>;
  21: Parameters<typeof takeDrop>;
}
