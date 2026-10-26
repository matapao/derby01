/**
 * A town seen from above, as an SVG plan with a legend: what the host turns into a picture (and a
 * coarse text grid, by the legend's colours) for agents that build without 3D. Pure: it reads the
 * blocks it is given and nothing else. It draws in the subset of SVG the host's rasteriser knows:
 * flat fills and strokes, no gradients, dashes, clipping or real fonts.
 *
 *   look({ town, pieces, prefabs, rounds, generator }, { region: [x0, z0, x1, z1], layout })  ->  { svg, legend }
 *
 * When rounds.map is generated it draws the town the generator makes from the recipe given (for map
 * number seed and cars, 1 and 4 unless asked), so a change to the recipe shows at once. layout picks
 * one: "town" is data/town.json whatever rounds.map says, "town-<map>-<cars>" the generator's town
 * for that map number and number of cars (the id the generator gives it).
 */
import { RECIPE, generateLayout, type Recipe } from '../layout.ts';
import { expand } from '../town/colliders.ts';
import { fromPlan } from '../town/from-plan.ts';
import { boxCorners, toWorld } from '../town/geometry.ts';
import type { Layout, Piece, Placement, Point, Prefab } from '../town/types.ts';

export interface Legend {
  color: string;
  label: string;
}
export interface Options {
  region?: [number, number, number, number];
  seed?: number;
  cars?: number;
  layout?: string;
}

/** One colour per kind of thing, so the host's text grid can tell them apart. */
const C = {
  grass: '#5d8a3a',
  road: '#606367',
  pave: '#9c9b96',
  lot: '#7c7f83',
  kerb: '#c9c7c0',
  paint: '#f0f0ec',
  centre: '#e8c440',
  brick: '#8a3a2b',
  white: '#d9dadb',
  small: '#3a3330',
  deck: '#a4a39e',
  canopy: '#e0a92a',
  tree: '#2e6b24',
  lamp: '#101214',
  bollard: '#d42a1e',
  boulder: '#8d8a84',
  grid: '#ffffff',
  spawn: '#ff8f3d',
  ramp: '#c9a227',
  pad: '#ffc24b',
  hedge: '#244a1c',
  wall: '#b8b6ae',
  barrier: '#c8261c',
  edge: '#f4f0e6',
  drops: '#ffd24a',
  text: '#111111',
  panel: '#f4f0e6',
} as const;

const LEGEND: Legend[] = [
  { color: C.road, label: 'road' },
  { color: C.pave, label: 'pavement' },
  { color: C.lot, label: 'car park' },
  { color: C.grass, label: 'grass' },
  { color: C.brick, label: 'brick building' },
  { color: C.white, label: 'white building' },
  { color: C.small, label: 'kiosk, shed, pavilion' },
  { color: C.deck, label: 'concrete deck' },
  { color: C.tree, label: 'tree' },
  { color: C.lamp, label: 'lamp post' },
  { color: C.bollard, label: 'bollard' },
  { color: C.boulder, label: 'boulder' },
  { color: C.spawn, label: 'start slot' },
  { color: C.ramp, label: 'ramp' },
  { color: C.pad, label: 'drop pad' },
  { color: C.hedge, label: 'hedge' },
  { color: C.wall, label: 'wall' },
  { color: C.edge, label: 'edge of town' },
];

const f = (v: number): string => (Math.round(v * 100) / 100).toString();
const pts = (q: readonly Point[]): string => q.map(([x, z]) => `${f(x)},${f(z)}`).join(' ');
const esc = (s: string): string =>
  s.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]!);

const BUILDING_FILL: Record<string, string> = {
  'building-brick': C.brick,
  'building-white': C.white,
  stairwell: C.canopy,
  kiosk: C.small,
  'shed-red': C.small,
  'shed-wood': C.small,
  pavilion: C.small,
  deck: C.deck,
};

export default function look(
  data: Record<string, unknown>,
  o: Options = {},
): { svg: string; legend: Legend[] } {
  const asked = /^town-(\d{1,5})-([2-8])$/.exec(o.layout ?? '');
  const generated = asked
    ? true
    : o.layout === 'town'
      ? false
      : (data['rounds'] as { map?: string } | undefined)?.map === 'generated';
  const recipe = { ...RECIPE, ...(data['generator'] as Recipe | undefined) };
  const seed = asked ? Math.min(99999, Math.max(1, Number(asked[1]))) : (o.seed ?? 1),
    cars = asked ? Number(asked[2]) : (o.cars ?? 4);
  const raw = generated
    ? fromPlan(generateLayout(seed, cars, recipe), cars, recipe.pieces)
    : (data['town'] as Layout | undefined);
  const catalogue = (data['pieces'] as { pieces?: Piece[] } | undefined)?.pieces ?? [];
  const prefabs = (data['prefabs'] as { prefabs?: Prefab[] } | undefined)?.prefabs ?? [];
  if (!raw || !raw.size || !raw.bounds)
    return {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><text x="4" y="12" font-size="6">No town to show.</text></svg>',
      legend: [],
    };
  const town = expand(raw, prefabs);
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  const [x0, z0, x1, z1] = o.region ?? [
    town.size.x0,
    town.size.z0,
    town.size.x0 + town.size.w,
    town.size.z0 + town.size.h,
  ];
  const w = x1 - x0,
    h = z1 - z0,
    unit = Math.max(w, h) / 160; // text and line sizes follow the view
  const legendW = 44 * unit;
  const out: string[] = [];
  const el = (s: string): void => {
    out.push(s);
  };

  el(`<rect x="${f(x0)}" y="${f(z0)}" width="${f(w)}" height="${f(h)}" fill="${C.grass}"/>`);
  // tarmac along the streets, then the painted ground over it, then kerbs
  for (const r of town.roads ?? [])
    el(
      `<polyline points="${pts(r.line)}" fill="none" stroke="${C.road}" stroke-width="${f(r.width ?? 7)}"/>`,
    );
  for (const g of town.ground ?? []) el(`<polygon points="${pts(g.poly)}" fill="${C[g.surface]}"/>`);
  for (const g of town.ground ?? [])
    if (g.kerb) el(`<polygon points="${pts(g.poly)}" fill="none" stroke="${C.kerb}" stroke-width="0.25"/>`);
  centreLines(town, el);
  markings(town, el);
  for (const wall of town.walls ?? [])
    el(
      `<polyline points="${pts(wall.line)}" fill="none" stroke="${wall.kind === 'hedge' ? C.hedge : C.wall}" stroke-width="${wall.kind === 'hedge' ? 1.4 : 0.6}"/>`,
    );
  for (const b of town.barriers ?? [])
    el(
      `<line x1="${f(b.line[0][0])}" y1="${f(b.line[0][1])}" x2="${f(b.line[1][0])}" y2="${f(b.line[1][1])}" stroke="${C.barrier}" stroke-width="0.4"/>`,
    );
  for (const z of town.zones ?? [])
    el(
      `<polygon points="${pts(z.poly)}" fill="${z.kind === 'drops' ? C.drops : C.bollard}" fill-opacity="0.18" stroke="${z.kind === 'drops' ? C.drops : C.bollard}" stroke-width="${f(unit * 0.6)}"/>`,
    );
  for (const p of town.pieces ?? []) piece(p, byId.get(p.piece), el);
  // start slots: numbered cars pointing the way they start
  (town.spawns ?? []).forEach((s, i) => {
    el(
      `<polygon points="${pts(boxCorners(s.x, s.z, s.yaw, 0.95, 2.4))}" fill="${C.spawn}" stroke="${C.text}" stroke-width="0.15"/>`,
    );
    el(
      `<polygon points="${pts([toWorld(s.x, s.z, s.yaw, 0, 2.4), toWorld(s.x, s.z, s.yaw, 0.8, 1.2), toWorld(s.x, s.z, s.yaw, -0.8, 1.2)])}" fill="${C.text}"/>`,
    );
    el(
      `<text x="${f(s.x)}" y="${f(s.z + 0.6)}" font-size="1.6" text-anchor="middle" fill="${C.text}">${i + 1}</text>`,
    );
  });
  for (const e of town.exits ?? []) {
    const [ax, az] = toWorld(e.x, e.z, e.yaw, 0, 2),
      [bx, bz] = toWorld(e.x, e.z, e.yaw, 0, 6);
    el(
      `<line x1="${f(ax)}" y1="${f(az)}" x2="${f(bx)}" y2="${f(bz)}" stroke="${C.edge}" stroke-width="0.6"/>`,
    );
  }
  el(
    `<polygon points="${pts(town.bounds.poly)}" fill="none" stroke="${C.edge}" stroke-width="${f(Math.max(0.6, unit * 0.8))}"/>`,
  );
  for (const r of town.regions ?? []) {
    const cx = r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length,
      cz = r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length;
    el(
      `<text x="${f(cx)}" y="${f(cz)}" font-size="${f(unit * 3.4)}" text-anchor="middle" fill="${C.text}" fill-opacity="0.75">${esc(r.name)}</text>`,
    );
  }
  // a scale bar, north, and the legend in a column of its own beside the plan
  const bar = w > 120 ? 50 : w > 40 ? 20 : 5,
    by = z1 - unit * 4;
  el(
    `<rect x="${f(x0 + unit * 3)}" y="${f(by - unit * 1.2)}" width="${f(bar)}" height="${f(unit * 1.2)}" fill="${C.text}"/>`,
  );
  el(
    `<text x="${f(x0 + unit * 3)}" y="${f(by - unit * 2)}" font-size="${f(unit * 3)}" fill="${C.text}">${bar} m · north is up</text>`,
  );
  el(`<rect x="${f(x1)}" y="${f(z0)}" width="${f(legendW)}" height="${f(h)}" fill="${C.panel}"/>`);
  const notes: string[] = [];
  if (generated) notes.push(`a generated town: map ${seed}, ${cars} cars`);
  LEGEND.forEach((l, i) => {
    const y = z0 + unit * (4 + i * 4.4);
    el(
      `<rect x="${f(x1 + unit * 2)}" y="${f(y)}" width="${f(unit * 3)}" height="${f(unit * 3)}" fill="${l.color}" stroke="${C.text}" stroke-width="${f(unit * 0.2)}"/>`,
    );
    el(
      `<text x="${f(x1 + unit * 6.5)}" y="${f(y + unit * 2.5)}" font-size="${f(unit * 2.8)}" fill="${C.text}">${l.label}</text>`,
    );
  });
  notes.forEach((n, i) =>
    el(
      `<text x="${f(x1 + unit * 2)}" y="${f(z1 - unit * (3 + i * 4))}" font-size="${f(unit * 2.4)}" fill="${C.barrier}">${esc(n)}</text>`,
    ),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x0)} ${f(z0)} ${f(w + legendW)} ${f(h)}" width="${Math.round((w + legendW) * 6)}" height="${Math.round(h * 6)}">${out.join('')}</svg>`;
  return { svg, legend: LEGEND };
}

/** The yellow dashes down every street, 3 m every 6 m, stopping short of the junctions. */
function centreLines(town: Layout, el: (s: string) => void): void {
  const ends = town.junctions ?? [];
  for (const r of town.roads ?? []) {
    if (r.centre === false) continue;
    for (let s = 1; s < r.line.length; s++) {
      const [ax, az] = r.line[s - 1]!,
        [bx, bz] = r.line[s]!,
        len = Math.hypot(bx - ax, bz - az);
      if (len < 3) continue;
      const ux = (bx - ax) / len,
        uz = (bz - az) / len;
      const stops = ends
        .filter(([x, z]) => Math.abs((x - ax) * -uz + (z - az) * ux) < 0.5)
        .map(([x, z]) => (x - ax) * ux + (z - az) * uz);
      for (let t = 1.5; t < len - 1.5; t += 6) {
        const t1 = Math.min(t + 3, len - 1.5);
        if (stops.some((q) => q > t - 6.5 && q < t1 + 6.5)) continue;
        el(
          `<line x1="${f(ax + ux * t)}" y1="${f(az + uz * t)}" x2="${f(ax + ux * t1)}" y2="${f(az + uz * t1)}" stroke="${C.centre}" stroke-width="0.15"/>`,
        );
      }
    }
  }
}

function markings(town: Layout, el: (s: string) => void): void {
  for (const m of town.markings ?? []) {
    if (m.type === 'bays') {
      for (let r = 0; r < m.rows; r++) {
        const lx = -5 + r * 16.5,
          L = m.n * 1.25;
        for (let i = 0; i <= m.n; i++) {
          const [ax, az] = toWorld(m.x, m.z, m.yaw, lx, -L + i * 2.5),
            [bx, bz] = toWorld(m.x, m.z, m.yaw, lx + 10, -L + i * 2.5);
          el(
            `<line x1="${f(ax)}" y1="${f(az)}" x2="${f(bx)}" y2="${f(bz)}" stroke="${C.paint}" stroke-width="0.12"/>`,
          );
        }
        const [ax, az] = toWorld(m.x, m.z, m.yaw, lx + 5, -L),
          [bx, bz] = toWorld(m.x, m.z, m.yaw, lx + 5, L);
        el(
          `<line x1="${f(ax)}" y1="${f(az)}" x2="${f(bx)}" y2="${f(bz)}" stroke="${C.paint}" stroke-width="0.12"/>`,
        );
      }
    } else if (m.type === 'hatch') {
      el(
        `<polygon points="${pts(m.poly)}" fill="${C.centre}" fill-opacity="0.35" stroke="${C.centre}" stroke-width="0.15"/>`,
      );
    } else if (m.type === 'zebra') {
      const [[ax, az], [bx, bz]] = m.line,
        len = Math.hypot(bx - ax, bz - az),
        ux = (bx - ax) / len,
        uz = (bz - az) / len,
        d = m.depth / 2;
      for (let s = 0.3; s < len - 0.3; s += 1) {
        const cx = ax + ux * s,
          cz = az + uz * s;
        el(
          `<polygon points="${pts([
            [cx - uz * d, cz + ux * d],
            [cx - uz * d + ux * 0.5, cz + ux * d + uz * 0.5],
            [cx + uz * d + ux * 0.5, cz - ux * d + uz * 0.5],
            [cx + uz * d, cz - ux * d],
          ])}" fill="${C.paint}"/>`,
        );
      }
    } else if (m.type === 'giveWay') {
      for (let k = 0.3; k < 3; k += 0.9) {
        el(
          `<polygon points="${pts([toWorld(m.x, m.z, m.yaw, -k, -3.8), toWorld(m.x, m.z, m.yaw, -k - 0.6, -3.8), toWorld(m.x, m.z, m.yaw, -k - 0.3, -4.6)])}" fill="${C.paint}"/>`,
        );
      }
    }
  }
}

function piece(p: Placement, def: Piece | undefined, el: (s: string) => void): void {
  // drawn as its asset looks (town/rowan is a rowan whatever the piece is called), else by its collider
  const yaw = p.yaw ?? 0,
    c = def?.collider,
    look = def?.asset.replace(/^town\//, '') ?? p.piece;
  const fill = BUILDING_FILL[look];
  if (look === 'deck') {
    const hw = (p.w ?? 11) / 2,
      hl = (p.l ?? 20) / 2;
    const [bx, bz] = toWorld(p.x, p.z, yaw, 0, -hw / 2),
      [ex, ez] = toWorld(p.x, p.z, yaw, 0, hl - hw);
    el(
      `<polygon points="${pts(boxCorners(bx, bz, yaw, hw, (2 * hl - hw) / 2))}" fill="${C.deck}" stroke="${C.text}" stroke-width="0.15"/>`,
    );
    el(`<circle cx="${f(ex)}" cy="${f(ez)}" r="${f(hw)}" fill="${C.deck}"/>`);
  } else if (look === 'ramp') {
    const hw = (p.w ?? 5) / 2,
      hl = (p.l ?? 6) / 2;
    el(
      `<polygon points="${pts(boxCorners(p.x, p.z, yaw, hw, hl))}" fill="${C.ramp}" stroke="${C.text}" stroke-width="0.15"/>`,
    );
    el(
      `<polygon points="${pts([toWorld(p.x, p.z, yaw, 0, hl * 0.8), toWorld(p.x, p.z, yaw, hw * 0.6, -hl * 0.4), toWorld(p.x, p.z, yaw, -hw * 0.6, -hl * 0.4)])}" fill="${C.text}" fill-opacity="0.6"/>`,
    );
  } else if (look === 'drop-pad') {
    el(`<circle cx="${f(p.x)}" cy="${f(p.z)}" r="2" fill="none" stroke="${C.pad}" stroke-width="0.5"/>`);
  } else if (fill && c?.shape === 'box') {
    el(
      `<polygon points="${pts(boxCorners(p.x, p.z, yaw, (p.w ?? c.w ?? 1) / 2, (p.l ?? c.l ?? 1) / 2))}" fill="${fill}" stroke="${C.text}" stroke-width="0.15"/>`,
    );
  } else if (look === 'rowan' || look === 'poplar') {
    el(
      `<circle cx="${f(p.x)}" cy="${f(p.z)}" r="${look === 'rowan' ? 1.6 : 1.1}" fill="${C.tree}" fill-opacity="0.85"/>`,
    );
  } else if (look === 'lamp') {
    el(`<circle cx="${f(p.x)}" cy="${f(p.z)}" r="0.42" fill="${C.lamp}"/>`);
  } else if (look === 'bollard') {
    el(`<circle cx="${f(p.x)}" cy="${f(p.z)}" r="0.3" fill="${C.bollard}"/>`);
  } else if (look === 'boulder') {
    el(`<circle cx="${f(p.x)}" cy="${f(p.z)}" r="${f((p.r ?? 0.7) * 1.1)}" fill="${C.boulder}"/>`);
  } else if (look === 'canopy') {
    el(
      `<polygon points="${pts(boxCorners(p.x, p.z, yaw, 2.15, 1.7))}" fill="${C.canopy}" fill-opacity="0.8"/>`,
    );
  } else if (c?.shape === 'box') {
    el(
      `<polygon points="${pts(boxCorners(p.x, p.z, yaw, (p.w ?? c.w ?? 1) / 2, (p.l ?? c.l ?? 1) / 2))}" fill="${C.small}"/>`,
    );
  } else if (c?.shape === 'circle') {
    el(
      `<circle cx="${f(p.x)}" cy="${f(p.z)}" r="${f(c.r * (c.scaled ? (p.r ?? 1) : 1))}" fill="${C.small}"/>`,
    );
  }
}
