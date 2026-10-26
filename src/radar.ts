import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import { gunAt, isGunSeat } from './gameplay/guns.ts';
import { canvasContext } from './browser-dom.ts';
import * as THREE from 'three';
import { CARDIM, TAU, TEAMS, _v1, clamp, rand, wrapPi } from './core.ts';
import { BOUNDS, OBSTACLES } from './world.ts';
import { TOWN } from './arena-state.ts';
import { G } from './state.ts';
import { RADAR } from './radar-model.ts';
import { addDebris, sparks } from './fx.ts';
import { SFX } from './audio.ts';
import { scoreRadar } from './score.ts';
import { carToWorld } from './gameplay/geometry.ts';
import { DROP_TYPES } from './drop-data.ts';
import { drawArrow2 } from './canvas-shapes.ts';
import { noteFx, radarHitFx } from './sharedfx.ts';
import {} from './data.ts';

// =====================================================================
//  Roof radar: a little rotating antenna on every car. It feeds the radar screen of everyone
//  in that car: cars show up as blips when the sweep passes them, then fade until the next pass.
//  Paintballs and hard knocks damage it (the screen stutters and fills with static);
//  knocked off, the screen goes dark until the mechanic fixes it.
// =====================================================================
// A paintball or a knock. Knocked off when it runs out.
export function damageRadar(car: Car, amount: number, source: Car | null = null) {
  const R = car.radar;
  if (!R || R.destroyed || !car.alive || amount <= 0 || G.state !== 'playing') return;
  R.hp -= amount;
  radarHitFx(car);
  if (R.hp > 0) return;
  knockRadarOff(car);
  noteFx(car, 0); // RADAR DOWN!
  scoreRadar(car, source);
}

// Gone: the head flies off and the mast is left bent and sparking.
export function knockRadarOff(car: Car) {
  const R = car.radar;
  R.destroyed = true;
  R.hp = 0;
  if (!R.head) return;
  const p = carToWorld(car, 0, CARDIM.top + RADAR.headY, RADAR.z, new THREE.Vector3());
  R.head.updateWorldMatrix(true, false);
  const pos = new THREE.Vector3(),
    quat = new THREE.Quaternion();
  R.head.matrixWorld.decompose(pos, quat, new THREE.Vector3());
  R.rig.remove(R.head);
  addDebris(
    R.head,
    pos,
    quat,
    new THREE.Vector3(car.vel.x * 0.5 + rand(-3, 3), rand(4, 7), car.vel.z * 0.5 + rand(-3, 3)),
    10,
  );
  R.head = null;
  R.stem.rotation.set(rand(-0.6, 0.6), 0, rand(-0.6, 0.6));
  R.contacts.clear();
  R.drops.clear();
  sparks(p.x, p.y, p.z, 24, 6);
  SFX.clank(p);
}

// Every frame: turn the antenna and pick up whatever the beam swept over.
export function updateRadar(car: Car, dt: number) {
  const R = car.radar;
  if (!car.alive || R.destroyed) {
    if (R.destroyed && car.alive && (R.sparkT -= dt) <= 0) {
      // the broken mast spits sparks now and then
      R.sparkT = rand(0.3, 1.2);
      const p = carToWorld(car, 0, CARDIM.top + RADAR.headY, RADAR.z, _v1);
      sparks(p.x, p.y, p.z, 4, 2);
    }
    return;
  }
  const health = R.hp / RADAR.hp;
  let w = TAU / RADAR.period;
  if (health < 0.5) w *= 0.45 + 0.55 * Math.abs(Math.sin(G.time * 2.7 + car.idx)); // a damaged one stutters
  const prev = R.world;
  R.local = (R.local + w * dt) % TAU;
  if (R.head) R.head.rotation.y = R.local;
  R.world = car.yaw + R.local;
  const swept = wrapPi(R.world - prev);
  if (swept <= 0 || G.state === 'menu') return;
  const miss = (1 - health) * 0.6; // and misses things
  const seen = (x: number, z: number) => {
    const dx = x - car.pos.x,
      dz = z - car.pos.z;
    if (dx * dx + dz * dz > RADAR.range * RADAR.range) return false;
    const off = (((Math.atan2(dx, dz) - prev) % TAU) + TAU) % TAU;
    return off <= swept && Math.random() >= miss;
  };
  for (const t of G.cars) {
    if (t !== car && seen(t.pos.x, t.pos.z))
      R.contacts.set(t, { x: t.pos.x, z: t.pos.z, yaw: t.yaw, t: G.time, alive: t.alive });
  }
  for (const d of G.drops) if (d.taken < 0 && seen(d.x, d.z)) R.drops.set(d, G.time);
  if (health < 0.5 && (R.sparkT -= dt) <= 0) {
    R.sparkT = rand(0.5, 2) * (0.5 + health);
    const p = carToWorld(car, 0, CARDIM.top + RADAR.headY, RADAR.z, _v1);
    sparks(p.x, p.y, p.z, 3, 2);
  }
}

// Ray against the radar head (a small sphere above the roof). Returns t or null.
const _rc = new THREE.Vector3();
export function rayRadar(o: THREE.Vector3, d: THREE.Vector3, car: Car, maxT: number) {
  const R = car.radar;
  if (!R || R.destroyed || !car.alive) return null;
  carToWorld(car, 0, CARDIM.top + RADAR.headY, RADAR.z, _rc);
  const fx = o.x - _rc.x,
    fy = o.y - _rc.y,
    fz = o.z - _rc.z;
  const b = fx * d.x + fy * d.y + fz * d.z,
    c = fx * fx + fy * fy + fz * fz - RADAR.hitR * RADAR.hitR;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < maxT ? t : null;
}

// ---------------------------------------------------------------------
//  The radar screen (bottom right of every view except the mechanic's).
//  Centred on the car, its nose pointing up. The sweep turns with the antenna on the roof.
// ---------------------------------------------------------------------
const RADAR_MAP: {
  x0: number;
  z0: number;
  w: number;
  h: number;
  cv: HTMLCanvasElement | null;
  town: typeof TOWN;
} = { x0: 0, z0: 0, w: 1, h: 1, cv: null, town: null }; // the town, drawn once for each map
function radarMap() {
  if (RADAR_MAP.cv && RADAR_MAP.town === TOWN) return RADAR_MAP.cv;
  if (!TOWN) throw new Error('Town is not built');
  Object.assign(RADAR_MAP, TOWN.size);
  const k = 3,
    M = RADAR_MAP,
    cv = document.createElement('canvas');
  cv.width = M.w * k;
  cv.height = M.h * k;
  const g = canvasContext(cv);
  const X = (x: number) => (x - M.x0) * k,
    Z = (z: number) => (z - M.z0) * k;
  const poly = (P: import('./layout.ts').Pt[]) => {
    g.beginPath();
    P.forEach(([x, z], i: number) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
    g.closePath();
  };
  g.fillStyle = 'rgba(40,150,80,0.28)';
  for (const a of TOWN.ground ?? [])
    if (a.surface !== 'grass') {
      poly(a.poly);
      g.fill();
    }
  g.globalCompositeOperation = 'destination-out'; // the grass: parks, islands and beds
  for (const a of TOWN.ground ?? [])
    if (a.surface === 'grass') {
      poly(a.poly);
      g.fill();
    }
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = 'rgba(12,70,34,0.95)';
  g.strokeStyle = '#46ff8f';
  g.lineWidth = 1.6;
  for (const o of OBSTACLES) {
    if (o.kind === 'box' && o.h >= 2.4) {
      const s = Math.sin(o.yaw),
        c = Math.cos(o.yaw);
      poly(
        (
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ] satisfies [number, number][]
        ).map(([a, b]) => [o.x + c * o.hw * a + s * o.hl * b, o.z - s * o.hw * a + c * o.hl * b]),
      );
      g.fill();
      g.stroke();
    } else if (o.kind === 'circle' && o.r >= 3) {
      g.beginPath();
      g.arc(X(o.x), Z(o.z), o.r * k, 0, TAU);
      g.fill();
      g.stroke();
    }
  }
  poly(BOUNDS.pts);
  g.strokeStyle = 'rgba(90,255,150,0.75)';
  g.lineWidth = 2.2;
  g.stroke();
  RADAR_MAP.cv = cv;
  RADAR_MAP.town = TOWN;
  return cv;
}

export function drawRadarScreen(h: import('./human-types.ts').LocalHuman) {
  if (!h.hud) return;
  const cv = h.hud.map,
    c = canvasContext(cv),
    W = cv.width,
    H = cv.height;
  const cx = W / 2,
    cy = H / 2,
    R0 = Math.min(W, H) / 2 - 3,
    unit = Math.max(4, R0 / 11);
  const car = h.dead ? h.watch || h.car : h.car,
    R = car.radar;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  c.save();
  c.beginPath();
  c.arc(cx, cy, R0, 0, TAU);
  c.clip();
  const bg = c.createRadialGradient(cx, cy, 0, cx, cy, R0);
  bg.addColorStop(0, '#04301a');
  bg.addColorStop(1, '#011208');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  const down = !R || R.destroyed || !car.alive;
  if (down) {
    // static and NO SIGNAL
    for (let i = 0; i < 260; i++) {
      c.fillStyle = `rgba(80,255,140,${rand(0.05, 0.35)})`;
      c.fillRect(rand(0, W), rand(0, H), rand(1, 3), rand(1, 2));
    }
    c.fillStyle = '#ff5468';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `400 ${Math.round(R0 * 0.2)}px Bungee, Impact, sans-serif`;
    c.fillText('NO SIGNAL', cx, cy - R0 * 0.08);
    c.fillStyle = '#7dffb0';
    c.font = `700 ${Math.round(R0 * 0.13)}px "Barlow Condensed", sans-serif`;
    c.fillText(car.alive ? 'RADAR DOWN · GET IT FIXED' : 'WRECKED', cx, cy + R0 * 0.16);
    c.restore();
    radarBezel(c, cx, cy, R0);
    return;
  }
  const health = R.hp / RADAR.hp,
    scale = R0 / RADAR.range,
    now = G.time;
  const rot = -Math.PI / 2 - Math.atan2(Math.cos(car.yaw), Math.sin(car.yaw)),
    cr = Math.cos(rot),
    sr = Math.sin(rot);
  const P = (x: number, z: number): [number, number] => {
    const dx = x - car.pos.x,
      dz = z - car.pos.z;
    return [cx + (dx * cr - dz * sr) * scale, cy + (dx * sr + dz * cr) * scale];
  };
  const jit = health < 0.5 ? rand(-1, 1) * (0.5 - health) * 6 : 0; // a damaged screen judders
  // the map, nose up
  c.save();
  c.translate(cx + jit, cy);
  c.rotate(rot);
  c.scale(scale, scale);
  c.translate(-car.pos.x, -car.pos.z);
  c.drawImage(radarMap(), RADAR_MAP.x0, RADAR_MAP.z0, RADAR_MAP.w, RADAR_MAP.h);
  c.restore();
  // range rings, cross hair, bearing ticks
  c.strokeStyle = 'rgba(90,255,150,0.28)';
  c.lineWidth = 1;
  for (const f of [1 / 3, 2 / 3]) {
    c.beginPath();
    c.arc(cx, cy, R0 * f, 0, TAU);
    c.stroke();
  }
  c.beginPath();
  c.moveTo(cx - R0, cy);
  c.lineTo(cx + R0, cy);
  c.moveTo(cx, cy - R0);
  c.lineTo(cx, cy + R0);
  c.stroke();
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * TAU,
      l = i % 3 ? 0.04 : 0.09;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * R0, cy + Math.sin(a) * R0);
    c.lineTo(cx + Math.cos(a) * R0 * (1 - l), cy + Math.sin(a) * R0 * (1 - l));
    c.stroke();
  }
  // north marker on the rim
  const na = rot - Math.PI / 2;
  c.fillStyle = '#7dffb0';
  c.font = `700 ${Math.round(unit * 1.4)}px "Barlow Condensed", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('N', cx + Math.cos(na) * R0 * 0.86, cy + Math.sin(na) * R0 * 0.86);
  // the sweep and its fading trail
  const sa =
    rot +
    Math.atan2(Math.cos(R.world), Math.sin(R.world)) +
    (health < 0.5 ? rand(-0.08, 0.08) * (1 - health) : 0);
  if (c.createConicGradient) {
    const cg = c.createConicGradient(sa, cx, cy);
    cg.addColorStop(0, 'rgba(90,255,150,0.42)');
    cg.addColorStop(0.18, 'rgba(90,255,150,0.08)');
    cg.addColorStop(0.3, 'rgba(90,255,150,0)');
    cg.addColorStop(1, 'rgba(90,255,150,0)');
    c.fillStyle = cg;
    c.beginPath();
    c.arc(cx, cy, R0, 0, TAU);
    c.fill();
  }
  c.strokeStyle = 'rgba(160,255,200,0.9)';
  c.lineWidth = Math.max(1.5, unit * 0.22);
  c.beginPath();
  c.moveTo(cx, cy);
  c.lineTo(cx + Math.cos(sa) * R0, cy + Math.sin(sa) * R0);
  c.stroke();
  // supply drops (amber) and cars (red = enemy, green = friend), at where the beam last saw them
  const fade = (t: number) => clamp(1 - (now - t) / (RADAR.period * 1.15), 0, 1);
  c.font = `700 ${Math.round(unit * 1.1)}px "Barlow Condensed", sans-serif`;
  for (const [d, t] of R.drops) {
    const a = fade(t);
    if (a <= 0 || d.taken >= 0) continue;
    const [x, y] = P(d.x, d.z),
      s = unit * 0.8;
    c.globalAlpha = a;
    c.fillStyle = '#ffc24b';
    c.fillRect(x - s, y - s, s * 2, s * 2);
    c.fillStyle = '#021a0b';
    c.fillText(DROP_TYPES[d.type].letter, x, y + 1);
  }
  for (const [t, info] of R.contacts) {
    const a = fade(info.t);
    if (a <= 0) continue;
    const [x, y] = P(info.x, info.z);
    c.globalAlpha = a;
    if (!info.alive) {
      c.strokeStyle = '#8fa89a';
      c.lineWidth = 2;
      const s = unit * 0.55;
      c.beginPath();
      c.moveTo(x - s, y - s);
      c.lineTo(x + s, y + s);
      c.moveTo(x + s, y - s);
      c.lineTo(x - s, y + s);
      c.stroke();
      continue;
    }
    const friend = t.team === car.team,
      col = friend ? '#7dffb0' : '#ff5a4f';
    c.shadowColor = col;
    c.shadowBlur = unit * 1.2;
    c.fillStyle = col;
    c.beginPath();
    c.arc(x, y, unit * 0.75, 0, TAU);
    c.fill();
    c.shadowBlur = 0;
    c.fillStyle = requireValue(TEAMS[t.team]).ui;
    c.beginPath();
    c.arc(x, y, unit * 0.35, 0, TAU);
    c.fill(); // team colour in the middle
    c.fillStyle = col;
    c.textAlign = 'left';
    const names = t.occ.flatMap((o) => (o?.kind === 'human' ? [o.h.name] : [])).join(' ');
    c.fillText(names || String(t.num), x + unit * 0.95, y - unit * 0.7);
    c.textAlign = 'center';
  }
  c.globalAlpha = 1;
  // where the gun points
  if (!h.dead && isGunSeat(h.seat)) {
    const g = gunAt(car, h.seat),
      ga = rot + Math.atan2(Math.cos(g.yaw), Math.sin(g.yaw));
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = Math.max(1, unit * 0.18);
    c.setLineDash([4, 3]);
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + Math.cos(ga) * R0 * 0.55, cy + Math.sin(ga) * R0 * 0.55);
    c.stroke();
    c.setLineDash([]);
  }
  // you, in the middle, nose up
  drawArrow2(c, cx, cy, Math.PI, unit * 1.2, '#7dffb0', '#021a0b', Math.max(1.5, unit * 0.25));
  // damage: snow on the screen
  if (health < 0.8) {
    const n = Math.round((0.8 - health) * 220);
    for (let i = 0; i < n; i++) {
      c.fillStyle = `rgba(160,255,200,${rand(0.08, 0.4)})`;
      c.fillRect(rand(0, W), rand(0, H), rand(1, 3), 1);
    }
    if (health < 0.4 && Math.random() < 0.3) {
      c.fillStyle = 'rgba(160,255,200,0.15)';
      c.fillRect(0, rand(0, H), W, rand(2, 8));
    }
  }
  c.restore();
  radarBezel(c, cx, cy, R0);
}
function radarBezel(c: CanvasRenderingContext2D, cx: number, cy: number, R0: number) {
  c.strokeStyle = '#0c0f0d';
  c.lineWidth = 5;
  c.beginPath();
  c.arc(cx, cy, R0, 0, TAU);
  c.stroke();
  c.strokeStyle = 'rgba(120,255,170,0.35)';
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(cx, cy, R0 - 3, 0, TAU);
  c.stroke();
}
