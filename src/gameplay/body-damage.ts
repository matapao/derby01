import type { DamageZone, Vector } from './geometry.ts';
import type { DamageCause, GamePhase } from './model.ts';

/** Names match the existing detachable-part mask; this list does not define wire order. */
export const BODY_PANELS = [
  'car_hood',
  'trunk',
  'L_Door_Front',
  'R_Door_Front',
  'L_Door_Back',
  'R_Door_Back',
] as const;
export type BodyPanel = (typeof BODY_PANELS)[number];
export const PANEL_LABELS: Readonly<Record<BodyPanel, string>> = {
  car_hood: 'Hood',
  trunk: 'Trunk lid',
  L_Door_Front: 'Left front door',
  R_Door_Front: 'Right front door',
  L_Door_Back: 'Left rear door',
  R_Door_Back: 'Right rear door',
};
export interface PanelDamageState {
  wear: number;
  looseSince: number | null;
  /** Changes each time this panel becomes loose, including two loosening events in one simulation tick. */
  generation: number;
}
export type BodyworkState = Record<BodyPanel, PanelDamageState>;

export function createBodyworkState(): BodyworkState {
  return {
    car_hood: { wear: 0, looseSince: null, generation: 0 },
    trunk: { wear: 0, looseSince: null, generation: 0 },
    L_Door_Front: { wear: 0, looseSince: null, generation: 0 },
    R_Door_Front: { wear: 0, looseSince: null, generation: 0 },
    L_Door_Back: { wear: 0, looseSince: null, generation: 0 },
    R_Door_Back: { wear: 0, looseSince: null, generation: 0 },
  };
}

const MAX_PANEL_WEAR = 1000;
const MAX_PANEL_TIME = 86400;

/** Optional addition to car detail. Ordering is BODY_PANELS, independent of the attachment mask. */
export interface BodyworkDetail {
  wear: number[];
  looseSince: (number | null)[];
  generation?: number[];
}
export function bodyworkDetail(state: BodyworkState): BodyworkDetail {
  return {
    wear: BODY_PANELS.map((panel) => state[panel].wear),
    looseSince: BODY_PANELS.map((panel) => state[panel].looseSince),
    generation: BODY_PANELS.map((panel) => state[panel].generation),
  };
}

/** Older peers omit this detail. Invalid entries preserve the previous authoritative state. */
export function decodeBodyworkDetail(raw: unknown, previous: BodyworkState): BodyworkState {
  const result = createBodyworkState();
  let wear: unknown[] = [];
  let since: unknown[] = [];
  let generations: unknown[] | null = null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const data = raw as Record<string, unknown>;
    if (Array.isArray(data['wear']) && data['wear'].length === BODY_PANELS.length) wear = data['wear'];
    if (Array.isArray(data['looseSince']) && data['looseSince'].length === BODY_PANELS.length)
      since = data['looseSince'];
    if (Object.hasOwn(data, 'generation')) {
      generations =
        Array.isArray(data['generation']) && data['generation'].length === BODY_PANELS.length
          ? data['generation']
          : [];
    }
  }
  BODY_PANELS.forEach((panel, index) => {
    const value = wear[index],
      time = since[index],
      generation = generations === null ? previous[panel].generation : generations[index];
    const valid =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= MAX_PANEL_WEAR &&
      typeof generation === 'number' &&
      Number.isSafeInteger(generation) &&
      generation >= 0 &&
      (time === null ||
        (typeof time === 'number' && Number.isFinite(time) && time >= 0 && time <= MAX_PANEL_TIME));
    result[panel] = valid ? { wear: value, looseSince: time, generation } : { ...previous[panel] };
  });
  return result;
}

const PANEL_BY_ZONE: Readonly<Record<DamageZone, BodyPanel>> = {
  front: 'car_hood',
  rear: 'trunk',
  lf: 'L_Door_Front',
  rf: 'R_Door_Front',
  lr: 'L_Door_Back',
  rr: 'R_Door_Back',
};
const WRECK_PANELS: readonly BodyPanel[] = [
  'L_Door_Front',
  'R_Door_Front',
  'car_hood',
  'trunk',
  'L_Door_Back',
  'R_Door_Back',
];

export interface BodyDamageTuning {
  panelLooseDamage: number;
  panelLooseTime: number;
  panelDamage: number;
  panelImpact: number;
  panelHit: number;
  wheelImpact: number;
  wheelHit: number;
  wheelRadius: number;
  wheelHeight: number;
  wheelTyreHp: number;
  wreckPanels: number;
  wreckWheels: number;
}
export interface BodyWheel {
  attached: boolean;
  x: number;
  z: number;
  tyreHp: number;
  flat: boolean;
  axleBroken: boolean;
}
export interface BodyInventory {
  panels: readonly BodyPanel[];
  /** Fixed car order: front left, front right, rear left, rear right. */
  wheels: readonly BodyWheel[];
}
export interface BodyDamageHit {
  alive: boolean;
  phase: GamePhase;
  cause: DamageCause;
  zone: DamageZone | null;
  /** Authoritative simulation seconds, reset for each round. */
  time: number;
  /** Damage left after the bumper absorbed its share. */
  amount: number;
  impact: number;
  local: Vector | null;
}
export interface BodyDamageDecision {
  panel: BodyPanel | null;
  wheel: number | null;
}

/** A collision can release one weakened panel and the nearest damaged wheel, never more. */
export function collisionBodyDamage(
  state: BodyworkState,
  inventory: BodyInventory,
  hit: BodyDamageHit,
  tuning: BodyDamageTuning,
): BodyDamageDecision {
  const result: BodyDamageDecision = { panel: null, wheel: null };
  if (
    !hit.alive ||
    hit.phase !== 'playing' ||
    (hit.cause !== 'crash' && hit.cause !== 'wall') ||
    !Number.isFinite(hit.amount) ||
    hit.amount <= 0 ||
    !Number.isFinite(hit.impact) ||
    !Number.isFinite(hit.time) ||
    hit.time < 0 ||
    hit.time > MAX_PANEL_TIME ||
    !hit.local ||
    ![hit.local.x, hit.local.y, hit.local.z].every(Number.isFinite)
  )
    return result;

  if (hit.zone && hit.impact >= tuning.panelImpact && hit.amount >= tuning.panelHit) {
    const panel = PANEL_BY_ZONE[hit.zone];
    if (inventory.panels.includes(panel)) {
      const damage = state[panel];
      damage.wear = Math.min(MAX_PANEL_WEAR, damage.wear + hit.amount);
      if (damage.looseSince === null) {
        // Even an enormous first hit must leave a visible loose stage before a later collision.
        if (damage.wear >= tuning.panelLooseDamage) {
          damage.looseSince = hit.time;
          // Round-scoped jobs cannot survive a full counter cycle; keep even a bounded wire maximum safe.
          damage.generation = damage.generation === Number.MAX_SAFE_INTEGER ? 0 : damage.generation + 1;
        }
      } else if (damage.wear >= tuning.panelDamage && hit.time - damage.looseSince >= tuning.panelLooseTime) {
        result.panel = panel;
      }
    }
  }
  if (
    hit.impact < tuning.wheelImpact ||
    hit.amount < tuning.wheelHit ||
    hit.local.y < 0 ||
    hit.local.y > tuning.wheelHeight
  )
    return result;

  let nearest = tuning.wheelRadius;
  for (let i = 0; i < Math.min(4, inventory.wheels.length); i++) {
    const wheel = inventory.wheels[i];
    if (
      !wheel?.attached ||
      !Number.isFinite(wheel.tyreHp) ||
      (!wheel.flat && !wheel.axleBroken && wheel.tyreHp > tuning.wheelTyreHp)
    )
      continue;
    const distance = Math.hypot(hit.local.x - wheel.x, hit.local.z - wheel.z);
    if (Number.isFinite(distance) && distance <= nearest && (result.wheel === null || distance < nearest)) {
      nearest = distance;
      result.wheel = i;
    }
  }
  return result;
}

export interface PanelRepair {
  name: BodyPanel;
  generation: number;
}

export function panelRepairId(repair: PanelRepair): string {
  return `panel:${repair.name}:${repair.generation}`;
}

export function listPanelRepairs(state: BodyworkState, attachedPanels: readonly BodyPanel[]): PanelRepair[] {
  return BODY_PANELS.filter((name) => attachedPanels.includes(name) && state[name].looseSince !== null).map(
    (name) => ({ name, generation: state[name].generation }),
  );
}

/** A completed old job cannot tighten a panel that came loose again in the meantime. */
export function canRepairPanel(
  state: BodyworkState,
  attachedPanels: readonly BodyPanel[],
  repair: PanelRepair,
): boolean {
  return (
    BODY_PANELS.includes(repair.name) &&
    attachedPanels.includes(repair.name) &&
    Number.isSafeInteger(repair.generation) &&
    repair.generation >= 0 &&
    state[repair.name].looseSince !== null &&
    state[repair.name].generation === repair.generation
  );
}

export function repairPanel(
  state: BodyworkState,
  attachedPanels: readonly BodyPanel[],
  repair: PanelRepair,
  time: number,
  minimumAge: number,
): boolean {
  if (!canRepairPanel(state, attachedPanels, repair)) return false;
  const since = state[repair.name].looseSince;
  if (
    since === null ||
    !Number.isFinite(since) ||
    !Number.isFinite(time) ||
    !Number.isFinite(minimumAge) ||
    minimumAge < 0 ||
    time - since < minimumAge
  )
    return false;
  state[repair.name].wear = 0;
  state[repair.name].looseSince = null;
  return true;
}

function boundedCount(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
}

/** Stable priorities expose the front seats and leave a visible, bounded amount of wreckage. */
export function wreckBodyDamage(
  inventory: BodyInventory,
  tuning: Pick<BodyDamageTuning, 'wreckPanels' | 'wreckWheels'>,
): { panels: BodyPanel[]; wheels: number[] } {
  return {
    panels: WRECK_PANELS.filter((panel) => inventory.panels.includes(panel)).slice(
      0,
      boundedCount(tuning.wreckPanels, 6),
    ),
    wheels: [0, 3, 1, 2]
      .filter((index) => inventory.wheels[index]?.attached)
      .slice(0, boundedCount(tuning.wreckWheels, 4)),
  };
}
