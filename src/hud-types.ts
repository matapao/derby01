export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type HudTextKey = 'camtag' | 'camdata' | 'role' | 'car' | 'hp' | 'big' | 'small' | 'burn' | 'hint';
interface HudCache extends Partial<Record<HudTextKey | 'chips' | 'msg', string>> {
  paintOn?: boolean;
  team?: number;
  mech?: boolean;
  camFeed?: boolean;
  jam?: boolean;
  burnOn?: boolean;
}
export interface HumanHud {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  role: HTMLElement;
  cross: HTMLElement;
  hit: HTMLElement;
  flash: HTMLElement;
  msg: HTMLElement;
  lock: HTMLElement;
  status: HTMLElement;
  carname: HTMLElement;
  hpnum: HTMLElement;
  hpbar: HTMLElement;
  big: HTMLElement;
  small: HTMLElement;
  meter: HTMLElement;
  meterFill: HTMLElement;
  hint: HTMLElement;
  scores: HTMLElement;
  feed: HTMLElement;
  info: HTMLElement;
  map: HTMLCanvasElement;
  paint: HTMLCanvasElement;
  paintCtx: CanvasRenderingContext2D;
  burn: HTMLElement;
  pts: HTMLElement;
  camtag: HTMLElement;
  camdata: HTMLElement;
  last: HudCache;
}
