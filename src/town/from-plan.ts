/**
 * The town generator's plan (src/layout.ts generateLayout(seed, cars)) as a layout: the same JSON as
 * data/town.json. A map number and a number of cars give a town; the town can then be edited by hand
 * or by an agent, or written from scratch, and the engine builds every one the same way.
 */
import type { Plan } from '../layout.ts';
import type { Layout, Marking, Placement, Point } from './types.ts';

/** Which piece of data/pieces.json stands for each thing the generator lays out (data/generator.json pieces). */
export interface PieceChoice {
  brick: string;
  white: string;
  stairs: string;
  deck: string;
  canopy: string;
  kiosk: string;
  shed: string;
  woodShed: string;
  pavilion: string;
  tree: string;
  poplar: string;
  lamp: string;
  bollard: string;
  boulder: string;
}
export const STANDARD_PIECES: PieceChoice = {
  brick: 'building-brick',
  white: 'building-white',
  stairs: 'stairwell',
  deck: 'deck',
  canopy: 'canopy',
  kiosk: 'kiosk',
  shed: 'shed-red',
  woodShed: 'shed-wood',
  pavilion: 'pavilion',
  tree: 'rowan',
  poplar: 'poplar',
  lamp: 'lamp',
  bollard: 'bollard',
  boulder: 'boulder',
};

const LANE = 3.5,
  SH = LANE + 2.5; // as layout.ts: a lane, and a street's middle to the blocks
const cm = (v: number): number => Math.round(v * 100) / 100;
const ang = (v: number): number => Math.round(Math.atan2(Math.sin(v), Math.cos(v)) * 10000) / 10000; // into (-pi, pi]
const pt = (p: readonly number[]): Point => [cm(p[0]!), cm(p[1]!)];
const poly = (q: readonly (readonly number[])[]): Point[] => q.map(pt);

function inside(x: number, z: number, P: readonly (readonly number[])[]): boolean {
  let yes = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, az] = P[j]!,
      [bx, bz] = P[i]!;
    if (az! > z !== bz! > z && x < ((bx! - ax!) * (z - az!)) / (bz! - az!) + ax!) yes = !yes;
  }
  return yes;
}

export function fromPlan(P: Plan, cars: number, pick: PieceChoice = STANDARD_PIECES): Layout {
  const pieces: Placement[] = [];
  const add = (p: Placement): void => {
    pieces.push(p);
  };
  const looks: Record<string, [string, boolean]> = {
    brick: [pick.brick, true],
    white: [pick.white, true],
    wood: [pick.woodShed, true],
    kiosk: [pick.kiosk, false],
    redshed: [pick.shed, false],
    pavilion: [pick.pavilion, false],
  };
  // in the order arena.ts has always made its obstacles: buildings, stairwells, canopies, decks,
  // trees, poplars, lamps, boulders, bollards
  for (const b of P.buildings) {
    const [piece, sized] = looks[b.look ?? 'brick']!;
    add({
      piece,
      x: cm(b.x),
      z: cm(b.z),
      yaw: ang(b.yaw),
      ...(sized ? { w: cm(b.hw * 2), l: cm(b.hl * 2), h: cm(b.h) } : {}),
      ...(b.outer ? { outer: true } : {}),
    });
  }
  for (const s of P.stairs)
    add({
      piece: pick.stairs,
      x: cm(s.x),
      z: cm(s.z),
      yaw: ang(s.yaw),
      w: cm(s.hw * 2),
      l: cm(s.hl * 2),
      h: cm(s.h),
    });
  for (const c of P.canopies)
    add({ piece: pick.canopy, x: cm(c.x), z: cm(c.z), yaw: ang(Math.atan2(c.inward[0]!, c.inward[1]!)) });
  // a deck's rounded end faces its yaw
  for (const d of P.decks)
    add({
      piece: pick.deck,
      x: cm(d.x),
      z: cm(d.z),
      yaw: ang(d.round > 0 ? d.yaw : d.yaw + Math.PI),
      w: cm(d.hw * 2),
      l: cm(d.hl * 2),
      h: cm(d.h),
    });
  for (const [x, z] of P.trees) add({ piece: pick.tree, x: cm(x), z: cm(z) });
  for (const [x, z] of P.poplars) add({ piece: pick.poplar, x: cm(x), z: cm(z) });
  for (const [x, z] of P.lamps) add({ piece: pick.lamp, x: cm(x), z: cm(z) });
  // the boulders stand either side of a closed street, just outside the edge
  for (const [x, z, r] of P.boulders)
    add({
      piece: pick.boulder,
      x: cm(x),
      z: cm(z),
      r: cm(r),
      ...(inside(x, z, P.bounds) ? {} : { outer: true }),
    });
  for (const [x, z] of P.bollards) add({ piece: pick.bollard, x: cm(x), z: cm(z) });

  const markings: Marking[] = [];
  for (const f of P.fields)
    markings.push({ type: 'bays', x: cm(f.x), z: cm(f.z), yaw: ang(f.yaw), n: f.n, rows: 1 });
  for (const m of P.marks) {
    if (m.hatch) markings.push({ type: 'hatch', poly: poly(m.hatch) });
    else if (m.zebra)
      markings.push({ type: 'zebra', line: [pt(m.zebra[0]!), pt(m.zebra[1]!)], depth: cm(m.depth ?? 3.4) });
  }
  // give-way teeth where a street comes up to the ring, for the drivers who must wait
  for (const [x, z] of P.nodes) {
    const ns = Math.abs(z) > P.hz - SH - 0.01,
      ew = Math.abs(x) > P.hx - SH - 0.01;
    if (!ns && !ew) continue;
    const u = ns ? [0, Math.sign(z)] : [Math.sign(x), 0];
    markings.push({ type: 'giveWay', x: cm(x), z: cm(z), yaw: ang(Math.atan2(u[0]!, u[1]!)) });
  }

  // hedges stand just outside the edge: their middle 0.8 m out from it, half a metre longer at each end
  const walls = P.hedges.map((s) => {
    const dx = s.b[0] - s.a[0],
      dz = s.b[1] - s.a[1],
      len = Math.hypot(dx, dz) || 1,
      ux = dx / len,
      uz = dz / len;
    let nx = uz,
      nz = -ux;
    if (inside((s.a[0] + s.b[0]) / 2 + nx, (s.a[1] + s.b[1]) / 2 + nz, P.bounds)) {
      nx = -nx;
      nz = -nz;
    }
    const line: Point[] = [
      pt([s.a[0] + nx * 0.8 - ux * 0.5, s.a[1] + nz * 0.8 - uz * 0.5]),
      pt([s.b[0] + nx * 0.8 + ux * 0.5, s.b[1] + nz * 0.8 + uz * 0.5]),
    ];
    return { kind: 'hedge' as const, line, collide: false };
  });

  return {
    id: `town-${P.seed}-${cars}`,
    about: `The town for map number ${P.seed} and ${cars} cars: a ring road you can lap, an open square with the office, its deck and canopy, office blocks with alleys through them, a park and a car park.`,
    from: { generator: 'town', seed: P.seed, cars },
    seed: P.seed,
    size: { x0: cm(P.rect.x0), z0: cm(P.rect.z0), w: cm(P.rect.w), h: cm(P.rect.h) },
    bounds: { poly: poly(P.bounds), wall: 2.4 },
    ground: P.areas.map((a) => ({ surface: a.kind, poly: poly(a.poly), ...(a.kerb ? { kerb: true } : {}) })),
    roads: P.streets.map((s) => ({ line: [pt(s.a), pt(s.b)], ...(s.ring ? { ring: true } : {}) })),
    junctions: P.nodes.map(pt),
    markings,
    pieces,
    walls,
    barriers: P.exits.map((e) => ({ line: [pt(e.bar[0]!), pt(e.bar[1]!)] as [Point, Point] })),
    exits: P.exits.map((e) => ({ x: cm(e.x), z: cm(e.z), yaw: ang(Math.atan2(e.dir[0], e.dir[1])) })),
    regions: P.regions.map((g) => ({ name: g.name, kind: g.kind, poly: poly(g.poly) })),
    camera: {
      x: cm(P.menuCam.cx),
      z: cm(P.menuCam.cz),
      rx: cm(P.menuCam.rx),
      rz: cm(P.menuCam.rz),
      h: cm(P.menuCam.h),
    },
    backdrop: 'valley',
  };
}
