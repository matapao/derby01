import type { Layout } from './town/types.ts';

export let TOWN: Layout | null = null; // the town that is built, its prefabs placed
export const DROP_PADS: { x: number; z: number; types?: string[] }[] = []; // with pads, supply drops land only on them
export let MENU_CAM = { cx: 0, cz: 0, rx: 70, rz: 55, h: 40 };

export function setTown(town: Layout): void {
  TOWN = town;
}
export function setMenuCamera(camera: typeof MENU_CAM): void {
  MENU_CAM = camera;
}
