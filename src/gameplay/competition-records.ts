import type { RoundSummary } from './competition-types.ts';
const finite = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1e9, value)) : 0);
const rounded = (value: number): number => Math.round(value * 100) / 100;
export const ANONYMOUS_METRICS = [
  'round_points',
  'top_speed_kmh',
  'distance_m',
  'survival_s',
  'burn_s',
  'paint_accuracy',
  'mechanic_jobs',
  'mechanic_repairs',
  'mechanic_fuel',
  'mechanic_precision',
] as const;
export type AnonymousMetric = (typeof ANONYMOUS_METRICS)[number];
export interface AnonymousRecord {
  metric: AnonymousMetric;
  value: number;
}
export type AnonymousBoard = Record<AnonymousMetric, number[]>;
export const COMPETITION_METRICS: readonly { id: AnonymousMetric; label: string; unit: string }[] = [
  { id: 'round_points', label: 'Round score', unit: 'pts' },
  { id: 'top_speed_kmh', label: 'Top speed', unit: 'km/h' },
  { id: 'distance_m', label: 'Distance driven', unit: 'm' },
  { id: 'survival_s', label: 'Survival', unit: 's' },
  { id: 'burn_s', label: 'Longest burn', unit: 's' },
  { id: 'paint_accuracy', label: 'Paint accuracy · 10+ shots', unit: '%' },
  { id: 'mechanic_jobs', label: 'Mechanic jobs', unit: 'jobs' },
  { id: 'mechanic_repairs', label: 'Body and engine restored', unit: 'health' },
  { id: 'mechanic_fuel', label: 'Fuel delivered', unit: 'units' },
  { id: 'mechanic_precision', label: 'Timing/direction accuracy · 5+ attempts', unit: '%' },
];
export function roundRecords(summary: RoundSummary): AnonymousRecord[] {
  const records: AnonymousRecord[] = [];
  const add = (metric: AnonymousMetric, values: number[]) => {
    if (values.length)
      records.push({ metric, value: rounded(Math.max(...values.map((value) => finite(value)))) });
  };
  add(
    'round_points',
    summary.teams.map((team) => team.points),
  );
  add(
    'top_speed_kmh',
    summary.teams.map((team) => team.topSpeedKmh),
  );
  add(
    'distance_m',
    summary.teams.map((team) => team.distanceM),
  );
  add(
    'survival_s',
    summary.teams.map((team) => team.survivalS),
  );
  add(
    'burn_s',
    summary.teams.map((team) => team.longestBurnS),
  );
  add(
    'paint_accuracy',
    summary.teams
      .filter((team) => team.shots >= 10 && team.accuracy !== null)
      .map((team) => team.accuracy ?? 0),
  );
  add(
    'mechanic_jobs',
    summary.teams.map((team) => team.jobs),
  );
  add(
    'mechanic_repairs',
    summary.teams.map((team) => team.repairs),
  );
  add(
    'mechanic_fuel',
    summary.teams.map((team) => team.fuel),
  );
  add(
    'mechanic_precision',
    summary.teams
      .filter((team) => team.precisionAttempts >= 5 && team.precision !== null)
      .map((team) => team.precision ?? 0),
  );
  return records;
}
export function mergeAnonymousRecords(previous: unknown, next: readonly AnonymousRecord[]): AnonymousBoard {
  const records: AnonymousBoard = {
    round_points: [],
    top_speed_kmh: [],
    distance_m: [],
    survival_s: [],
    burn_s: [],
    paint_accuracy: [],
    mechanic_jobs: [],
    mechanic_repairs: [],
    mechanic_fuel: [],
    mechanic_precision: [],
  };
  const prior =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {};
  for (const metric of ANONYMOUS_METRICS) {
    const saved = Object.hasOwn(prior, metric) ? prior[metric] : undefined;
    const values: unknown[] = [
      ...(Array.isArray(saved) ? saved.slice(0, 100) : []),
      ...next.filter((record) => record.metric === metric).map((record) => record.value),
    ];
    const maximum = metric.endsWith('accuracy') || metric.endsWith('precision') ? 100 : 1e9;
    records[metric] = values
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum,
      )
      .sort((a, b) => b - a)
      .slice(0, 10);
  }
  return records;
}
