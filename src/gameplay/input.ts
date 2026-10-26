/** Input storage and lifecycle only. DOM/device adapters live in control.ts and touch.ts. */
export type Direction = 'up' | 'right' | 'down' | 'left';
export interface PadState {
  buttons: boolean[];
  values: number[];
  axes: number[];
  id: string;
}
export interface InputState {
  keys: Set<string>;
  pressed: Set<string>;
  mouse: { dx: number; dy: number; buttons: number; pressed: number; wheel: number };
  pads: (PadState | null)[];
  padPrev: boolean[][];
}
export interface ControlFrame {
  throttle: number;
  steer: number;
  handbrake: boolean;
  boost: boolean;
  orbit: number;
  dYaw: number;
  dPitch: number;
  fire: boolean;
  zoom: boolean;
  switchP: boolean;
  camP: boolean;
  x: number;
  y: number;
  tap: Direction | null;
  a: boolean;
  aP: boolean;
  bP: boolean;
  wheel: number;
  mdx: number;
  mdy: number;
  pick: string | null;
}
/** Per-player fields the device adapter may read or update; independent of cameras and HUDs. */
export interface ControlReader {
  device: string;
  seat: number;
  mouseSteer?: number;
  flickCd?: number;
  stickDir?: Direction | null;
}
export function createInputState(): InputState {
  return {
    keys: new Set(),
    pressed: new Set(),
    mouse: { dx: 0, dy: 0, buttons: 0, pressed: 0, wheel: 0 },
    pads: [],
    padPrev: [],
  };
}
export const Input = createInputState();

export function finishInputFrame(input: InputState): void {
  input.pressed.clear();
  input.mouse.dx = input.mouse.dy = input.mouse.pressed = input.mouse.wheel = 0;
}
/** Focus loss clears edge events as well as held input, so stale actions cannot fire on return. */
export function releaseInput(input: InputState): void {
  finishInputFrame(input);
  input.keys.clear();
  input.mouse.buttons = 0;
  input.pads.fill(null);
  input.padPrev = input.padPrev.map(() => []);
}
