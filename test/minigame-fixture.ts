import {
  createMiniGames,
  startMiniGame,
  type MechanicTask,
  type MiniGameKind,
} from '../src/gameplay/minigames.ts';
import type { ControlFrame } from '../src/gameplay/input.ts';
import data from '../data/mechanic.json' with { type: 'json' };

export const input = (changes: Partial<ControlFrame> = {}): ControlFrame => ({
  throttle: 0,
  steer: 0,
  handbrake: false,
  boost: false,
  orbit: 0,
  dYaw: 0,
  dPitch: 0,
  fire: false,
  zoom: false,
  switchP: false,
  seatTo: null,
  camP: false,
  x: 0,
  y: 0,
  tap: null,
  a: false,
  aP: false,
  bP: false,
  wheel: 0,
  mdx: 0,
  mdy: 0,
  pick: null,
  ...changes,
});
export const task = (kind: MechanicTask['kind'] = 'fuel'): MechanicTask => {
  const base = { id: kind, label: kind, urg: 50 };
  if (kind === 'axle' || kind === 'tire') return { ...base, kind, idx: 0 };
  if (kind === 'bumper') return { ...base, kind, name: 'front' };
  if (kind === 'panel') return { ...base, kind, name: 'car_hood', generation: 1 };
  return { ...base, kind };
};
export function minigameFixture() {
  const rules = structuredClone(data.games),
    car = { sys: { fuel: 0, fire: 1 } },
    effects: string[] = [];
  const canFuel = () => data.spares.canFuel;
  const games = createMiniGames(
    rules,
    canFuel,
    {
      sound: (kind) => effects.push(kind),
      fire: (target, level) => {
        target.sys.fire = level;
        effects.push('fire');
      },
      puff: () => effects.push('puff'),
    },
    () => 0,
  );
  const active = <K extends MiniGameKind>(kind: K) =>
    startMiniGame(games, kind, task(kind === 'radar' ? 'radar' : 'fuel'), car);
  return { rules, car, effects, canFuel, games, active };
}
