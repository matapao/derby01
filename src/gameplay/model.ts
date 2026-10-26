import type {
  BufferGeometry,
  Color,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { Pose } from './geometry.ts';

export type GamePhase = 'loading' | 'menu' | 'countdown' | 'playing' | 'over' | 'paused';
export type DamageCause = 'gun' | 'crash' | 'wall' | 'fire' | 'prop' | 'landing';
export interface GameStats extends Partial<Record<DamageCause, number>> {
  points?: Record<string, number>;
}
export interface DriveControls {
  throttle: number;
  steer: number;
  handbrake: boolean;
  boost: boolean;
}
export interface BurnState {
  t: number;
  off: number;
  on: boolean;
  kick: number;
}
export interface CarSystems {
  engine: number;
  fuel: number;
  leak: boolean;
  fire: number;
  fireAge: number;
  maxHp: number;
  tires: number[];
  tireHp: number[];
  rim: number[];
  wheelOff: boolean[];
  axles: number[];
}
export interface HandlingModifiers {
  power: number;
  vmax: number;
  grip: number;
  steer: number;
  bias: number;
  wobble: number;
}
export interface Stock {
  fuel: number;
  tyres: number;
  bumpers: number;
  glass: number;
}
export interface GunState {
  yaw: number;
  pitch: number;
  cd: number;
  heat: number;
  overheat: boolean;
  jam: boolean;
  recoil: number;
  firing: boolean;
  zoom: number;
  aimPoint: Vector3;
  loft?: number;
}
/** Simulation fields have explicit types even while the legacy visual attachments are migrated. */
export interface VehicleState extends Pose {
  idx: number;
  team: number;
  num: number;
  pos: Vector3;
  vel: Vector3;
  yawRate: number;
  grounded: boolean;
  alive: boolean;
  hp: number;
  mass: number;
  inertia: number;
  steer: number;
  spin: number;
  boostFuel: number;
  boosting: boolean;
  ctrl: DriveControls;
  sys: CarSystems;
  mods: HandlingModifiers;
  stock: Stock;
  gun: [null, GunState, GunState, null];
  burn?: BurnState;
  lastHitBy: VehicleState | null;
  lastHitTime: number;
}
export interface Projectile<TCar extends VehicleState> {
  p: Vector3;
  v: Vector3;
  dmg: number;
  car: TCar;
  team: number;
  age: number;
  css: string;
  color3: Color;
  seen?: boolean;
  shooter: { kind: 'human'; h: { seat: number } } | { kind: 'bot' } | null;
}
export interface DebrisState {
  mesh: Object3D;
  vel: Vector3;
  spin: Vector3;
  life: number;
  r: number;
  rest?: number;
  heavy: boolean;
  lie: boolean;
  tree: boolean;
  lying: boolean;
  still: boolean;
  bumpT: number;
}
export interface SupplyDrop {
  id: number;
  type: import('./supplies.ts').DropKind;
  x: number;
  z: number;
  t: number;
  taken: number;
  m: {
    root: Group;
    ring: Mesh;
    beam: Mesh<BufferGeometry, MeshBasicMaterial>;
    item: Group;
    mats: Material[];
  };
}
