import type { CarPanelMotion } from './car-panel-motion.ts';
/** Explicit legacy presentation model. Optional attachments are installed during createCar assembly. */
import type { Human } from './human-types.ts';
import type * as THREE from 'three';
import type { CarPart } from './core.ts';
import type { Handling } from './kit-data.ts';
import type { WipedGlass } from './paint.ts';
import type { CarSetup } from './setup.ts';
import type { DamageZone } from './gameplay/geometry.ts';
import type { VehicleState } from './gameplay/model.ts';
import type { BodyworkState } from './gameplay/body-damage.ts';

export type PaintMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[]
>;
export interface BumperDefinition {
  label: string;
  hp: number;
  paths?: THREE.Vector3[][];
  pieces: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[];
}
export interface BumperState {
  name: string;
  def: BumperDefinition;
  hp: number;
  pieces: (PaintMesh | null)[];
}
interface Atlas {
  cv: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  dirty: boolean;
  up: number;
}
export interface BotState {
  car: Car;
  seat: number;
  target: Car | null;
  retarget: number;
  stuckT: number;
  reverseT: number;
  burstT: number;
  think: number;
  wob: THREE.Vector3;
  wobT: number;
  aim: THREE.Vector3;
  job: { id: string; kind: string; t: number } | null;
  rest: number;
  prog?: { x: number; z: number; t: number } | null;
  escape?: { x: number; z: number; until: number };
  dropT?: number;
  drop?: { x: number; z: number; taken: number } | null;
  navT?: number;
  wp?: [number, number] | null;
  pushT?: number;
  revDir?: number;
  revSteer?: number;
  stuckN?: number;
  stuckAt?: number;
  revBlock?: number;
  fwdT?: number;
  fwdSteer?: number;
  unjamT?: number | null;
}
export type Occupant = { kind: 'human'; h: Human } | { kind: 'bot'; bot?: BotState }; // replicas only need the bot marker
export interface Car extends VehicleState {
  cfg: CarSetup;
  lastHitBy: Car | null;
  occ: (Occupant | null)[];
  lean: { p: number; r: number; vp: number; vr: number };
  slope: { p: number; r: number };
  prevVF: number;
  stun: number;
  land: number;
  smokeT: number;
  skidPrev: (THREE.Vector3 | null)[];
  root: THREE.Group;
  body: THREE.Group;
  parts: Record<string, PaintMesh>;
  panelMotion: CarPanelMotion;
  paint: THREE.MeshStandardMaterial;
  glassMat: THREE.MeshStandardMaterial;
  rubberMat: THREE.MeshStandardMaterial;
  trimMat: THREE.MeshStandardMaterial;
  ballMat: THREE.MeshStandardMaterial;
  crewMat: THREE.MeshStandardMaterial;
  numMat: THREE.MeshStandardMaterial;
  deformables: PaintMesh[];
  meshFor: (part: CarPart, deform?: boolean) => PaintMesh;
  steeringPivot?: THREE.Group;
  wheels: {
    steer: THREE.Group;
    mesh: PaintMesh;
    front: boolean;
    left: boolean;
    baseY: number;
    attached: boolean;
  }[];
  turrets: Record<string, { base: THREE.Group; yaw: THREE.Group; pitch: THREE.Group }>;
  bumpers: Record<string, BumperState>;
  zoneDmg: Record<DamageZone, number>;
  bodywork: BodyworkState;
  riders: (THREE.Mesh | null)[];
  atlas: Atlas;
  cracks: Atlas;
  glass: Record<'hood' | 'trunk', WipedGlass> & {
    shield: WipedGlass & { tex: THREE.CanvasTexture; crack: NonNullable<WipedGlass['crack']> };
  };
  wiperArms: THREE.Mesh[];
  shieldFilm: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  crackFilm: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  kit: { zone: string; hp: number; group: THREE.Group; gone: boolean }[];
  kitMat?: THREE.MeshStandardMaterial;
  spec: Handling;
  flames?: THREE.Group[];
  flameT?: number;
  puffT?: number;
  pouring?: boolean;
  tagTex?: THREE.CanvasTexture | null;
  tagSprite?: THREE.Sprite | null;
  radar: {
    rig: THREE.Group;
    stem: THREE.Mesh;
    head: THREE.Mesh | null;
    local: number;
    world: number;
    hp: number;
    destroyed: boolean;
    sparkT: number;
    contacts: Map<Car, { x: number; z: number; yaw: number; t: number; alive: boolean }>;
    drops: Map<Pick<import('./gameplay/model.ts').SupplyDrop, 'x' | 'z' | 'type' | 'taken'>, number>;
  };
}

export const CAR_ATTACHMENTS = [
  'root',
  'body',
  'parts',
  'panelMotion',
  'paint',
  'glassMat',
  'rubberMat',
  'trimMat',
  'ballMat',
  'crewMat',
  'numMat',
  'deformables',
  'meshFor',
  'wheels',
  'turrets',
  'bumpers',
  'zoneDmg',
  'bodywork',
  'riders',
  'atlas',
  'cracks',
  'glass',
  'wiperArms',
  'shieldFilm',
  'crackFilm',
  'kit',
  'spec',
  'radar',
] as const;
export type CarAssembly = Omit<Car, (typeof CAR_ATTACHMENTS)[number]> &
  Partial<Pick<Car, (typeof CAR_ATTACHMENTS)[number]>>;
