/**
 * derby01's play adapter: an agent takes a seat in a room the way a player on another screen does.
 * It runs on the host in a worker (no DOM, no three.js), reads the host's own messages (hello,
 * setup, round, crew, flow, detail, fx, snap) into a compact view of its seat, and sends the same
 * controls (ctrl, 30 a second) and asks (switch, fix, pour, unjam) a player's screen sends, so the
 * host's game needs no changes and checks the agent exactly as it checks people.
 *
 * Fair play: the turret turns no faster than a gamepad at full stick and its aim wanders like a
 * steady hand's; a mechanic's job takes as long as a skilled person needs for its mini-game (worked
 * out from data/mechanic.json); fuel is poured at the can's rate; a jam takes as long to clear as
 * pressing its directions does. Actions hold until replaced or until their for_ms runs out.
 */
import type { GameNet, Reader } from '/zirbel-net.js';
import {
  createBodyworkState,
  decodeBodyworkDetail,
  listPanelRepairs,
  panelRepairId,
  PANEL_LABELS,
  type BodyPanel,
  type BodyworkState,
  type PanelRepair,
} from '../gameplay/body-damage.ts';
import {
  CONTROLS_PER_SECOND,
  MSG,
  PROTOCOL,
  asInt,
  asNumber,
  asObject,
  asSeatTaker,
  parseJson,
  playerName,
  type SeatTaker,
} from '../net/protocol.ts';
import {
  NO_CONTROLS,
  readSnapshot,
  writeControls,
  type CarSnap,
  type Controls,
  type Snapshot,
} from '../net/snapshot.ts';
import { NOTES, readEffects, type Effect } from './fx.ts';
import { RECIPE, generateLayout, type Recipe } from '../layout.ts';
import { colliders, expand, type Obstacle } from '../town/colliders.ts';
import { fromPlan } from '../town/from-plan.ts';
import { bearing, insidePoly, rayBox, rayCircle, rayEdge } from '../town/geometry.ts';
import type { Layout, Piece, Prefab } from '../town/types.ts';
import assets from '../../assets/assets.json' with { type: 'json' };
import car from '../../data/car.json' with { type: 'json' };
import generator from '../../data/generator.json' with { type: 'json' };
import guns from '../../data/guns.json' with { type: 'json' };
import kits from '../../data/kits.json' with { type: 'json' };
import mechanic from '../../data/mechanic.json' with { type: 'json' };
import pieces from '../../data/pieces.json' with { type: 'json' };
import prefabs from '../../data/prefabs.json' with { type: 'json' };
import rounds from '../../data/rounds.json' with { type: 'json' };
import teams from '../../data/teams.json' with { type: 'json' };
import town from '../../data/town.json' with { type: 'json' };

const HOST = 255; // zirbel-net's HOST
const SEATS = ['driver', 'hood', 'trunk', 'mechanic'] as const;
type Seat = (typeof SEATS)[number];
const RUNNING = new Set(['countdown', 'playing', 'over']);
/** How fast an agent's turret turns: a gamepad at full stick (data/controls.json pad.yaw is 2.8). */
const AIM_RATE = 3;
/** How far an agent's aim wanders, in metres: a steady hand, a little better than a hard bot. */
const AIM_WOBBLE = 1;
/** Picking a job from the list and starting it, as a person does with W/S and Space. */
const PICK = 0.3;
const FEELERS: [string, number][] = [
  ['ahead', 0],
  ['aheadRight', 45],
  ['right', 90],
  ['backRight', 135],
  ['back', 180],
  ['backLeft', -135],
  ['left', -90],
  ['aheadLeft', -45],
];
const FEEL_MAX = 40;
/** Bumper pieces, as car.ts builds them. */
const BUMPER_PIECES = { front: 3, rear: 3, left: 2, right: 2 } as const;
const BUMPER_URG = { front: 40, rear: 34, left: 30, right: 30 } as const;
const TIRE_NAMES = ['front-left', 'front-right', 'rear-left', 'rear-right'];
/** Existing car-detail mask order; bodywork state ordering does not define this wire contract. */
const PANEL_MASK_ORDER: readonly BodyPanel[] = [
  'car_hood',
  'trunk',
  'L_Door_Front',
  'R_Door_Front',
  'L_Door_Back',
  'R_Door_Back',
];
/** The most a host's message of each kind can sensibly be, as the replica has it; anything bigger is dropped unread. */
const MAX_BYTES: Readonly<Record<number, number>> = {
  [MSG.hello]: 16384,
  [MSG.setup]: 16384,
  [MSG.round]: 65536,
  [MSG.crew]: 4096,
  [MSG.flow]: 2048,
  [MSG.detail]: 4096,
  [MSG.fx]: 16384,
  [MSG.snap]: 4096,
};
/** Snapshots stamped further than this from the hub's clock are not the host's real ones. */
const SNAP_SKEW_MS = 5000;
/** The host takes a finished job at most every 1.5 s, and a seat change every 0.4 s: stay clear of both. */
const FIX_GAP_MS = 1600,
  PANEL_CONFIRM_MS = 8000,
  SWITCH_GAP_MS = 600;

/** The blocks the adapter reads: the revision's own when the host gives them, else the ones it was built with. */
export interface Blocks {
  car: typeof car;
  guns: typeof guns;
  kits: typeof kits;
  mechanic: typeof mechanic;
  teams: typeof teams;
  rounds: typeof rounds;
  town: Layout;
  pieces: { pieces: Piece[] };
  prefabs: { prefabs: Prefab[] };
  generator: Recipe;
}
const BUNDLED: Blocks = {
  car,
  guns,
  kits,
  mechanic,
  teams,
  rounds,
  generator,
  town: town as unknown as Layout,
  pieces: pieces as unknown as { pieces: Piece[] },
  prefabs: prefabs as unknown as { prefabs: Prefab[] },
};

const BODY = (assets as { id: string; anchors?: { turrets?: Record<string, { at: number[] }> } }[]).find(
  (a) => a.id === 'retro-car/body',
);
const MOUNT: Record<'hood' | 'trunk', number[]> = {
  hood: BODY?.anchors?.turrets?.['hood']?.at ?? [0, 0.915, 1.45],
  trunk: BODY?.anchors?.turrets?.['trunk']?.at ?? [0, 0.84, -1.72],
};

// ---- what agents read ----

export const about =
  "derby01, a paintball demolition derby: two to eight cars, one per team, four seats each. You sit in one seat; other players and the CPU fill the rest. A round ends when one team is left; points add up over the match. Score by damaging other teams' cars (paintballs, rams, shoving them into walls), wrecking them (+250), shooting their roof radar (+5 a hit, +150 to knock it off), holding slides (burns) and being last (+200). Driver: throttle, steer or toward, handbrake, boost; around gives the free metres in eight directions. Gunner: aim at a car or a point, fire; guns heat up and can jam (unjam). Mechanic: start jobs from jobs; each takes as long as a skilled person needs; some need spares from supply drops. seat moves you. Metres: x east, z south. Headings are compass degrees; bearings are degrees off your car's nose, + to the right.";

const num = (description: string, minimum: number, maximum: number): object => ({
  type: 'number',
  minimum,
  maximum,
  description,
});
const int = (description: string, minimum: number, maximum: number): object => ({
  type: 'integer',
  minimum,
  maximum,
  description,
});
const bool = (description: string): object => ({ type: 'boolean', description });
const target = (who: string): object => ({
  description: `${who}: a car (by number) or a point on the map.`,
  oneOf: [
    {
      type: 'object',
      required: ['car'],
      additionalProperties: false,
      description: 'A car.',
      properties: { car: int('Its number, as in cars.', 0, 7) },
    },
    {
      type: 'object',
      required: ['x', 'z'],
      additionalProperties: false,
      description: 'A point.',
      properties: {
        x: num('Metres east.', -400, 400),
        z: num('Metres south.', -400, 400),
        y: num('Metres up (gunners). Default 0.8.', -5, 40),
      },
    },
  ],
});

export const action = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'derby01: what an agent does',
  description:
    'One action, holding until the next one (or until for_ms). Give only the fields for your seat; an empty action lets go of everything.',
  type: 'object',
  additionalProperties: false,
  properties: {
    throttle: num('Driver: 1 full gas, 0 coast, -1 brake and then reverse.', -1, 1),
    steer: num('Driver: -1 full left, 1 full right.', -1, 1),
    toward: target('Driver: steer toward this instead of steer, every control tick'),
    handbrake: bool(
      'Driver: the handbrake. Yank it at speed to throw the car into a slide (a burn scores while you hold the slide).',
    ),
    boost: bool('Driver: nitro while held (it refills when you let go).'),
    aim: target(
      'Gunner: what to aim at. The turret turns there at up to 170 degrees a second, within its arc, and leads a moving car',
    ),
    fire: bool(
      'Gunner: hold the trigger. The gun heats up and overheats after about 2.5 s of fire, and a hot gun can jam.',
    ),
    unjam: bool('Gunner: clear a jammed gun (about 1.5 s).'),
    job: {
      type: ['string', 'null'],
      maxLength: 24,
      description: 'Mechanic: start a job (an id from jobs), or null to stop. One job at a time.',
    },
    seat: {
      enum: [...SEATS],
      description: 'Move to another seat of your car: one no player holds (the CPU takes yours).',
    },
    for_ms: int('Let go of what is held (pedals, steering, trigger) after this many milliseconds.', 0, 10000),
  },
};

const carView = {
  type: 'object',
  description: 'A car.',
  properties: {
    car: int("Its number (car 0 is the first team's).", 0, 7),
    team: { type: 'string', description: 'Its team.' },
    kit: { type: 'string', description: 'Its kit.' },
    x: num('Metres east.', -400, 400),
    z: num('Metres south.', -400, 400),
    heading: int('Where its nose points: compass degrees.', 0, 359),
    speed: num('m/s.', 0, 90),
    hp: int('Chassis health.', 0, 100),
    alive: bool('Still in the round.'),
    nitro: num('Nitro left, 0 to 1.', 0, 1),
    guns: {
      type: 'array',
      description:
        'Hood gun, trunk gun: where each points (compass), its heat (1 = overheated), whether jammed and firing.',
    },
    crew: {
      type: 'array',
      description:
        "Who sits in each seat (driver, hood, trunk, mechanic): you, another player or agent (by name), the game's CPU (cpu), or nobody.",
    },
    dist: num('Metres from your car.', 0, 1200),
    bearing: int("Degrees from your car's nose, + to the right.", -180, 180),
  },
};
export const observation = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'derby01: what an agent sees',
  description: "Your seat's view of the round right now. Numbers are rounded.",
  type: 'object',
  properties: {
    state: {
      enum: ['connecting', 'menu', 'countdown', 'playing', 'over', 'unavailable'],
      description:
        'connecting: waiting for the host; menu: the host is setting up; countdown, playing, over: the round; unavailable: see note.',
    },
    note: { type: 'string', description: "Why the game can't be played, or what you are waiting for." },
    t: num('Seconds into the round.', 0, 100000),
    timer: num('Countdown: seconds to go. Over: seconds to the next round.', 0, 60),
    round: int('Round number in this match.', 0, 1000000),
    you: {
      type: ['object', 'null'],
      description: 'Your car (its number), your seat and team, and whether your car is still in.',
    },
    score: { type: 'object', description: 'Points and rounds won, by team.' },
    cars: { type: 'array', items: carView, description: 'Every car.' },
    drops: {
      type: 'array',
      description:
        'Supply drops on the ground: their id, kind (fuel, tyre, bumper, glass), where, how far and which way.',
    },
    car: {
      type: 'object',
      description:
        "Your car's systems: fuel, engine, fire, leak, tyres, axles, bumpers, radar, windshield, spares.",
    },
    driver: {
      type: 'object',
      description:
        'Driver: speed in km/h, nitro, the ground under you, and around: free metres to the nearest wall or post in eight directions (up to 40).',
    },
    gun: {
      type: 'object',
      description:
        "Gunner: your gun (compass heading, degrees from the car's nose, its arc, heat, jam), and targets: other teams' cars with distance, bearing from your gun, and whether in its arc.",
    },
    jobs: {
      type: 'array',
      description:
        'Mechanic: the jobs, most urgent first: id, what, urgency, and the spare a job needs if there is none on board.',
    },
    working: { type: ['object', 'null'], description: 'Mechanic: the job in hand and how far along it is.' },
    town: {
      type: ['object', 'null'],
      description: 'Once per town: its edge, streets and named regions, any start slots and ramps.',
    },
  },
};

// ---- the session ----

interface Detail {
  [k: string]: unknown;
}
function attachedPanels(detail: Detail): BodyPanel[] {
  const mask = detail['parts'];
  return typeof mask === 'number' && Number.isInteger(mask) && mask >= 0 && mask <= 0x3f
    ? PANEL_MASK_ORDER.filter((_panel, index) => (mask & (1 << index)) !== 0)
    : [];
}
interface Job {
  id: string;
  kind: string;
  what: string;
  urg: number;
  need?: string;
  repair?: PanelRepair;
}
interface Work {
  id: string;
  kind: string;
  since: number;
  takes: number;
  poured: number;
  pourAt: number;
  fixed: boolean;
  pendingSince: number | null;
  repair: PanelRepair | null;
}
type Target = { car: number } | { x: number; z: number; y?: number };
interface Act {
  throttle: number;
  steer: number;
  toward: Target | null;
  handbrake: boolean;
  boost: boolean;
  aim: Target | null;
  fire: boolean;
}
const IDLE: Act = {
  throttle: 0,
  steer: 0,
  toward: null,
  handbrake: false,
  boost: false,
  aim: null,
  fire: false,
};

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const deg = (a: number): number => Math.round((a * 180) / Math.PI);
const compass = (yaw: number): number => ((Math.round(180 - (yaw * 180) / Math.PI) % 360) + 360) % 360;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class PlaySession {
  private readonly net: GameNet;
  /** What the hub calls each seat in the room, as the platform tells this agent's seat. */
  private readonly names: () => Record<number, string>;
  private blocks: Blocks;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onMessage: (from: number, type: number, r: Reader) => void;
  private readonly onHost: () => void;
  private error = '';
  private stopped = false;
  private hello = false;
  private hostOk = true;
  private fixedAt = -1e9;
  private state = 'connecting';
  private mapSeed = 0;
  private roundNo = 0;
  private cars: { team: number; kit: string }[] = [];
  private crew: SeatTaker[][] = [];
  private snap: Snapshot | null = null;
  private snapAt = 0;
  private readonly details = new Map<number, Detail>();
  private readonly bodywork = new Map<number, BodyworkState>();
  private points: number[] = [];
  private wins: number[] = [];
  private winner = -1;
  private readonly drops = new Map<number, { type: string; x: number; z: number }>();
  private readonly down = new Set<number>();
  private mine: { car: number; seat: number } | null = null;
  private held: Act = { ...IDLE };
  private holdUntil = 0;
  private gun = { yaw: 0, pitch: 0.02, seat: -1, wob: [0, 0, 0], wobT: 0 };
  private work: Work | null = null;
  private unjam: { since: number; takes: number } | null = null;
  private seatWanted: { seat: number; tries: number; at: number } | null = null;
  private roundStart = 0;
  private rev = '';
  private loaded = '';
  private townKey = '';
  private townData: { layout: Layout; obstacles: Obstacle[] } | null = null;
  private townSent = '';
  private events: Record<string, unknown>[] = [];
  private last = performance.now();

  constructor(net: GameNet, data?: Partial<Blocks>, me?: Me) {
    this.net = net;
    this.names = () => me?.names?.() ?? {};
    this.blocks = { ...BUNDLED, ...data };
    this.onMessage = (from, type, r) => {
      if (from === this.net.hostId) this.message(type, r);
    };
    this.onHost = () => this.ask({ a: 'sync' });
    net.on('message', this.onMessage).on('host', this.onHost).on('open', this.onHost);
    this.timer = setInterval(() => this.tick(), 1000 / CONTROLS_PER_SECOND);
    if (net.connected) this.ask({ a: 'sync' }); // the host sends everything again
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.work = null;
    clearInterval(this.timer);
    this.net.off('message', this.onMessage).off('host', this.onHost).off('open', this.onHost);
  }

  /** What the hub calls a seat ("Player Three", "Bot One"), so the crews agree with join, observe and watch. */
  private seatName(p: number): string {
    return this.names()[p] ?? this.net.peers?.get(p) ?? 'Player';
  }

  private ask(what: Record<string, unknown>): void {
    if (!this.stopped && this.net.connected && this.net.hostId && this.net.hostId !== this.net.id)
      this.net.send(HOST, MSG.ask, JSON.stringify({ i: 0, ...what }));
  }

  private event(e: Record<string, unknown>): void {
    this.events.push({ t: this.clock(), ...e });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  private clock(): number {
    return this.roundStart ? r1(Math.max(0, (this.net.now() - this.roundStart) / 1000)) : 0;
  }

  // ---- the host's messages ----

  private message(type: number, r: Reader): void {
    if (r.left() > (MAX_BYTES[type] ?? 0)) return;
    if (!this.hostOk && type !== MSG.hello) return; // a host of another version is ignored until it says hello in this one
    switch (type) {
      case MSG.snap: {
        const s = readSnapshot(r);
        if (!s || !Number.isFinite(s.time) || Math.abs(s.time - this.net.now()) > SNAP_SKEW_MS) return;
        if (s.state !== this.snap?.state && RUNNING.has(s.state)) {
          if (s.state === 'playing') this.roundStart = s.time;
          this.event({ type: 'state', state: s.state });
        }
        this.snap = s;
        this.snapAt = performance.now();
        if (RUNNING.has(s.state)) this.state = s.state;
        return;
      }
      case MSG.fx:
        for (const e of readEffects(r)) this.effect(e);
        return;
      case MSG.detail: {
        const d = asObject(parseJson(r.text()));
        const i = asInt(d['i'], 0, 7, -1);
        if (i >= 0) {
          this.details.set(i, d);
          this.bodywork.set(
            i,
            decodeBodyworkDetail(d['bodywork'], this.bodywork.get(i) ?? createBodyworkState()),
          );
        }
        return;
      }
      case MSG.crew:
        this.setCrew(parseJson(r.text()));
        return;
      case MSG.flow: {
        const o = asObject(parseJson(r.text()));
        this.points = (Array.isArray(o['points']) ? o['points'] : []).map((v) => asNumber(v, 0, 1e7, 0));
        this.wins = (Array.isArray(o['teamScores']) ? o['teamScores'] : []).map((v) => asInt(v, 0, 1e4, 0));
        const w = asInt(o['winnerTeam'], -1, 7, -1);
        if (w !== this.winner && w >= 0) this.event({ type: 'won', team: this.teamName(w) });
        this.winner = w;
        if (o['state'] === 'menu') this.toMenu();
        return;
      }
      case MSG.round: {
        const o = asObject(parseJson(r.text()));
        this.roundNo = asInt(o['round'], 0, 1e6, 0);
        this.mapSeed = asInt(o['mapSeed'], 1, 99999, 1);
        this.rev = typeof o['rev'] === 'string' ? o['rev'].slice(0, 64) : '';
        this.loadRevision(this.rev);
        this.cars = (Array.isArray(o['cars']) ? o['cars'] : [])
          .slice(0, 8)
          .map(asObject)
          .map((c) => ({
            team: asInt(c['team'], 0, 7, 0),
            kit: typeof c['kit'] === 'string' ? c['kit'] : 'stock',
          }));
        this.drops.clear();
        this.down.clear();
        for (const e of Array.isArray(o['down']) ? o['down'].slice(0, 4096) : [])
          if (Array.isArray(e)) this.down.add(asInt(e[0], 0, 65535, 0));
        // supply drops already on the ground: [id, kind, x, z]
        for (const e of Array.isArray(o['drops']) ? o['drops'].slice(0, 12) : []) {
          const [id, kind, x, z] = Array.isArray(e) ? e : [];
          if (
            Number.isInteger(id) &&
            (kind === 'fuel' || kind === 'tyre' || kind === 'bumper' || kind === 'glass')
          )
            this.drops.set(id as number, {
              type: kind,
              x: asNumber(x, -400, 400, 0),
              z: asNumber(z, -400, 400, 0),
            });
        }
        this.details.clear();
        this.bodywork.clear();
        this.snap = null;
        this.state = 'countdown';
        this.roundStart = 0;
        this.work = null;
        this.unjam = null;
        this.event({ type: 'round', round: this.roundNo, cars: this.cars.length });
        this.setCrew(o['crew']);
        return;
      }
      case MSG.hello:
      case MSG.setup: {
        const o = asObject(parseJson(r.text()));
        if (type === MSG.hello) {
          this.hello = true;
          this.hostOk = asInt(o['protocol'], 0, 999, 0) === PROTOCOL;
          if (!this.hostOk) {
            this.error = 'The host runs another version of derby01.';
            return;
          }
          this.error = '';
          if (o['state'] === 'menu') this.toMenu();
        }
        const setup = type === MSG.hello ? asObject(o['setup']) : o;
        this.mapSeed = asInt(setup['mapSeed'], 1, 99999, this.mapSeed || 1);
        if (this.state === 'connecting') this.state = 'menu';
        return;
      }
    }
  }

  private toMenu(): void {
    this.state = 'menu';
    this.snap = null;
    this.mine = null;
    this.work = null;
  }

  private setCrew(raw: unknown): void {
    const rows = Array.isArray(raw) ? raw : [];
    this.crew = this.cars.map((_, ci) =>
      [0, 1, 2, 3].map((si) => asSeatTaker((Array.isArray(rows[ci]) ? rows[ci] : [])[si])),
    );
    let found: { car: number; seat: number } | null = null;
    for (const [ci, row] of this.crew.entries())
      for (const [si, t] of row.entries())
        if (typeof t === 'object' && t.p === this.net.id && t.i === 0) found = { car: ci, seat: si };
    const was = this.mine;
    this.mine = found;
    if (found && (!was || was.car !== found.car || was.seat !== found.seat)) {
      this.event({ type: 'seat', car: found.car, seat: SEATS[found.seat] });
      this.work = null;
      this.unjam = null;
      this.gun.seat = -1; // the turret starts where it is
    }
  }

  private effect(e: Effect): void {
    const me = this.mine?.car;
    switch (e.fx) {
      case 'crash':
        if (me !== undefined && (e.a === me || e.b === me) && e.strength > 3)
          this.event({ type: 'crash', with: e.a === me ? e.b : e.a, strength: r1(e.strength) });
        return;
      case 'wreck':
        this.event({ type: 'wreck', car: e.car, by: e.by, cause: e.cause });
        return;
      case 'hitMark':
        if (me === e.car && this.mine?.seat === e.seat) this.event({ type: 'hit' });
        return;
      case 'award':
        this.event({
          type: 'points',
          car: e.car,
          team: this.teamName(this.cars[e.car]?.team ?? -1),
          points: Math.round(e.points),
          why: e.label,
        });
        return;
      case 'feedRadar':
        this.event({ type: 'headshot', by: e.by, car: e.car, points: Math.round(e.points) });
        return;
      case 'feedBurn':
        this.event({ type: 'burn', car: e.car, seconds: r1(e.seconds), points: Math.round(e.points) });
        return;
      case 'note':
        if (me === e.car && NOTES[e.note]) this.event({ type: 'note', text: NOTES[e.note] });
        return;
      case 'breakProp':
        this.down.add(e.index);
        if (e.car !== null) this.event({ type: 'knocked', by: e.car });
        return;
      case 'placeDrop':
        this.drops.set(e.id, { type: e.type, x: e.x, z: e.z });
        this.event({ type: 'drop', id: e.id, kind: e.type, x: r1(e.x), z: r1(e.z) });
        return;
      case 'takeDrop':
        if (this.drops.delete(e.id)) this.event({ type: 'taken', id: e.id });
        return;
      case 'headshotMark':
        if (me === e.by) this.event({ type: 'headshot', by: e.by });
        return;
      case 'burnEnd':
        if (me === e.car) this.event({ type: e.kept ? 'burn banked' : 'burn lost' });
        return;
      case 'radarHit':
        if (me === e.car) this.event({ type: 'radar hit' });
        return;
      default:
        return;
    }
  }

  private teamName(t: number): string | null {
    return this.blocks.teams.teams[t]?.name ?? null;
  }

  // ---- where things are now ----

  /** A car from the latest snapshot, moved on by how old the snapshot is. */
  private carNow(i: number): (CarSnap & { yawNow: number }) | null {
    const c = this.snap?.cars[i];
    if (!c) return null;
    const age = Math.min(0.25, (performance.now() - this.snapAt) / 1000);
    return { ...c, x: c.x + c.vx * age, z: c.z + c.vz * age, yawNow: c.yaw + c.yawRate * age };
  }

  private targetPoint(
    t: Target,
    from: { x: number; z: number },
    leadSpeed: number,
  ): [number, number, number] | null {
    if ('car' in t) {
      const c = this.carNow(t.car);
      if (!c) return null;
      const lead = leadSpeed > 0 ? Math.hypot(c.x - from.x, c.z - from.z) / leadSpeed : 0;
      return [c.x + c.vx * lead, c.y + 0.8 + c.vy * lead, c.z + c.vz * lead];
    }
    return [t.x, t.y ?? 0.8, t.z];
  }

  /** The town this round is played in, built as every screen builds it: data/town.json, or the generator's for the map number and cars. */
  private townNow(): { layout: Layout; obstacles: Obstacle[] } | null {
    if (!this.cars.length) return null;
    const own = this.blocks.rounds.map === 'town',
      key = `${this.rev}:${own ? 'town' : `${this.mapSeed}:${this.cars.length}`}`;
    if (key !== this.townKey) {
      this.townKey = key;
      const r = { ...RECIPE, ...this.blocks.generator };
      const raw = own
        ? this.blocks.town
        : fromPlan(generateLayout(this.mapSeed, this.cars.length, r), this.cars.length, r.pieces);
      const layout = expand(raw, this.blocks.prefabs.prefabs);
      this.townData = { layout, obstacles: colliders(layout, this.blocks.pieces.pieces) };
    }
    return this.townData;
  }

  /** Loads the blocks of the revision a round names, through zirbel-net, the way every screen does. */
  private loadRevision(rev: string): void {
    const net = this.net as GameNet & { data?: (file: string, rev?: string) => Promise<unknown> };
    if (rev === this.loaded) return;
    if (!rev) {
      this.loaded = '';
      this.blocks = { ...BUNDLED };
      this.townKey = '';
      return;
    } // the game's own data, as built
    if (typeof net.data !== 'function') return;
    this.loaded = rev;
    const ids = [
      'town',
      'pieces',
      'prefabs',
      'kits',
      'car',
      'guns',
      'mechanic',
      'teams',
      'rounds',
      'generator',
    ] as const;
    Promise.all(ids.map((id) => net.data!(`${id}.json`, rev)))
      .then((list) => {
        if (this.loaded !== rev) return;
        this.blocks = { ...this.blocks, ...Object.fromEntries(ids.map((id, k) => [id, list[k]])) } as Blocks;
        this.townKey = '';
      })
      .catch(() => {
        if (this.loaded === rev) this.loaded = '';
      });
  }

  // ---- the control loop: 30 times a second, like a player's screen ----

  private tick(): void {
    if (this.stopped) return;
    const now = performance.now(),
      dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.holdUntil && now > this.holdUntil) {
      this.held = {
        ...this.held,
        throttle: 0,
        steer: 0,
        toward: null,
        handbrake: false,
        boost: false,
        fire: false,
      };
      this.holdUntil = 0;
    }
    const mine = this.mine;
    if (!mine || !RUNNING.has(this.state) || this.error) return;
    const me = this.carNow(mine.car);
    const c: Controls = { ...NO_CONTROLS };
    if (mine.seat === 0) {
      c.throttle = this.held.throttle;
      c.steer = this.held.steer;
      if (this.held.toward && me) {
        const p = this.targetPoint(this.held.toward, me, 0);
        if (p) {
          const b = bearing(me.x, me.z, me.yawNow, p[0], p[2]);
          c.steer = clamp(b / 0.5, -1, 1) * (this.held.throttle < 0 ? -1 : 1);
        }
      }
      c.handbrake = this.held.handbrake;
      c.boost = this.held.boost;
    } else if (mine.seat === 1 || mine.seat === 2) {
      this.aimGun(mine.seat, me, dt, c);
    }
    this.net.stream(HOST, MSG.ctrl, writeControls(this.net.begin(), [[0, c]]));
    if (mine.seat === 3) this.doWork(now);
    if (this.unjam && (now - this.unjam.since) / 1000 >= this.unjam.takes) {
      this.unjam = null;
      this.ask({ a: 'unjam' });
      this.event({ type: 'unjammed' });
    }
    if (this.seatWanted && now - this.seatWanted.at > SWITCH_GAP_MS) {
      if (mine.seat === this.seatWanted.seat || this.seatWanted.tries >= 3) this.seatWanted = null;
      else {
        this.seatWanted.tries++;
        this.seatWanted.at = now;
        this.ask({ a: 'switch' });
      }
    }
  }

  private aimGun(seat: number, me: (CarSnap & { yawNow: number }) | null, dt: number, c: Controls): void {
    if (!me) return;
    const g = this.gun,
      key = seat === 1 ? 'hood' : 'trunk',
      T = this.blocks.car.turrets[key],
      snapGun = me.guns[seat - 1];
    if (g.seat !== seat) {
      g.seat = seat;
      g.yaw = snapGun?.yaw ?? me.yawNow + T.facing;
      g.pitch = snapGun?.pitch ?? 0.02;
    }
    if ((g.wobT -= dt) <= 0) {
      g.wobT = 0.3 + Math.random() * 0.5;
      g.wob = [
        (Math.random() * 2 - 1) * AIM_WOBBLE,
        (Math.random() - 0.4) * 0.4 * AIM_WOBBLE,
        (Math.random() * 2 - 1) * AIM_WOBBLE,
      ];
    }
    // the gun pivots above its mount on the hood or the trunk lid
    const m = MOUNT[key],
      s = Math.sin(me.yawNow),
      co = Math.cos(me.yawNow);
    const px = me.x + m[0]! * co + m[2]! * s,
      py = me.y + m[1]! + 0.17,
      pz = me.z - m[0]! * s + m[2]! * co;
    let aim: [number, number, number] | null = this.held.aim
      ? this.targetPoint(this.held.aim, { x: px, z: pz }, this.blocks.guns.speed)
      : null;
    if (aim) aim = [aim[0] + g.wob[0]!, aim[1] + g.wob[1]!, aim[2] + g.wob[2]!];
    if (aim) {
      const want = Math.atan2(aim[0] - px, aim[2] - pz),
        wantPitch = Math.atan2(aim[1] - py, Math.hypot(aim[0] - px, aim[2] - pz));
      const step = AIM_RATE * dt;
      g.yaw = wrap(g.yaw + clamp(wrap(want - g.yaw), -step, step));
      g.pitch += clamp(wantPitch - g.pitch, -step, step);
    }
    // within the turret's arc and tilt, as the host clamps it
    const rel = clamp(wrap(g.yaw - me.yawNow - T.facing), -T.arc, T.arc);
    g.yaw = wrap(me.yawNow + T.facing + rel);
    g.pitch = clamp(g.pitch, T.pitchMin, T.pitchMax);
    const cp = Math.cos(g.pitch),
      dx = Math.sin(g.yaw) * cp,
      dy = Math.sin(g.pitch),
      dz = Math.cos(g.yaw) * cp;
    const point = aim ?? [px + dx * 30, py + dy * 30, pz + dz * 30];
    Object.assign(c, {
      aimYaw: g.yaw,
      aimPitch: g.pitch,
      aimX: point[0],
      aimY: point[1],
      aimZ: point[2],
      fire: this.held.fire && !this.unjam,
    });
  }

  // ---- the mechanic ----

  /** The jobs, as the host's game lists them (mechanic.ts mechTasks), from the car's detail. */
  private jobs(): Job[] {
    const mine = this.mine,
      d = mine ? this.details.get(mine.car) : undefined,
      c = mine ? this.carNow(mine.car) : null;
    if (!mine || !d || !c || !c.alive) return [];
    const J = this.blocks.mechanic.jobs,
      radarHp = this.blocks.car.radar.hp;
    const s = asObject(d['sys']),
      st = asObject(d['stock']),
      out: Job[] = [];
    const n = (v: unknown, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    const fire = n(s['fire']),
      engine = n(s['engine'], 100),
      fuel = n(s['fuel'], 100);
    if (fire) out.push({ id: 'fire', kind: 'fire', what: `fire, level ${fire}`, urg: 100 + fire * 5 });
    if (engine <= 0) out.push({ id: 'engine', kind: 'engine', what: 'engine dead', urg: 92 });
    else if (engine < J.engine.below)
      out.push({
        id: 'engine',
        kind: 'engine',
        what: `engine ${Math.round(engine)} %`,
        urg: 30 + (J.engine.below - engine) * 0.6,
      });
    if (s['leak'] === true) out.push({ id: 'leak', kind: 'leak', what: 'fuel leak', urg: 68 });
    if (fuel <= 0) out.push({ id: 'fuel', kind: 'fuel', what: 'out of fuel', urg: 90 });
    else if (fuel < J.fuel.below)
      out.push({
        id: 'fuel',
        kind: 'fuel',
        what: `refuel (${Math.round(fuel)} %)`,
        urg: fuel < 20 ? 74 : 22 + (J.fuel.below - fuel) * 0.6,
      });
    list(s['axles']).forEach((ok, i) => {
      if (!n(ok, 1))
        out.push({
          id: 'axle' + i,
          kind: 'axle',
          what: `${i ? 'rear' : 'front'} axle broken`,
          urg: 62 - i * 4,
        });
    });
    const off = list(s['wheelOff']),
      hp = list(s['tireHp']);
    list(s['tires']).forEach((ok, i) => {
      // (the host's task is 'tire0'; the job is a tyre, as data/mechanic.json names it)
      if (off[i] === true)
        out.push({ id: 'tire' + i, kind: 'tyre', what: `wheel off ${TIRE_NAMES[i]}`, urg: 61 });
      else if (!n(ok, 1))
        out.push({ id: 'tire' + i, kind: 'tyre', what: `flat tyre ${TIRE_NAMES[i]}`, urg: 55 });
      else if (n(hp[i], 100) < J.tyre.below)
        out.push({
          id: 'tire' + i,
          kind: 'tyre',
          what: `worn tyre ${TIRE_NAMES[i]} (${Math.round(n(hp[i]))} %)`,
          urg: 14 + (J.tyre.below - n(hp[i])) * 0.6,
        });
    });
    const bumpers = list(d['bumpers']);
    (['front', 'rear', 'left', 'right'] as const).forEach((name, k) => {
      const all = BUMPER_PIECES[name],
        mask = n(asObject(bumpers[k])['on'], 0xffff);
      let left = 0;
      for (let b = 0; b < all; b++) if (mask & (1 << b)) left++;
      if (left < all)
        out.push({
          id: 'bumper-' + name,
          kind: 'bumper',
          what: `${left ? 'fit' : 'fit new'} ${this.blocks.car.bumpers[name].label} (${left}/${all} on)`,
          urg: BUMPER_URG[name] - (left / all) * 14,
        });
    });
    const panelJob = J.panel;
    const bodywork = this.bodywork.get(mine.car);
    if (panelJob && bodywork) {
      for (const repair of listPanelRepairs(bodywork, attachedPanels(d)))
        out.push({
          id: panelRepairId(repair),
          kind: 'panel',
          what: `Tighten ${PANEL_LABELS[repair.name]}`,
          urg: panelJob.urgency,
          repair,
        });
    }
    const radar = asObject(d['radar']);
    if (radar['off'] === true)
      out.push({ id: 'radar', kind: 'radar', what: 'radar knocked off: rebuild', urg: 64 });
    else if (n(radar['hp'], radarHp) < radarHp * J.radar.below)
      out.push({
        id: 'radar',
        kind: 'radar',
        what: `radar damaged (${Math.round((n(radar['hp']) / radarHp) * 100)} %)`,
        urg: 20 + (1 - n(radar['hp']) / radarHp) * 40,
      });
    const crack = asObject(d['crack']),
      level = n(crack['level']);
    if (level > J.glass.above)
      out.push({
        id: 'glass',
        kind: 'glass',
        what:
          crack['shattered'] === true
            ? 'windshield shattered'
            : `windshield cracked (${Math.round(Math.min(1, level) * 100)} %)`,
        urg: 25 + Math.min(1, level) * 55,
      });
    if (c.hp < n(s['maxHp'], 100) - J.chassis.gap)
      out.push({
        id: 'chassis',
        kind: 'chassis',
        what: `chassis ${Math.round(c.hp)} %`,
        urg: 12 + (100 - c.hp) * 0.3,
      });
    for (const j of out) {
      const need =
        j.kind === 'fuel' && !n(st['fuel'])
          ? 'fuel can'
          : j.kind === 'tyre' && !n(st['tyres'])
            ? 'spare tyre'
            : j.kind === 'bumper' && !n(st['bumpers'])
              ? 'bumper'
              : j.kind === 'glass' && !n(st['glass'])
                ? 'windscreen'
                : undefined;
      if (need) {
        j.need = need;
        j.urg -= 60;
      }
    }
    return out.sort((a, b) => b.urg - a.urg);
  }

  /** Seconds a skilled person needs for a job's mini-game, from the game's own tuning. */
  private takes(job: Job): number {
    const G = this.blocks.mechanic.games,
      J = this.blocks.mechanic.jobs as Record<string, { game: string }>;
    const game = J[job.kind]?.game ?? 'hammer';
    const fire = Number(asObject(this.details.get(this.mine?.car ?? -1)?.['sys'])['fire']) || 1;
    switch (game) {
      case 'spray':
        return PICK + (fire + 1) * (1 / G.spray.base + 0.25); // each flame put out at its base, then over to the next
      case 'dial':
        return PICK + (1 / G.dial.fill) * 1.2; // the needle stays in the green five sixths of the time
      case 'hammer':
        return (
          PICK + (job.kind === 'axle' ? G.hammer.axleHits : G.hammer.hits) * (0.3 + 0.67 / G.hammer.speed)
        ); // waiting for the marker, then the tap
      case 'nuts':
        return job.kind === 'panel'
          ? Math.max(G.nuts.panelTime, PICK + G.nuts.panelNuts * 0.3 + G.nuts.panelTaps * 0.2)
          : PICK + G.nuts.nuts * 0.3 + G.nuts.taps * 0.2;
      case 'glue':
        return PICK + Math.max(0, G.glue.low - G.glue.start) / G.glue.heat + 2 / (G.glue.held + G.glue.idle); // heat up, then fuse in the green
      case 'glass':
        return PICK + G.glass.knocks * 0.15 + G.glass.hits / G.glass.slide;
      case 'radar': {
        const rebuild = asObject(this.details.get(this.mine?.car ?? -1)?.['radar'])['off'] === true;
        return PICK + (rebuild ? G.radar.rebuild : G.radar.repair) * (3 / G.radar.sweep + 0.1); // the blip comes round about three radians on
      }
      case 'dents':
        return PICK + G.dents.taps * 0.14;
      default:
        return PICK + 2.5; // pour: the time it takes to pour (see doWork)
    }
  }

  private doWork(now: number): void {
    const w = this.work;
    if (!w) return;
    const elapsed = (now - w.since) / 1000;
    if (w.kind === 'fuel') {
      // poured as a person pours: at the can's rate, five times a second, stopping short of a spill
      const sys = asObject(this.details.get(this.mine!.car)?.['sys']),
        fuel = Number(sys['fuel']) || 0;
      const can = this.blocks.mechanic.spares.canFuel,
        rate = this.blocks.mechanic.games.pour.rate;
      if (elapsed >= PICK && now - w.pourAt >= 200 && w.poured < can && fuel + 0.5 < 96) {
        const d = Math.min(rate * 0.2, can - w.poured);
        w.poured += d;
        w.pourAt = now;
        this.ask({ a: 'pour', d: r2(d), spill: false });
      }
      if (elapsed >= PICK + 0.4 && (w.poured >= can || fuel >= 95)) this.finish(w);
      return;
    }
    if (!this.jobs().some((j) => j.id === w.id && !j.need)) {
      this.work = null;
      if (w.kind === 'panel' && w.fixed && this.confirmedPanelRepair(w))
        this.event({ type: 'job', job: w.id, done: true });
      else this.event({ type: 'job', job: w.id, done: false, why: 'it is no longer a job' });
      return;
    }
    if (w.kind === 'panel' && w.fixed && w.pendingSince !== null) {
      if (now - w.pendingSince >= PANEL_CONFIRM_MS) {
        this.work = null;
        this.event({ type: 'job', job: w.id, done: false, why: 'the host did not confirm the repair' });
      } else if (now - this.fixedAt >= FIX_GAP_MS) {
        this.fixedAt = now;
        this.ask({ a: 'fix', task: w.id });
      }
      return;
    }
    if (!w.fixed && elapsed >= w.takes) this.finish(w);
  }

  private confirmedPanelRepair(work: Work): boolean {
    const repair = work.repair;
    const detail = this.mine ? this.details.get(this.mine.car) : undefined;
    const bodywork = this.mine ? this.bodywork.get(this.mine.car) : undefined;
    if (!repair || !detail || !bodywork || !attachedPanels(detail).includes(repair.name)) return false;
    const current = bodywork[repair.name];
    return current.generation === repair.generation && current.looseSince === null;
  }

  private finish(w: Work): void {
    if (performance.now() - this.fixedAt < FIX_GAP_MS) return; // the host would turn it down: a moment more
    this.fixedAt = performance.now();
    w.fixed = true;
    this.ask({ a: 'fix', task: w.id });
    if (w.kind === 'panel') {
      w.pendingSince = this.fixedAt;
      this.event({ type: 'job', job: w.id, pending: true });
      return;
    }
    this.event({ type: 'job', job: w.id, done: true });
    this.work = null;
  }

  // ---- what the agent does ----

  act(raw: unknown): { ok: true } | { ok: false; error: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { ok: false, error: 'an action is an object, like {"throttle": 1}' };
    const a = raw as Record<string, unknown>;
    const known = Object.keys(action.properties);
    const unknown = Object.keys(a).filter((k) => !known.includes(k));
    if (unknown.length) return { ok: false, error: `no such field: ${unknown.join(', ')}` };
    const n = (k: string, lo: number, hi: number): number | undefined => {
      const v = a[k];
      return v === undefined
        ? undefined
        : typeof v === 'number' && Number.isFinite(v)
          ? clamp(v, lo, hi)
          : NaN;
    };
    const b = (k: string): boolean | undefined => (a[k] === undefined ? undefined : a[k] === true);
    const target = (k: string): Target | null | undefined | 'bad' => {
      const v = a[k];
      if (v === undefined) return undefined;
      if (v === null) return null;
      const o = asObject(v);
      if (typeof o['car'] === 'number')
        return Number.isInteger(o['car']) && o['car'] >= 0 && o['car'] < 8 ? { car: o['car'] } : 'bad';
      if (typeof o['x'] === 'number' && typeof o['z'] === 'number')
        return {
          x: clamp(o['x'], -400, 400),
          z: clamp(o['z'], -400, 400),
          ...(typeof o['y'] === 'number' ? { y: clamp(o['y'], -5, 40) } : {}),
        };
      return 'bad';
    };
    const throttle = n('throttle', -1, 1),
      steer = n('steer', -1, 1),
      forMs = n('for_ms', 0, 10000);
    if (Number.isNaN(throttle) || Number.isNaN(steer) || Number.isNaN(forMs))
      return { ok: false, error: 'throttle, steer and for_ms are numbers' };
    const toward = target('toward'),
      aim = target('aim');
    if (toward === 'bad' || aim === 'bad')
      return { ok: false, error: 'a target is {"car": n} or {"x": …, "z": …}' };
    // well formed: now, does it fit the seat?
    const seat = this.mine ? SEATS[this.mine.seat] : null;
    const forSeat: Record<string, Seat> = {
      throttle: 'driver',
      steer: 'driver',
      toward: 'driver',
      handbrake: 'driver',
      boost: 'driver',
      aim: 'hood',
      fire: 'hood',
      unjam: 'hood',
      job: 'mechanic',
    };
    for (const k of Object.keys(a)) {
      const s = forSeat[k];
      if (!s) continue;
      const fits = s === 'hood' ? seat === 'hood' || seat === 'trunk' : seat === s;
      if (!fits)
        return {
          ok: false,
          error: seat
            ? `you are the ${seat === 'hood' || seat === 'trunk' ? seat + ' gunner' : seat}: ${k} is for the ${s === 'hood' ? 'gunners' : s}`
            : `you have no seat yet: ${k} can wait`,
        };
    }
    // an action replaces what was held; fields not given let go
    this.held = {
      throttle: throttle ?? 0,
      steer: steer ?? 0,
      toward: toward ?? null,
      handbrake: b('handbrake') ?? false,
      boost: b('boost') ?? false,
      aim: aim === undefined ? this.held.aim : aim,
      fire: b('fire') ?? false,
    };
    this.holdUntil = forMs !== undefined ? performance.now() + forMs : 0;
    if (a['unjam'] === true && !this.unjam) {
      const jammed = this.mine && this.carNow(this.mine.car)?.guns[this.mine.seat - 1]?.jam;
      if (!jammed) return { ok: false, error: 'your gun is not jammed' };
      this.unjam = { since: performance.now(), takes: PICK + this.blocks.mechanic.games.unjam.steps * 0.3 };
    }
    if (a['job'] !== undefined) {
      if (a['job'] === null) this.work = null;
      else if (typeof a['job'] !== 'string')
        return { ok: false, error: 'job is a job id from jobs, or null' };
      else if (this.work?.id !== a['job']) {
        const job = this.jobs().find((j) => j.id === a['job']);
        if (!job) return { ok: false, error: `there is no job "${a['job']}" now` };
        if (job.need) return { ok: false, error: `that job needs a ${job.need}: find a supply drop` };
        this.work = {
          id: job.id,
          kind: job.kind,
          since: performance.now(),
          takes: this.takes(job),
          poured: 0,
          pourAt: 0,
          fixed: false,
          pendingSince: null,
          repair: job.repair ?? null,
        };
      }
    }
    if (a['seat'] !== undefined) {
      const s = SEATS.indexOf(a['seat'] as Seat);
      if (s < 0) return { ok: false, error: 'seat is driver, hood, trunk or mechanic' };
      if (!this.mine) return { ok: false, error: 'you have no seat yet' };
      const row = this.crew[this.mine.car] ?? [];
      const held = row[s];
      if (s !== this.mine.seat && typeof held === 'object')
        return { ok: false, error: `a player sits in the ${SEATS[s]}'s seat` };
      if (s !== this.mine.seat) {
        this.seatWanted = { seat: s, tries: 1, at: performance.now() };
        this.ask({ a: 'switch' });
      }
    }
    return { ok: true };
  }

  // ---- what the agent sees ----

  observe(): Record<string, unknown> {
    if (this.net.isHost())
      return {
        state: 'unavailable',
        note: 'No screen hosts this room: a person must open derby01 in the room first.',
      };
    if (this.error) return { state: 'unavailable', note: this.error };
    if (!this.hello && this.state === 'connecting')
      return { state: 'connecting', note: 'Waiting for the host.' };
    const view: Record<string, unknown> = { state: this.state };
    if (this.state === 'menu') {
      view['note'] = 'The host is on the setup screen: the round starts when they press Start.';
      return view;
    }
    const s = this.snap,
      mine = this.mine,
      me = mine ? this.carNow(mine.car) : null;
    view['t'] = this.clock();
    view['timer'] = r1(s?.timer ?? 0);
    view['round'] = this.roundNo;
    view['you'] = mine
      ? {
          car: mine.car,
          seat: SEATS[mine.seat],
          team: this.teamName(this.cars[mine.car]?.team ?? -1),
          alive: me?.alive ?? true,
        }
      : null;
    if (!mine) view['note'] = 'Every seat is taken by a person: you are watching.';
    const teamsInPlay = [...new Set(this.cars.map((c) => c.team))];
    view['score'] = Object.fromEntries(
      teamsInPlay.map((t) => [
        this.teamName(t) ?? String(t),
        { points: Math.round(this.points[t] ?? 0), wins: this.wins[t] ?? 0 },
      ]),
    );
    const kitName = (id: string): string => this.blocks.kits.kits.find((k) => k.id === id)?.name ?? id;
    view['cars'] = this.cars.map((cfg, i) => {
      const c = this.carNow(i);
      if (!c) return { car: i, team: this.teamName(cfg.team), kit: kitName(cfg.kit) };
      return {
        car: i,
        team: this.teamName(cfg.team),
        kit: kitName(cfg.kit),
        x: r1(c.x),
        z: r1(c.z),
        heading: compass(c.yawNow),
        speed: r1(Math.hypot(c.vx, c.vz)),
        hp: Math.round(c.hp),
        alive: c.alive,
        nitro: r2(c.boostFuel),
        guns: c.guns.map((g) => ({
          heading: compass(g.yaw),
          heat: r2(g.heat),
          jam: g.jam,
          firing: g.firing,
        })),
        crew: (this.crew[i] ?? []).map((t) =>
          t === 'bot'
            ? 'cpu'
            : t === 'empty'
              ? null
              : t.p === this.net.id
                ? 'you'
                : playerName(this.seatName(t.p), t.i),
        ),
        ...(me && i !== mine?.car
          ? {
              dist: r1(Math.hypot(c.x - me.x, c.z - me.z)),
              bearing: deg(bearing(me.x, me.z, me.yawNow, c.x, c.z)),
            }
          : {}),
      };
    });
    view['drops'] = [...this.drops].map(([id, d]) => ({
      id,
      kind: d.type,
      x: r1(d.x),
      z: r1(d.z),
      ...(me
        ? {
            dist: r1(Math.hypot(d.x - me.x, d.z - me.z)),
            bearing: deg(bearing(me.x, me.z, me.yawNow, d.x, d.z)),
          }
        : {}),
    }));
    if (mine && me) {
      view['car'] = this.systems(mine.car);
      if (mine.seat === 0) view['driver'] = this.driverView(me);
      else if (mine.seat === 3) {
        view['jobs'] = this.jobs().map((j) => ({
          id: j.id,
          what: j.what,
          urgency: Math.max(0, Math.round(j.urg)),
          ...(j.need ? { need: j.need } : {}),
        }));
        const w = this.work;
        view['working'] = w
          ? {
              job: w.id,
              ...(w.kind === 'panel' && w.fixed ? { pending: true } : {}),
              done:
                w.kind === 'fuel'
                  ? r2(w.poured / this.blocks.mechanic.spares.canFuel)
                  : r2(Math.min(1, (performance.now() - w.since) / 1000 / w.takes)),
            }
          : null;
      } else view['gun'] = this.gunView(mine.seat, me);
    }
    const t = this.townNow();
    if (t && this.townSent !== this.townKey) {
      this.townSent = this.townKey;
      view['town'] = this.townView(t.layout);
    }
    return view;
  }

  private systems(i: number): Record<string, unknown> | null {
    const d = this.details.get(i);
    if (!d) return null;
    const s = asObject(d['sys']),
      st = asObject(d['stock']),
      bumpers = Array.isArray(d['bumpers']) ? d['bumpers'] : [];
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    const tires = list(s['tires']),
      hp = list(s['tireHp']),
      off = list(s['wheelOff']);
    const radar = asObject(d['radar']),
      crack = asObject(d['crack']);
    return {
      fuel: Math.round(Number(s['fuel']) || 0),
      engine: Math.round(Number(s['engine']) || 0),
      fire: Number(s['fire']) || 0,
      leak: s['leak'] === true,
      tyres: tires.map((ok, k) => (off[k] === true ? 'off' : ok ? Math.round(Number(hp[k]) || 0) : 'flat')),
      axles: list(s['axles']).map((ok) => (ok ? 'ok' : 'broken')),
      bumpers: Object.fromEntries(
        (['front', 'rear', 'left', 'right'] as const).map((n, k) => {
          let on = 0;
          const mask = Number(asObject(bumpers[k])['on']) || 0;
          for (let b = 0; b < BUMPER_PIECES[n]; b++) if (mask & (1 << b)) on++;
          return [n, `${on}/${BUMPER_PIECES[n]}`];
        }),
      ),
      radar:
        radar['off'] === true
          ? 'off'
          : Math.round(((Number(radar['hp']) || 0) / this.blocks.car.radar.hp) * 100),
      windshield: Math.round(Math.min(1, Number(crack['level']) || 0) * 100),
      maxHp: Math.round(Number(s['maxHp']) || 0),
      spares: {
        fuel: Number(st['fuel']) || 0,
        tyres: Number(st['tyres']) || 0,
        bumpers: Number(st['bumpers']) || 0,
        glass: Number(st['glass']) || 0,
      },
    };
  }

  private driverView(me: CarSnap & { yawNow: number }): Record<string, unknown> {
    const t = this.townNow();
    const out: Record<string, unknown> = {
      kmh: Math.round(Math.hypot(me.vx, me.vz) * 3.6),
      nitro: r2(me.boostFuel),
      boosting: me.boosting,
      handbrake: me.handbrake,
      burn: me.burnOn ? r1(me.burnT) : 0,
    };
    if (!t) {
      out['around'] = null;
      return out;
    }
    const ground = [...(t.layout.ground ?? [])].reverse().find((g) => insidePoly(me.x, me.z, g.poly));
    out['ground'] = ground?.surface ?? 'grass';
    const around: Record<string, number> = {};
    for (const [name, a] of FEELERS) {
      const yaw = me.yawNow - (a * Math.PI) / 180; // positive bearings are to the right, which is a smaller yaw
      const dx = Math.sin(yaw),
        dz = Math.cos(yaw);
      let d = rayEdge(me.x, me.z, dx, dz, t.layout.bounds.poly);
      t.obstacles.forEach((o, i) => {
        if (o.index >= 0 && this.down.has(i)) return;
        if (Math.abs(o.x - me.x) > FEEL_MAX + 40 || Math.abs(o.z - me.z) > FEEL_MAX + 40) return;
        d = Math.min(
          d,
          o.kind === 'circle'
            ? rayCircle(me.x, me.z, dx, dz, o.x, o.z, o.r)
            : rayBox(me.x, me.z, dx, dz, o.x, o.z, o.yaw, o.hw, o.hl),
        );
      });
      // from the car's own skin, not its middle
      const r = (a * Math.PI) / 180,
        skin = Math.abs(2.5 * Math.cos(r)) + Math.abs(0.97 * Math.sin(r));
      around[name] = r1(clamp(d - skin, 0, FEEL_MAX));
    }
    out['around'] = around;
    return out;
  }

  private gunView(seat: number, me: CarSnap & { yawNow: number }): Record<string, unknown> {
    const key = seat === 1 ? 'hood' : 'trunk',
      T = this.blocks.car.turrets[key],
      g = me.guns[seat - 1]!;
    const yaw = this.gun.seat === seat ? this.gun.yaw : g.yaw;
    const targets = this.cars.flatMap((cfg, i) => {
      const c = this.carNow(i);
      if (!c || !c.alive || i === this.mine?.car || cfg.team === this.cars[this.mine!.car]?.team) return [];
      const rel = wrap(Math.atan2(c.x - me.x, c.z - me.z) - me.yawNow - T.facing);
      return [
        {
          car: i,
          dist: r1(Math.hypot(c.x - me.x, c.z - me.z)),
          bearing: deg(bearing(me.x, me.z, yaw, c.x, c.z)),
          inArc: Math.abs(rel) <= T.arc,
        },
      ];
    });
    return {
      heading: compass(yaw),
      fromNose: deg(-wrap(yaw - me.yawNow)),
      arc: deg(T.arc),
      facing: deg(-T.facing),
      heat: r2(g.heat),
      overheated: g.overheat,
      jam: g.jam,
      clearing: this.unjam
        ? r2(Math.min(1, (performance.now() - this.unjam.since) / 1000 / this.unjam.takes))
        : null,
      targets: targets.sort((a, b) => a.dist - b.dist),
    };
  }

  private townView(t: Layout): Record<string, unknown> {
    const p = (q: [number, number]): [number, number] => [Math.round(q[0]), Math.round(q[1])];
    const ramps = new Set(
      this.blocks.pieces.pieces.filter((q) => q.components.some((c) => c.type === 'ramp')).map((q) => q.id),
    );
    return {
      id: t.id,
      edge: t.bounds.poly.map(p),
      streets: (t.roads ?? []).map((r) => ({ line: r.line.map(p), ...(r.ring ? { ring: true } : {}) })),
      regions: (t.regions ?? []).map((r) => ({
        name: r.name,
        kind: r.kind,
        middle: p([
          r.poly.reduce((s, q) => s + q[0], 0) / r.poly.length,
          r.poly.reduce((s, q) => s + q[1], 0) / r.poly.length,
        ]),
      })),
      ...(t.spawns
        ? { grid: t.spawns.map((s) => ({ x: Math.round(s.x), z: Math.round(s.z), heading: compass(s.yaw) })) }
        : {}),
      ramps: (t.pieces ?? [])
        .filter((q) => ramps.has(q.piece))
        .map((q) => ({ x: Math.round(q.x), z: Math.round(q.z), heading: compass(q.yaw ?? 0) })),
    };
  }

  takeEvents(): Record<string, unknown>[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

/** The agent's seat, from the platform: what the hub calls it and the room's other seats. */
interface Me {
  name: string;
  seat?: number;
  names?(): Record<number, string>;
}

export interface PlayAdapter {
  about: string;
  observation: object;
  action: object;
  start(
    net: GameNet,
    me: Me,
    data?: Partial<Blocks>,
  ): {
    observe(): unknown;
    act(action: unknown): { ok: true } | { ok: false; error: string };
    events(): unknown[];
    stop(): void;
  };
}

const adapter: PlayAdapter = {
  about,
  observation,
  action,
  start(net, me, data) {
    const s = new PlaySession(net, data, me);
    return {
      observe: () => s.observe(),
      act: (a) => s.act(a),
      events: () => s.takeEvents(),
      stop: () => s.stop(),
    };
  },
};
export default adapter;
