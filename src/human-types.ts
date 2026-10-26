import type { PerspectiveCamera } from 'three';
import type { Car } from './car-types.ts';
import type { ParticipantState } from './gameplay/participants.ts';
import type { Controls } from './net/snapshot.ts';

import type { HumanHud, Viewport } from './hud-types.ts';
export type { HumanHud, HudTextKey, Viewport } from './hud-types.ts';

export interface LocalHuman extends ParticipantState<Car> {
  remote: false;
  cam: PerspectiveCamera;
  hud: HumanHud | null;
  vp: Viewport;
  camMode: 'cockpit' | 'chase';
  camYaw: number;
  camY: number;
  orbit: number;
  orbitYaw: number;
  orbitIdle: number;
  shake: number;
  dmgFlash: number;
  hitMark: number;
  killMark: number;
  watch: Car | null;
  watchT: number;
  boostFov?: number;
}
export interface RemoteHuman extends ParticipantState<Car> {
  remote: true;
  peer: number;
  peerIndex: number;
  frame: Controls | null;
  frameAt: number;
  switchAt?: number;
  fixAt?: number;
  pourAt?: number;
  pourBank?: number;
  spillAt?: number;
  jamSince?: number;
  cam?: never;
  hud?: never;
}
export type Human = LocalHuman | RemoteHuman;
