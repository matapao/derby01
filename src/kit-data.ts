import { D, onData } from './data.ts';

export type Kit = string;
export type Handling = (typeof D.kits.kits)[number]['handling'];
type Part = [
  zone: string,
  hp: number,
  at: number[],
  ...shapes: [shape: string, material: string, at: number[]][],
];
export const KIT_NAMES: Record<Kit, string> = {};
export const CAR_SPECS: Record<Kit, Handling> = {};
export const CAR_BLURB: Record<Kit, string> = {};
export const DEFAULT_KITS: Kit[] = [];
/** Where a kit's nitro flame comes out, when not from the car's own exhausts. */
export const KIT_EXHAUSTS: Record<Kit, [number, number, number][]> = {};
export const KITS: Record<Kit, Part[]> = {};
// Kit names come from saved setups and from the host: only real ones count (not 'constructor' and the like).
export const isKit = (k: unknown): k is Kit => typeof k === 'string' && Object.hasOwn(KIT_NAMES, k);
// the kit-parts package's shapes and materials (assets/assets.json), as the makers below call them
const SHAPE: Record<string, string> = {
  'kit/lens': 'lensDisc',
  'kit/wing-post': 'wingPost',
  'kit/blower-scoop': 'blowerScoop',
  'kit/ducktail': 'duck',
};
const MATERIAL: Record<string, string> = { 'material/aluminium': 'alu', team: 'team' };
onData(() => {
  for (const t of [KIT_NAMES, CAR_SPECS, CAR_BLURB, KIT_EXHAUSTS, KITS])
    for (const k of Object.keys(t)) delete t[k];
  for (const k of D.kits.kits) {
    KIT_NAMES[k.id] = k.name;
    CAR_SPECS[k.id] = k.handling;
    CAR_BLURB[k.id] = k.blurb;
    if ('exhausts' in k && k.exhausts)
      KIT_EXHAUSTS[k.id] = k.exhausts.map(([x, y, z]) => {
        if (x === undefined || y === undefined || z === undefined)
          throw new Error('Missing kit exhaust coordinate');
        return [x, y, z];
      });
    KITS[k.id] = k.parts.map((p): Part => [
      p.zone,
      p.hp,
      p.at,
      ...p.shapes.map((sh): [string, string, number[]] => [
        SHAPE[sh.shape] ?? sh.shape.slice(4),
        MATERIAL[sh.material] ?? sh.material.replace('material/', ''),
        ('at' in sh && sh.at) || [0, 0, 0],
      ]),
    ]);
  }
  DEFAULT_KITS.splice(0, DEFAULT_KITS.length, ...D.kits.defaults);
});
