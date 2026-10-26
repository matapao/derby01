/**
 * A town as data: what data/town.json holds (data/layout.schema.json describes every field), what
 * the town generator turns a map number into (fromPlan), and what the engine, the play adapter,
 * look() and check() all read. Metres; x runs east, z runs south; a yaw of 0 faces +z.
 */

export type Point = [number, number];
export type Surface = 'road' | 'pave' | 'lot' | 'grass';

export interface Ground {
  surface: Surface;
  poly: Point[];
  kerb?: boolean;
}
export interface Road {
  line: Point[];
  width?: number;
  ring?: boolean;
  centre?: boolean;
}

export type Marking =
  | { type: 'bays'; x: number; z: number; yaw: number; n: number; rows: number }
  | { type: 'hatch'; poly: Point[] }
  | { type: 'zebra'; line: [Point, Point]; depth: number }
  | { type: 'giveWay'; x: number; z: number; yaw: number };

/** A piece placed in the town: its id in data/pieces.json, where, which way, and its size if it has one. */
export interface Placement {
  piece: string;
  x: number;
  z: number;
  yaw?: number;
  w?: number;
  l?: number;
  h?: number;
  r?: number;
  /** Outside the edge, where no car goes (the row of buildings round the town). */
  outer?: boolean;
}

export interface PrefabPlacement {
  prefab: string;
  x: number;
  z: number;
  yaw?: number;
}
export interface Wall {
  kind: 'hedge' | 'wall';
  line: Point[];
  h?: number;
  collide?: boolean;
}
export interface Barrier {
  line: [Point, Point];
}
export interface Exit {
  x: number;
  z: number;
  yaw: number;
}
export interface Region {
  name: string;
  kind: 'square' | 'park' | 'lot' | 'offices';
  poly: Point[];
}
export interface Spawn {
  x: number;
  z: number;
  yaw: number;
}
export interface Zone {
  kind: 'drops' | 'noDrops';
  poly: Point[];
}

export interface Layout {
  id: string;
  about?: string;
  from?: { generator: 'town'; seed: number; cars?: number };
  seed: number;
  size: { x0: number; z0: number; w: number; h: number };
  bounds: { poly: Point[]; wall: number };
  ground?: Ground[];
  roads?: Road[];
  junctions?: Point[];
  markings?: Marking[];
  pieces?: Placement[];
  prefabs?: PrefabPlacement[];
  walls?: Wall[];
  barriers?: Barrier[];
  exits?: Exit[];
  regions?: Region[];
  spawns?: Spawn[];
  zones?: Zone[];
  camera?: { x: number; z: number; rx: number; rz: number; h: number };
  backdrop?: 'valley' | 'none';
}

/** What a prefab holds: a group of things in its own frame (x to its left, z forward, as for a car), placed as one. */
export interface Prefab {
  id: string;
  about: string;
  ground?: Ground[];
  pieces?: Placement[];
  markings?: Marking[];
  walls?: Wall[];
  barriers?: Barrier[];
}

// ---- the piece catalogue (data/pieces.json) ----

export type Collider =
  | { shape: 'none' }
  | { shape: 'box'; w?: number; l?: number; h?: number }
  | { shape: 'circle'; r: number; h: number; scaled?: boolean }
  | { shape: 'posts'; posts: [number, number, number, number][] }
  | { shape: 'rounded' };

export type Component =
  | { type: 'solid'; bounce: number; friction: number }
  | {
      type: 'breakable';
      speed: number;
      slow: number;
      dmg: number;
      fall: 'tip' | 'shatter';
      rest?: number;
      dark?: boolean;
    }
  | { type: 'ramp' }
  | { type: 'dropPad'; types?: ('fuel' | 'tyre' | 'bumper' | 'glass')[] };

export interface Piece {
  id: string;
  about: string;
  asset: string;
  size?: { w?: [number, number]; l?: [number, number]; h?: [number, number]; r?: [number, number] };
  collider: Collider;
  components: Component[];
}
