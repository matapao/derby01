import type { Car } from './car-types.ts';
import type { Human } from './human-types.ts';
import { G } from './state.ts';
import { D } from './data.ts';
import { KIT_NAMES } from './kit-data.ts';
import { isReplica } from './net/role.ts';
import { getSession } from './net/context.ts';
import {
  createCompetition,
  decodeRoundSummary,
  mergeAnonymousRecords,
  roundRecords,
  type AnonymousMetric,
  type AnonymousBoard,
  type PlayerRef,
  type RoundSummary,
} from './gameplay/competition.ts';

let competition: ReturnType<typeof createCompetition> | null = null;
let summary: RoundSummary | null = null;
let records: AnonymousBoard | null = null;
const listeners = new Set<() => void>();
let shots = new WeakMap<object, { team: number; actor: PlayerRef | null }>();
let hits = new WeakSet<object>();
const RECORD_KEY = 'derby01.anonymous-records.v1';
const SEATS = ['Driver', 'Hood gunner', 'Trunk gunner', 'Mechanic'];
function actor(car: Car, seat: number): PlayerRef | null {
  const occupant = car.occ[seat];
  if (!occupant) return null;
  if (occupant.kind === 'bot') return { id: `bot:${car.idx}:${seat}`, name: `${SEATS[seat] ?? 'Crew'} bot` };
  const human = occupant.h;
  return {
    id: human.remote ? `peer:${human.peer}:${human.peerIndex}` : `local:${human.id}`,
    name: human.name || human.tag,
  };
}
const authoritative = (): boolean => !isReplica() && G.state === 'playing';
export function beginCompetition(): void {
  shots = new WeakMap();
  hits = new WeakSet();
  for (const listener of listeners) listener();
  if (isReplica()) return;
  competition ??= createCompetition(summary);
  competition.begin(
    G.round,
    G.cars.map((car) => ({
      team: car.team,
      name: D.teams.teams[car.team]?.name ?? `Team ${car.team + 1}`,
      constructor: KIT_NAMES[car.cfg.kit] ?? car.cfg.kit,
    })),
    G.points,
  );
}
export function resetCompetition(): void {
  competition = null;
  summary = null;
  shots = new WeakMap();
  hits = new WeakSet();
  for (const listener of listeners) listener();
}
export function updateCompetition(dt: number): void {
  if (!authoritative()) return;
  competition?.sample(
    G.cars.map((car) => ({
      team: car.team,
      alive: car.alive,
      speedMps: Math.hypot(car.vel.x, car.vel.z),
      burnS: car.burn?.t ?? 0,
      driver: actor(car, 0),
      occupants: car.occ.flatMap((_occupant, seat) => {
        const value = actor(car, seat);
        return value ? [value] : [];
      }),
    })),
    dt,
  );
}
export function recordCompetitionShot(car: Car, seat: number, projectile: object): void {
  if (!authoritative()) return;
  const participant = actor(car, seat);
  shots.set(projectile, { team: car.team, actor: participant });
  competition?.shot(car.team, participant);
}
export function recordCompetitionHit(projectile: object): void {
  if (!authoritative() || hits.has(projectile)) return;
  const shot = shots.get(projectile);
  if (!shot) return;
  hits.add(projectile);
  competition?.hit(shot.team, shot.actor);
}
export function recordCompetitionRepair(car: Car, restored: number): void {
  if (authoritative()) competition?.repair(car.team, actor(car, 3), restored);
}
export function recordCompetitionFuel(car: Car, amount: number): void {
  if (authoritative()) competition?.fuel(car.team, actor(car, 3), amount);
}
export function recordCompetitionPrecision(human: Human, correct: number, attempts: number): void {
  // Remote client action quality has no host-side evidence. Never accept a claimed precision percentage.
  if (authoritative() && !human.remote)
    competition?.precision(human.car.team, actor(human.car, 3), correct, attempts);
}
export function recordCompetitionBurn(car: Car, seconds: number): void {
  if (authoritative()) competition?.burn(car.team, actor(car, 0), seconds);
}
export function anonymousRecords(): AnonymousBoard {
  if (!records) {
    try {
      const stored = localStorage.getItem(RECORD_KEY);
      records = mergeAnonymousRecords(stored ? JSON.parse(stored) : null, []);
    } catch {
      records = mergeAnonymousRecords(null, []);
    }
  }
  return mergeAnonymousRecords(records, []);
}
export function subscribeCompetition(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function reportCompetitionMetric(name: AnonymousMetric, value: number): void {
  const net = getSession()?.net;
  if (!net?.isHost() || !Number.isFinite(value) || value < 0) return;
  if ('metric' in net && typeof net.metric === 'function') net.metric(name, value);
}
export function finishCompetition(): RoundSummary | null {
  if (isReplica()) return summary;
  const result = competition?.finish(G.time, G.points, G.winnerTeam) ?? null;
  if (!result || result === summary) return summary;
  summary = result;
  const values = roundRecords(result);
  records = mergeAnonymousRecords(anonymousRecords(), values);
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(records));
  } catch {
    // Storage can be denied; the anonymous board remains available for this session.
  }
  for (const record of values) {
    // RoundMetrics already publishes round_points. The extra records use the host's numeric channel only.
    if (record.metric !== 'round_points') reportCompetitionMetric(record.metric, record.value);
  }
  for (const listener of listeners) listener();
  return summary;
}
export function currentCompetitionSummary(): RoundSummary | null {
  return summary;
}
export function acceptCompetitionSummary(value: unknown): void {
  const received = decodeRoundSummary(value);
  if (received && received.round <= G.round && received.round >= (summary?.round ?? 0)) {
    if (isReplica()) competition = null;
    summary = received;
    for (const listener of listeners) listener();
  }
}
