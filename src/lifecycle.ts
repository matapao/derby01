import { requiredBinding } from './gameplay/binding.ts';
import type { Car } from './car-types.ts';
import type { LocalHuman, RemoteHuman } from './human-types.ts';
import type { Setup } from './setup.ts';

/** Narrow callbacks owned by flow.ts/views.ts, wired once in main.ts. Lower modules never import them. */
export interface Lifecycle {
  getSetup(): Setup;
  setSetup(setup: Setup): void;
  saveSetup(): void;
  renderSetup(): void;
  pauseGame(on: boolean, note?: string): void;
  toMenu(): void;
  buildMap(seed: number, cars: number): void;
  clearArena(): void;
  makeHuman(id: number, device: string, car: Car, seat: number): LocalHuman;
  makeRemote(peer: number, car: Car, seat: number): RemoteHuman;
  startGame(keepScore?: boolean, setup?: Setup): void;
  standings(): string;
  carFx(car: Car, dt: number): void;
  checkHiddenClock(): void;
  rebuildHud(): void;
}
const port = requiredBinding<Lifecycle>('Game lifecycle');
export const bindLifecycle = port.bind;
export const lifecycle = port.get;
