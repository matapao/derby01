import { damp, wrapPi } from './numbers.ts';
export interface ChaseState {
  camYaw: number;
  orbitYaw: number;
  orbit: number;
  orbitIdle: number;
  camY?: number;
}
export function createChaseState(): ChaseState {
  return { camYaw: 0, orbitYaw: 0, orbit: 0, orbitIdle: 0 };
}

export function advanceChaseOrbit(state: ChaseState, yaw: number, dt: number, autoOrbit = 0): number {
  state.camYaw += wrapPi(yaw - state.camYaw) * (1 - Math.exp(-5 * dt));
  if (autoOrbit) state.orbitYaw = wrapPi(state.orbitYaw + autoOrbit * dt);
  else if (Math.abs(state.orbit) > 0.01) {
    state.orbitYaw = wrapPi(state.orbitYaw - state.orbit * 0.004);
    state.orbitIdle = 0;
  } else if ((state.orbitIdle += dt) > 1.2) state.orbitYaw = damp(state.orbitYaw, 0, 3, dt);
  return state.camYaw + state.orbitYaw;
}
