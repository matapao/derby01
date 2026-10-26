/**
 * The checks only derby01 knows how to make, run by the host on every data proposal (and by the
 * tests): ids that must be unique and references that must exist, values that must come in order,
 * and for the town, that pieces fit their sizes, nothing solid overlaps, start slots are clear, and
 * a car can drive from every start slot to the ring road. It also counts pieces and triangles for the
 * budgets in zirbel.build.json. Pure and quick: no DOM, no fetch, a few milliseconds.
 */
import assets from '../../assets/assets.json' with { type: 'json' };
import { RECIPE, generateLayout, type Recipe } from '../layout.ts';
import { colliders, expand, type Obstacle } from '../town/colliders.ts';
import { fromPlan } from '../town/from-plan.ts';
import { boxCorners, edgeDistance, insidePoly } from '../town/geometry.ts';
import type { Layout, Piece, Prefab } from '../town/types.ts';

export interface Problem {
  block: string;
  path: string;
  message: string;
}
export interface Report {
  problems: Problem[];
  counts: Record<string, number>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

const TRIANGLES = new Map(
  (assets as { id: string; lod?: { triangles: number }[] }[]).map((a) => [a.id, a.lod?.[0]?.triangles ?? 0]),
);
const CAR_HALF = { w: 0.97, l: 2.5 };
const CELL = 1.5;
const PAD_R = 2; // a drop pad's radius, as the engine paints it

export default function check(data: Record<string, unknown>): Report {
  const problems: Problem[] = [];
  const say = (block: string, path: string, message: string): void => {
    problems.push({ block, path, message });
  };

  // ---- ids and references ----
  const ids = (block: string, list: unknown[], at: string): Set<string> => {
    const seen = new Set<string>();
    list.forEach((x, i) => {
      const id = obj(x)['id'];
      if (typeof id !== 'string') return;
      if (seen.has(id)) say(block, `${at}/${i}/id`, `the id "${id}" is used twice`);
      seen.add(id);
    });
    return seen;
  };
  const kits = ids('kits', arr(obj(data['kits'])['kits']), '/kits');
  const pieceList = arr(obj(data['pieces'])['pieces']) as Piece[];
  const pieceIds = ids('pieces', pieceList, '/pieces');
  const prefabList = arr(obj(data['prefabs'])['prefabs']) as Prefab[];
  const prefabIds = ids('prefabs', prefabList, '/prefabs');
  ids('teams', arr(obj(data['teams'])['teams']), '/teams');
  arr(obj(data['kits'])['defaults']).forEach((k, i) => {
    if (typeof k === 'string' && !kits.has(k)) say('kits', `/defaults/${i}`, `no kit is called "${k}"`);
  });
  for (const [k, v] of Object.entries(obj(obj(data['generator'])['pieces'])))
    if (typeof v === 'string' && !pieceIds.has(v))
      say('generator', `/pieces/${k}`, `no piece is called "${v}"`);
  prefabList.forEach((p, i) =>
    (p.pieces ?? []).forEach((q, k) => {
      if (!pieceIds.has(q.piece))
        say('prefabs', `/prefabs/${i}/pieces/${k}/piece`, `no piece is called "${q.piece}"`);
    }),
  );

  // ---- values that must come in order, or differ ----
  const ui = new Map<string, number>();
  arr(obj(data['teams'])['teams']).forEach((t, i) => {
    const c = String(obj(t)['ui']).toLowerCase();
    if (ui.has(c))
      say(
        'teams',
        `/teams/${i}/ui`,
        `the same ui colour as team ${ui.get(c)! + 1}: paint colours tell the screens whose a hit is`,
      );
    ui.set(c, i);
  });
  const order = (block: string, path: string, lo: unknown, hi: unknown, what: string): void => {
    if (num(lo) > num(hi)) say(block, path, what);
  };
  const spares = obj(obj(data['mechanic'])['spares']);
  for (const k of ['fuel', 'tyres', 'bumpers', 'glass'])
    order(
      'mechanic',
      `/spares/start/${k}`,
      obj(spares['start'])[k],
      obj(spares['max'])[k],
      'a car starts with more than it can carry',
    );
  // fuel comes from a can, poured: the pour game is fuel's, and fuel's game is the pour
  for (const [kind, job] of Object.entries(obj(obj(data['mechanic'])['jobs']))) {
    const game = obj(job)['game'];
    if (kind === 'fuel' && game !== 'pour')
      say('mechanic', '/jobs/fuel/game', 'fuel is poured from a can: its game must be pour');
    if (kind !== 'fuel' && game === 'pour') say('mechanic', `/jobs/${kind}/game`, 'only fuel is poured');
  }
  const glue = obj(obj(obj(data['mechanic'])['games'])['glue']);
  order('mechanic', '/games/glue/low', glue['low'], glue['high'], 'the green band is upside down');
  const burn = obj(obj(data['points'])['burn']);
  order(
    'points',
    '/burn/min',
    burn['min'],
    burn['max'],
    'a burn is banked at max seconds, before it starts to pay at min',
  );
  const drops = obj(data['drops']);
  order('drops', '/atStart', drops['atStart'], drops['max'], 'more drops at the start than may lie about');
  order(
    'drops',
    '/every/0',
    arr(drops['every'])[0],
    arr(drops['every'])[1],
    'the shortest wait is longer than the longest',
  );
  const bots = obj(data['bots']);
  for (const k of ['unjam', 'rest'])
    order('bots', `/${k}/0`, arr(bots[k])[0], arr(bots[k])[1], 'the shortest is longer than the longest');
  const car = obj(data['car']);
  order(
    'car',
    '/lights/flicker',
    obj(car['lights'])['flicker'],
    obj(car['lights'])['out'],
    'the lights go out before they flicker',
  );
  for (const t of ['hood', 'trunk'])
    order(
      'car',
      `/turrets/${t}/pitchMin`,
      obj(obj(car['turrets'])[t])['pitchMin'],
      obj(obj(car['turrets'])[t])['pitchMax'],
      'the turret tilts down further than up',
    );
  const gen = obj(data['generator']);
  const ranges: [string, unknown][] = [
    ['/blocks/w', obj(gen['blocks'])['w']],
    ['/blocks/d', obj(gen['blocks'])['d']],
    ['/square/w', obj(gen['square'])['w']],
    ['/square/d', obj(gen['square'])['d']],
    ['/square/bays', obj(gen['square'])['bays']],
    ['/square/stalls', obj(gen['square'])['stalls']],
    ['/square/islands', obj(gen['square'])['islands']],
    ['/corners/cuts', obj(gen['corners'])['cuts']],
    ['/corners/length', obj(gen['corners'])['length']],
    ['/office/depth', obj(gen['office'])['depth']],
    ['/office/length', obj(gen['office'])['length']],
    ['/park/every', obj(gen['park'])['every']],
    ['/lamps/every', obj(gen['lamps'])['every']],
    ['/trees/every', obj(gen['trees'])['every']],
  ];
  for (const [p, r] of ranges)
    order('generator', p, arr(r)[0], arr(r)[1], 'the smallest is bigger than the largest');
  pieceList.forEach((p, i) => {
    for (const [k, r] of Object.entries(p.size ?? {}))
      if (r && r[0] > r[1])
        say('pieces', `/pieces/${i}/size/${k}`, 'the smallest is bigger than the largest');
    // whatever has no size of its own takes it from the placement, so the placement must be able to give it
    const c = obj(p.collider),
      needs = new Set<string>();
    if (c['shape'] === 'box') for (const k of ['w', 'l', 'h']) if (c[k] === undefined) needs.add(k);
    if (c['shape'] === 'rounded') ['w', 'l', 'h'].forEach((k) => needs.add(k));
    if (c['shape'] === 'circle' && c['scaled']) needs.add('r');
    if (arr(p.components).some((x) => obj(x)['type'] === 'ramp'))
      ['w', 'l', 'h'].forEach((k) => needs.add(k));
    for (const k of needs)
      if (!p.size?.[k as 'w'])
        say(
          'pieces',
          `/pieces/${i}/size`,
          `a ${p.id} takes its ${k} from where it is placed, so it needs a size range for ${k}`,
        );
    const kinds = arr(p.components).map((x) => obj(x)['type']);
    if (kinds.includes('breakable') && c['shape'] !== 'circle')
      say('pieces', `/pieces/${i}/collider`, 'only round things (a circle collider) can give way');
  });

  // ---- the town ----
  const counts: Record<string, number> = { pieces: 0, triangles: 0 };
  const raw = data['town'] as Layout | undefined;
  if (raw && typeof raw === 'object' && raw.bounds && Array.isArray(raw.bounds.poly)) {
    (raw.prefabs ?? []).forEach((u, i) => {
      if (!prefabIds.has(u.prefab)) say('town', `/prefabs/${i}/prefab`, `no prefab is called "${u.prefab}"`);
    });
    const town = expand(raw, prefabList);
    checkTown(town, (raw.pieces ?? []).length, pieceList, say, counts);
  }
  // with generated towns, the recipe has to make a good one: one of them is checked the same way
  if (obj(data['rounds'])['map'] === 'generated' && data['generator']) {
    const recipe = data['generator'] as Recipe,
      pieces = { ...RECIPE.pieces, ...recipe.pieces };
    try {
      const made = fromPlan(generateLayout(1, 4, { ...RECIPE, ...recipe }), 4, pieces),
        extra: Record<string, number> = { pieces: 0, triangles: 0 };
      checkTown(
        made,
        (made.pieces ?? []).length,
        pieceList,
        (_b, p, m) => say('generator', p, `in the town it makes for map 1 and four cars: ${m}`),
        extra,
      );
      counts['generatedPieces'] = extra['pieces']!;
    } catch (e) {
      say('generator', '', `the generator fails with this recipe: ${String(e)}`);
    }
  }
  return { problems, counts };
}

function checkTown(
  town: Layout,
  own: number,
  catalogue: Piece[],
  say: (b: string, p: string, m: string) => void,
  counts: Record<string, number>,
): void {
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  const B = town.bounds.poly,
    S = town.size;
  if (B.some(([x, z]) => x < S.x0 || z < S.z0 || x > S.x0 + S.w || z > S.z0 + S.h))
    say('town', '/bounds/poly', 'the edge goes outside the painted ground (size)');
  // where a placement came from: the town's own list, or a prefab it placed
  const where = (i: number): string => (i < own ? `/pieces/${i}` : '/prefabs');
  const pieces = town.pieces ?? [];
  pieces.forEach((p, i) => {
    const def = byId.get(p.piece);
    if (!def) {
      say('town', `${where(i)}/piece`, `no piece is called "${p.piece}"`);
      return;
    }
    counts['pieces']!++;
    counts['triangles']! += TRIANGLES.get(def.asset) ?? 0;
    for (const k of ['w', 'l', 'h', 'r'] as const) {
      const range = def.size?.[k],
        v = p[k];
      if (range && v === undefined) say('town', `${where(i)}`, `a ${p.piece} needs ${k}`);
      else if (range && v !== undefined && (v < range[0] || v > range[1]))
        say('town', `${where(i)}/${k}`, `a ${p.piece}'s ${k} must be between ${range[0]} and ${range[1]}`);
      else if (!range && v !== undefined && def.collider.shape !== 'circle')
        say('town', `${where(i)}/${k}`, `a ${p.piece} has one size: leave ${k} out`);
    }
    if (!p.outer && edgeDistance(p.x, p.z, B) > 0.5)
      say('town', `${where(i)}`, `a ${p.piece} outside the edge must say outer: true`);
  });
  if (counts['pieces']! > 0 && (town.ground ?? []).length === 0)
    say('town', '/ground', 'no painted ground: everything would be grass');

  const solid = colliders(town, catalogue);
  const blocking = solid.filter((o) => !o.breakable);
  // solid things overlapping each other (touching is fine)
  for (let i = 0; i < blocking.length; i++)
    for (let k = i + 1; k < blocking.length; k++) {
      const a = blocking[i]!,
        b = blocking[k]!;
      if (a.index >= 0 && a.index === b.index) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) > reachOf(a) + reachOf(b)) continue;
      if (overlap(a, b) > 0.05)
        say(
          'town',
          a.index >= 0 ? where(a.index) : '/walls',
          `a ${a.piece} overlaps a ${b.piece}${b.index >= 0 ? ` (${where(b.index)})` : ''}`,
        );
    }
  // posts and trees standing inside a building
  for (const o of solid) {
    if (o.kind !== 'circle' || !o.breakable) continue;
    for (const b of blocking)
      if (b.kind === 'box' && overlap(o, b) > o.r + 0.05) {
        say('town', where(o.index), `a ${o.piece} stands inside a ${b.piece}`);
        break;
      }
  }
  // ramps and drop pads lie on the ground, inside the edge, with nothing standing on them
  pieces.forEach((p, i) => {
    const def = byId.get(p.piece);
    const ramp = !!def?.components.some((c) => c.type === 'ramp'),
      pad = !!def?.components.some((c) => c.type === 'dropPad');
    if (!ramp && !pad) return;
    const yaw = p.yaw ?? 0,
      base = { x: p.x, z: p.z, yaw, r: 0, hw: 0, hl: 0, h: 0, index: i, piece: p.piece };
    const foot: Obstacle = ramp
      ? { ...base, kind: 'box', hw: (p.w ?? 1) / 2, hl: (p.l ?? 1) / 2 }
      : { ...base, kind: 'circle', r: PAD_R };
    for (const o of solid) {
      if (Math.hypot(o.x - foot.x, o.z - foot.z) > reachOf(o) + reachOf(foot) || overlap(foot, o) <= 0.05)
        continue;
      say(
        'town',
        where(i),
        `a ${p.piece} overlaps a ${o.piece}${o.index >= 0 ? ` (${where(o.index)})` : ''}`,
      );
      break;
    }
    const corners = ramp ? boxCorners(p.x, p.z, yaw, foot.hw, foot.hl) : [[p.x, p.z] as [number, number]];
    if (corners.some(([x, z]) => edgeDistance(x, z, B) > (ramp ? 0 : -PAD_R)))
      say('town', where(i), `a ${p.piece} must lie inside the edge`);
  });

  // start slots: inside the edge, clear, apart
  const spawns = town.spawns ?? [];
  spawns.forEach((s, i) => {
    const corners = boxCorners(s.x, s.z, s.yaw, CAR_HALF.w, CAR_HALF.l);
    if (corners.some(([x, z]) => edgeDistance(x, z, B) > -0.2))
      say('town', `/spawns/${i}`, 'a car starting here sticks out of the edge');
    const box: Obstacle = {
      kind: 'box',
      x: s.x,
      z: s.z,
      yaw: s.yaw,
      hw: CAR_HALF.w + 0.3,
      hl: CAR_HALF.l + 0.3,
      r: 0,
      h: 2,
      index: -1,
      piece: 'car',
    };
    for (const o of solid)
      if (overlap(box, o) > 0) {
        say('town', `/spawns/${i}`, `a car starting here touches a ${o.piece}`);
        break;
      }
    spawns.slice(0, i).forEach((t, k) => {
      if (Math.hypot(s.x - t.x, s.z - t.z) < 5)
        say('town', `/spawns/${i}`, `less than 5 m from start slot ${k + 1}`);
    });
  });
  if (town.spawns && spawns.length < 2)
    say('town', '/spawns', 'a round needs at least two cars, so two start slots');

  reach(town, blocking, say, counts);
}

/** How far a collider reaches from its middle. */
const reachOf = (o: Obstacle): number => (o.kind === 'circle' ? o.r : Math.hypot(o.hw, o.hl));

/** How far two colliders overlap (0 or less: they don't). */
function overlap(a: Obstacle, b: Obstacle): number {
  if (a.kind === 'circle' && b.kind === 'circle') return a.r + b.r - Math.hypot(a.x - b.x, a.z - b.z);
  if (a.kind === 'circle' || b.kind === 'circle') {
    const c = a.kind === 'circle' ? a : b,
      q = a.kind === 'circle' ? b : a;
    const s = Math.sin(q.yaw),
      co = Math.cos(q.yaw),
      rx = c.x - q.x,
      rz = c.z - q.z;
    const lx = rx * co - rz * s,
      lz = rx * s + rz * co;
    const dx = Math.max(Math.abs(lx) - q.hw, 0),
      dz = Math.max(Math.abs(lz) - q.hl, 0);
    return c.r - Math.hypot(dx, dz);
  }
  // two boxes: the smallest overlap along the four axes
  let best = Infinity;
  for (const yaw of [a.yaw, a.yaw + Math.PI / 2, b.yaw, b.yaw + Math.PI / 2]) {
    const ux = Math.sin(yaw),
      uz = Math.cos(yaw);
    const extent = (o: Obstacle): number =>
      o.hl * Math.abs(Math.sin(o.yaw) * ux + Math.cos(o.yaw) * uz) +
      o.hw * Math.abs(Math.cos(o.yaw) * ux - Math.sin(o.yaw) * uz);
    const d = Math.abs((b.x - a.x) * ux + (b.z - a.z) * uz);
    best = Math.min(best, extent(a) + extent(b) - d);
  }
  return best;
}

/**
 * Can a car get round the town from the ring road, and from every start slot to it? A grid of
 * 1.5 m cells over the town: a cell is open when a car's middle fits there (inside the edge, clear of
 * everything solid that doesn't give way).
 */
function reach(
  town: Layout,
  blocking: Obstacle[],
  say: (b: string, p: string, m: string) => void,
  counts: Record<string, number>,
): void {
  const { x0, z0, w, h } = town.size,
    nx = Math.ceil(w / CELL),
    nz = Math.ceil(h / CELL);
  const open = new Uint8Array(nx * nz);
  const cx = (i: number): number => x0 + (i + 0.5) * CELL,
    cz = (k: number): number => z0 + (k + 0.5) * CELL;
  const pad = CAR_HALF.w,
    padSquared = pad * pad;
  // This is a clearance predicate, so no nearest distance or square root is needed. Prepare
  // edges once for this proposal; bounds may be mutated in place between calls to check().
  const boundary = town.bounds.poly.map(([bx, bz], i, points) => {
    const [ax, az] = points[(i + points.length - 1) % points.length]!;
    const ex = bx - ax,
      ez = bz - az;
    return { ax, az, ex, ez, lengthSquared: ex * ex + ez * ez };
  });
  const fitsBoundary = (x: number, z: number): boolean => {
    if (!insidePoly(x, z, town.bounds.poly)) return false;
    for (const { ax, az, ex, ez, lengthSquared } of boundary) {
      const t =
        lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / lengthSquared)) : 0;
      const dx = x - ax - ex * t,
        dz = z - az - ez * t;
      if (dx * dx + dz * dz <= padSquared) return false;
    }
    return true;
  };
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) open[k * nx + i] = fitsBoundary(cx(i), cz(k)) ? 1 : 0;
  for (const o of blocking) {
    const ext = reachOf(o) + pad,
      s = Math.sin(o.yaw),
      c = Math.cos(o.yaw);
    const i0 = Math.max(0, Math.floor((o.x - ext - x0) / CELL)),
      i1 = Math.min(nx - 1, Math.floor((o.x + ext - x0) / CELL));
    const k0 = Math.max(0, Math.floor((o.z - ext - z0) / CELL)),
      k1 = Math.min(nz - 1, Math.floor((o.z + ext - z0) / CELL));
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) {
        const rx = cx(i) - o.x,
          rz = cz(k) - o.z;
        // how far the cell's middle is from the collider: a car's half width or less, and it doesn't fit
        const d =
          o.kind === 'circle'
            ? Math.hypot(rx, rz) - o.r
            : Math.hypot(
                Math.max(Math.abs(rx * c - rz * s) - o.hw, 0),
                Math.max(Math.abs(rx * s + rz * c) - o.hl, 0),
              );
        if (d < pad) open[k * nx + i] = 0;
      }
  }
  const cell = (x: number, z: number): number => {
    const i = Math.floor((x - x0) / CELL),
      k = Math.floor((z - z0) / CELL);
    return i < 0 || k < 0 || i >= nx || k >= nz ? -1 : k * nx + i;
  };
  // the ring road, sampled every 4 m: where a car can be on it
  const ring: number[] = [];
  for (const r of town.roads ?? []) {
    if (!r.ring) continue;
    for (let k = 1; k < r.line.length; k++) {
      const [ax, az] = r.line[k - 1]!,
        [bx, bz] = r.line[k]!,
        len = Math.hypot(bx - ax, bz - az);
      for (let t = 2; t < len - 2; t += 4) {
        const c = cell(ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len);
        if (c >= 0 && open[c]) ring.push(c);
      }
    }
  }
  const spawns = (town.spawns ?? []).map((s) => cell(s.x, s.z));
  const first = ring[0] ?? spawns.find((c) => c >= 0 && open[c]);
  if (first === undefined) {
    say('town', '/roads', 'no ring road a car fits on, and no start slot with room for a car');
    return;
  }
  const seen = new Uint8Array(nx * nz),
    queue = [first];
  seen[first] = 1;
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (queue.length) {
    const c = queue.pop()!,
      i = c % nx,
      k = (c - i) / nx;
    for (const [di, dk] of neighbors) {
      const ii = i + di,
        kk = k + dk;
      if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
      const n = kk * nx + ii;
      if (open[n] && !seen[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  spawns.forEach((c, i) => {
    if (c < 0 || !seen[c]) say('town', `/spawns/${i}`, 'a car starting here cannot drive to the ring road');
  });
  const reached = ring.filter((c) => seen[c]).length;
  if (ring.length > 0 && reached < ring.length * 0.9)
    say('town', '/roads', `only ${Math.round((reached / ring.length) * 100)} % of the ring road joins up`);
  let all = 0,
    got = 0;
  for (let c = 0; c < open.length; c++)
    if (open[c]) {
      all++;
      if (seen[c]) got++;
    }
  if (all > 0 && got < all * 0.9)
    say(
      'town',
      '',
      `${Math.round(((all - got) / all) * 100)} % of the open ground is shut off from the ring road`,
    );
  counts['drivable'] = Math.round(got * CELL * CELL);
  if (town.zones?.some((z) => z.kind === 'drops')) {
    const any = (town.zones ?? [])
      .filter((z) => z.kind === 'drops')
      .some((z) => {
        for (let c = 0; c < open.length; c++)
          if (seen[c] && insidePoly(cx(c % nx), cz((c - (c % nx)) / nx), z.poly)) return true;
        return false;
      });
    if (!any) say('town', '/zones', 'no drop zone has ground a car can reach');
  }
}
