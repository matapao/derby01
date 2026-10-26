import type { RoundSummary, ResultStats } from './competition-types.ts';
const rounded = (value: number): number => Math.round(value * 100) / 100;
type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report object');
  return value as Obj;
}
function number(value: unknown, max = 1e9): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)
    throw new Error('Invalid report number');
  return value;
}
function text(value: unknown, max = 64): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new Error('Invalid report text');
  return value;
}
function team(value: unknown): number {
  const result = number(value, 7);
  if (!Number.isInteger(result)) throw new Error('Invalid report team');
  return result;
}
function list<T>(value: unknown, max: number, decode: (item: Obj) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid report list');
  return value.map((item: unknown) => decode(object(item)));
}
const percent = (value: unknown): number | null => (value === null ? null : number(value, 100));
function readStats(value: Obj): ResultStats {
  const result: ResultStats = {
    points: number(value['points']),
    shots: number(value['shots']),
    hits: number(value['hits']),
    accuracy: percent(value['accuracy']),
    topSpeedKmh: number(value['topSpeedKmh'], 720),
    distanceM: number(value['distanceM']),
    survivalS: number(value['survivalS']),
    longestBurnS: number(value['longestBurnS']),
    jobs: number(value['jobs']),
    repairs: number(value['repairs']),
    fuel: number(value['fuel']),
    precision: percent(value['precision']),
    precisionAttempts: number(value['precisionAttempts']),
  };
  for (const count of [result.shots, result.hits, result.jobs, result.precisionAttempts])
    if (!Number.isInteger(count)) throw new Error('Invalid report count');
  if (
    result.hits > result.shots ||
    result.accuracy !== (result.shots ? rounded((result.hits / result.shots) * 100) : null) ||
    (!result.precisionAttempts && result.precision !== null)
  )
    throw new Error('Inconsistent report stats');
  return result;
}
/** The room host may share named reports; decoding never turns a report into a global record. */
export function decodeRoundSummary(value: unknown): RoundSummary | null {
  try {
    const data = object(value);
    const round = number(data['round']);
    if (!Number.isInteger(round) || round < 1) return null;
    const result: RoundSummary = {
      round,
      duration: number(data['duration']),
      teams: list(data['teams'], 8, (row) => ({
        team: team(row['team']),
        name: text(row['name']),
        constructor: text(row['constructor']),
        ...readStats(row),
      })),
      players: list(data['players'], 64, (row) => ({
        id: text(row['id'], 96),
        name: text(row['name']),
        team: team(row['team']),
        ...readStats(row),
      })),
      mechanics: list(data['mechanics'], 8, (row) => ({
        team: team(row['team']),
        name: text(row['name']),
        jobs: number(row['jobs']),
        repairs: number(row['repairs']),
        fuel: number(row['fuel']),
        precision: percent(row['precision']),
        precisionAttempts: number(row['precisionAttempts']),
        points: number(row['points']),
        totalPoints: number(row['totalPoints']),
      })),
      constructors: list(data['constructors'], 32, (row) => ({
        name: text(row['name']),
        points: number(row['points']),
        wins: number(row['wins']),
        rounds: number(row['rounds']),
      })),
    };
    const ids = new Set(result.teams.map((row) => row.team));
    if (
      result.teams.length < 2 ||
      ids.size !== result.teams.length ||
      result.players.some((row) => !ids.has(row.team)) ||
      result.mechanics.length !== result.teams.length ||
      result.mechanics.some((row) => !ids.has(row.team)) ||
      new Set(result.mechanics.map((row) => row.team)).size !== ids.size
    )
      return null;
    return result;
  } catch {
    return null;
  }
}
