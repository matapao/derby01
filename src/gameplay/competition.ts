/** Authoritative round facts and session championships; persistence and wire decoding stay separate. */
import type {
  CompetitionCounters,
  TeamDefinition,
  PlayerRef,
  ResultStats,
  TeamResult,
  MechanicStanding,
  ConstructorStanding,
  RoundSummary,
  CompetitionSample,
} from './competition-types.ts';
export type {
  TeamDefinition,
  PlayerRef,
  ResultStats,
  TeamResult,
  PlayerResult,
  MechanicStanding,
  ConstructorStanding,
  RoundSummary,
  CompetitionSample,
} from './competition-types.ts';
export {
  ANONYMOUS_METRICS,
  COMPETITION_METRICS,
  roundRecords,
  mergeAnonymousRecords,
} from './competition-records.ts';
export type { AnonymousMetric, AnonymousRecord, AnonymousBoard } from './competition-records.ts';
export { decodeRoundSummary } from './competition-summary.ts';

const blank = (): CompetitionCounters => ({
  shots: 0,
  hits: 0,
  topSpeedKmh: 0,
  distanceM: 0,
  survivalS: 0,
  longestBurnS: 0,
  jobs: 0,
  repairs: 0,
  fuel: 0,
  precisionCorrect: 0,
  precisionAttempts: 0,
});
const finite = (value: number, max = 1e9): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
const rounded = (value: number): number => Math.round(value * 100) / 100;
function stats(counters: CompetitionCounters, points = 0): ResultStats {
  const { precisionCorrect, ...values } = counters;
  return {
    ...values,
    points: rounded(finite(points)),
    topSpeedKmh: rounded(counters.topSpeedKmh),
    distanceM: rounded(counters.distanceM),
    survivalS: rounded(counters.survivalS),
    longestBurnS: rounded(counters.longestBurnS),
    repairs: rounded(counters.repairs),
    fuel: rounded(counters.fuel),
    accuracy: counters.shots ? rounded((counters.hits / counters.shots) * 100) : null,
    precision: counters.precisionAttempts
      ? rounded((precisionCorrect / counters.precisionAttempts) * 100)
      : null,
  };
}

export function createCompetition(previous: RoundSummary | null = null) {
  let round = previous?.round ?? 0;
  let finished = true;
  let baseline: readonly number[] = [];
  let definitions: readonly TeamDefinition[] = [];
  let teamCounters = new Map<number, CompetitionCounters>();
  let players = new Map<string, { player: PlayerRef; team: number; counters: CompetitionCounters }>();
  const mechanicTotals = new Map<number, number>();
  const constructors = new Map<string, ConstructorStanding>();
  let summary: RoundSummary | null = previous;
  // A replacement authority continues completed championship results. In-flight round facts restart.
  for (const standing of previous?.mechanics ?? []) mechanicTotals.set(standing.team, standing.totalPoints);
  for (const standing of previous?.constructors ?? []) constructors.set(standing.name, { ...standing });

  function begin(nextRound: number, teams: readonly TeamDefinition[], points: readonly number[]): void {
    if (!Number.isInteger(nextRound) || nextRound < 1 || teams.length < 2 || teams.length > 8)
      throw new Error('Invalid competition round');
    const ids = new Set(teams.map((definition) => definition.team));
    if (ids.size !== teams.length) throw new Error('Duplicate competition team');
    for (const definition of teams) {
      if (
        !Number.isInteger(definition.team) ||
        definition.team < 0 ||
        definition.team > 7 ||
        !definition.name ||
        definition.name.length > 64 ||
        !definition.constructor ||
        definition.constructor.length > 64
      )
        throw new Error('Invalid competition team');
    }
    if (!finished && round === nextRound) return;
    if (nextRound <= round) {
      mechanicTotals.clear();
      constructors.clear();
    }
    round = nextRound;
    finished = false;
    baseline = [...points];
    definitions = teams.map((team) => ({ ...team }));
    teamCounters = new Map(teams.map((team) => [team.team, blank()]));
    players = new Map();
    summary = null;
  }
  function player(team: number, ref: PlayerRef | null): CompetitionCounters | undefined {
    if (!ref) return undefined;
    const key = `${team}:${ref.id}`;
    let entry = players.get(key);
    if (!entry && players.size < 64) {
      entry = { player: { id: ref.id.slice(0, 96), name: ref.name.slice(0, 64) }, team, counters: blank() };
      players.set(key, entry);
    }
    return entry?.counters;
  }
  function each(team: number, ref: PlayerRef | null, update: (value: CompetitionCounters) => void): void {
    const counters = teamCounters.get(team);
    if (finished || !counters) return;
    update(counters);
    const participant = player(team, ref);
    if (participant) update(participant);
  }
  function sample(samples: readonly CompetitionSample[], dt: number): void {
    if (finished || !Number.isFinite(dt) || dt <= 0 || dt > 1) return;
    for (const sample of samples) {
      const counters = teamCounters.get(sample.team);
      if (!counters) continue;
      const speed = finite(sample.speedMps, 200);
      counters.longestBurnS = Math.max(counters.longestBurnS, finite(sample.burnS));
      if (!sample.alive) continue;
      counters.topSpeedKmh = Math.max(counters.topSpeedKmh, speed * 3.6);
      counters.distanceM += speed * dt;
      counters.survivalS += dt;
      for (const occupant of sample.occupants) {
        const value = player(sample.team, occupant);
        if (value) value.survivalS += dt;
      }
      const driver = player(sample.team, sample.driver);
      if (driver) {
        driver.topSpeedKmh = Math.max(driver.topSpeedKmh, speed * 3.6);
        driver.distanceM += speed * dt;
        driver.longestBurnS = Math.max(driver.longestBurnS, finite(sample.burnS));
      }
    }
  }
  function shot(team: number, ref: PlayerRef | null): void {
    each(team, ref, (counters) => {
      counters.shots++;
    });
  }
  function hit(team: number, ref: PlayerRef | null): void {
    each(team, ref, (counters) => {
      counters.hits = Math.min(counters.shots, counters.hits + 1);
    });
  }
  function repair(team: number, ref: PlayerRef | null, restored: number): void {
    each(team, ref, (counters) => {
      counters.jobs++;
      counters.repairs += finite(restored, 1000);
    });
  }
  function fuel(team: number, ref: PlayerRef | null, amount: number): void {
    each(team, ref, (counters) => {
      counters.fuel += finite(amount, 100);
    });
  }
  function precision(team: number, ref: PlayerRef | null, correct: number, attempts: number): void {
    if (
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 100 ||
      !Number.isInteger(correct) ||
      correct < 0 ||
      correct > attempts
    )
      return;
    each(team, ref, (counters) => {
      counters.precisionAttempts += attempts;
      counters.precisionCorrect += correct;
    });
  }
  function burn(team: number, ref: PlayerRef | null, seconds: number): void {
    each(team, ref, (counters) => {
      counters.longestBurnS = Math.max(counters.longestBurnS, finite(seconds));
    });
  }
  function finish(duration: number, points: readonly number[], winnerTeam: number): RoundSummary | null {
    if (finished) return summary;
    finished = true;
    const teams = definitions
      .map((definition): TeamResult => ({
        ...definition,
        ...stats(
          teamCounters.get(definition.team) ?? blank(),
          finite(points[definition.team] ?? 0) - finite(baseline[definition.team] ?? 0),
        ),
      }))
      .sort((a, b) =>
        a.team === winnerTeam ? -1 : b.team === winnerTeam ? 1 : b.points - a.points || a.team - b.team,
      );
    const racePoints = [25, 18, 15, 12, 10, 8, 6, 4];
    const constructorRounds = new Set<string>();
    teams.forEach((team, index) => {
      const standing = constructors.get(team.constructor) ?? {
        name: team.constructor,
        points: 0,
        wins: 0,
        rounds: 0,
      };
      standing.points += racePoints[index] ?? 0;
      if (team.team === winnerTeam) standing.wins++;
      if (!constructorRounds.has(team.constructor)) standing.rounds++;
      constructorRounds.add(team.constructor);
      constructors.set(team.constructor, standing);
    });
    const mechanics = teams
      .map((team): MechanicStanding => {
        const earned = rounded(team.jobs * 10 + team.repairs * 0.1 + team.fuel * 0.05);
        const totalPoints = rounded((mechanicTotals.get(team.team) ?? 0) + earned);
        mechanicTotals.set(team.team, totalPoints);
        return {
          team: team.team,
          name: team.name,
          jobs: team.jobs,
          repairs: team.repairs,
          fuel: team.fuel,
          precision: team.precision,
          precisionAttempts: team.precisionAttempts,
          points: earned,
          totalPoints,
        };
      })
      .sort((a, b) => b.totalPoints - a.totalPoints || a.team - b.team);
    summary = {
      round,
      duration: rounded(finite(duration)),
      teams,
      players: [...players.values()].map(({ player, team, counters }) => ({
        ...player,
        team,
        ...stats(counters),
      })),
      mechanics,
      constructors: [...constructors.values()]
        .map((standing) => ({ ...standing }))
        .sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name)),
    };
    return summary;
  }
  return { begin, sample, shot, hit, repair, fuel, precision, burn, finish };
}
