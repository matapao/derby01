/** Completed-round numeric results, independent of seats, names, rendering and transport. */
export interface MetricRound {
  readonly round: number;
  readonly state: string;
  readonly time: number;
  readonly points: readonly number[];
  readonly cars: readonly { readonly alive: boolean }[];
}
export type RoundMetricName =
  | 'points'
  | 'cars_remaining'
  | 'round_elapsed_seconds'
  | 'rounds_total'
  | 'round_points_earned'
  | 'wrecks_total'
  | 'round_seconds'
  | 'round_points'
  | 'round_wrecks';
export type ReportMetric = (name: RoundMetricName, value: number) => void;
export type RoundMetricLabels = Readonly<{
  format: 'generated';
  cars: '2' | '3' | '4' | '5' | '6' | '7' | '8';
  bots: '0' | '1' | '2';
}>;
const LIVE_METRICS = new Set<RoundMetricName>(['points', 'cars_remaining', 'round_elapsed_seconds']);
/** Fixed manifest dimensions only. Never coerce free text or add a player, room or device identifier. */
export function roundMetricLabels(cars: unknown, bots: unknown): RoundMetricLabels | null {
  const carLabel = (['2', '3', '4', '5', '6', '7', '8'] as const).find((label) => Number(label) === cars);
  const botLabel = (['0', '1', '2'] as const).find((label) => Number(label) === bots);
  return carLabel && botLabel ? { format: 'generated', cars: carLabel, bots: botLabel } : null;
}
/** The host uses this same adapter tested against the manifest. Custom formats keep unlabeled live gauges. */
export function createRoundMetricReporter(
  publish: (name: RoundMetricName, value: number, labels: Readonly<Record<string, string>>) => unknown,
  config: { cars: unknown; bots: unknown; format: unknown },
): ReportMetric {
  const labels = config.format === 'generated' ? roundMetricLabels(config.cars, config.bots) : null;
  return (name, value) => {
    if (LIVE_METRICS.has(name)) publish(name, value, {});
    else if (labels) publish(name, value, labels);
  };
}
export class RoundMetrics {
  private round = -1;
  private baseline: number[] = [];
  private finished = true;
  private sampledAt = -1;
  begin(state: MetricRound): void {
    this.round = state.round;
    this.baseline = [...state.points];
    this.finished = false;
    this.sampledAt = -1;
  }
  update(state: MetricRound, report: ReportMetric): void {
    if (this.finished || state.round !== this.round) return;
    const points = state.points.map((value, i) => Math.max(0, value - (this.baseline[i] ?? value)));
    const wrecks = state.cars.filter((car) => !car.alive).length;
    if (state.state === 'playing' && state.time - this.sampledAt >= 1) {
      this.sampledAt = state.time;
      report('points', Math.max(0, ...points));
      report('cars_remaining', state.cars.length - wrecks);
      report('round_elapsed_seconds', Math.max(0, state.time));
    }
    if (state.state !== 'over') return;
    this.finished = true;
    report('rounds_total', 1);
    report(
      'round_points_earned',
      points.reduce((sum, value) => sum + value, 0),
    );
    report('wrecks_total', wrecks);
    report('round_seconds', Math.max(0, state.time));
    report('round_points', Math.max(0, ...points));
    report('round_wrecks', wrecks);
  }
}
