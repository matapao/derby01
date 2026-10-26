import type { LocalHuman, RemoteHuman } from './human-types.ts';
import type { Car } from './car-types.ts';
import type { DebrisState, GamePhase, GameStats, Projectile, SupplyDrop } from './gameplay/model.ts';
import type { Setup } from './setup.ts';
import { D } from './data.ts';

// =====================================================================
//  Game state
// =====================================================================
export interface Game {
  state: GamePhase; // loading | menu | countdown | playing | over | paused
  time: number;
  cars: Car[];
  humans: LocalHuman[];
  bullets: Projectile<Car>[];
  debris: DebrisState[];
  drops: SupplyDrop[];
  remotes: RemoteHuman[]; // on the host: the players of other screens (humans is this screen's own)
  cfg: Setup;
  teamScores: number[];
  points: number[];
  round: number;
  stats: GameStats; // damage dealt per cause this session, handy when balancing
  countdown: number;
  lastCount: number;
  goT: number;
  overTimer: number;
  winnerTeam: number;
  prevState: GamePhase;
  menuOpen: boolean;
  lockLostAt: number;
  spec:
    | (import('./gameplay/camera-state.ts').ChaseState & {
        camYaw: number;
        orbitYaw: number;
        car?: Car;
        t?: number;
      })
    | null; // the watch camera, when no one on this screen plays
  dropSeq: number;
  dropT: number;
  dropsSeeded: number; // supply drops: the last one's number, the time to the next, the round they're seeded for
}
export const G: Game = {
  state: 'loading',
  time: 0,
  cars: [],
  humans: [],
  bullets: [],
  debris: [],
  drops: [],
  remotes: [],
  cfg: { botSkill: 1, mapSeed: 1, cars: [] },
  teamScores: new Array(D.teams.teams.length).fill(0),
  points: new Array(D.teams.teams.length).fill(0),
  round: 0,
  stats: {},
  countdown: 0,
  lastCount: 0,
  goT: 0,
  overTimer: 0,
  winnerTeam: -1,
  prevState: 'playing',
  menuOpen: false,
  lockLostAt: 0,
  spec: null,
  dropSeq: 0,
  dropT: 0,
  dropsSeeded: -1,
};
