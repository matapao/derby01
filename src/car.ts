import { requireValue } from './required-fields.ts';
import { gunAt } from './gameplay/guns.ts';
import * as THREE from 'three';
import { G } from './state.ts';
import type { CarSetup } from './setup.ts';
import { boxGeo } from './mesh-geometry.ts';
import { buildCarInterior, buildCrewGeometry } from './car-interior.ts';
import { createCarPanelMotion } from './car-panel-motion.ts';
import { createBodyworkState } from './gameplay/body-damage.ts';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  CARDIM,
  DETACHABLE,
  GUN_SEATS,
  MAX_HP,
  SEAT_INSIDE,
  SHARED,
  TAU,
  TEAMS,
  TURRETS,
  addCarPosAttribute,
  clamp,
  damp,
  makeGlassMaterial,
  makePaintMaterial,
  makePaintedMaterial,
  pick,
  rand,
  wrapPi,
} from './core.ts';
import { canvasTexture, scene } from './world.ts';
import { buildKit } from './kits.ts';
import { addDebris, dust, sparks } from './fx.ts';
import { SFX } from './audio.ts';
import { disposeCarPaint, initCarPaint } from './paint.ts';
import { buildRadar } from './radar-model.ts';
import { carToWorld } from './gameplay/geometry.ts';
import { createSystems } from './gameplay/systems.ts';
import type { GunState } from './gameplay/model.ts';
import { CAR_ATTACHMENTS, type CarAssembly, type BumperState, type PaintMesh } from './car-types.ts';
import { requireFields } from './required-fields.ts';
import type { CarPart, CarTemplate } from './core.ts';
import type { BumperDefinition, Car } from './car-types.ts';
import { FX, share } from './net/effects.ts';
import { D, onData } from './data.ts';
export type { Car } from './car-types.ts';

export let TPL: CarTemplate | null = null;

// =====================================================================
//  Shared car bits: race numbers, turrets, bumpers, crew
// =====================================================================
const numberTexCache = new Map<number, THREE.CanvasTexture>();
function numberTexture(num: number) {
  const cached = numberTexCache.get(num);
  if (cached) return cached;
  const t = canvasTexture(128, 128, (g, w: number, h: number) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#f4efe4';
    g.beginPath();
    g.arc(w / 2, h / 2, 58, 0, TAU);
    g.fill();
    g.lineWidth = 7;
    g.strokeStyle = '#151515';
    g.stroke();
    g.fillStyle = '#151515';
    g.font = 'bold 82px Impact, Arial Black, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(num), w / 2, h / 2 + 5);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  numberTexCache.set(num, t);
  return t;
}

const MARKER_SILVER = new THREE.MeshStandardMaterial({
  color: 0xd4dde6,
  roughness: 0.26,
  metalness: 0.78,
});
const MARKER_ANODIZED = new THREE.MeshStandardMaterial({
  color: 0x2978a0,
  roughness: 0.28,
  metalness: 0.62,
});
const MARKER_GOLD = new THREE.MeshStandardMaterial({
  color: 0xdba02e,
  roughness: 0.28,
  metalness: 0.72,
});
const MARKER_TANK = new THREE.MeshStandardMaterial({
  color: 0xc84630,
  roughness: 0.3,
  metalness: 0.35,
});
const TURRET_GEO = {
  puck: new THREE.CylinderGeometry(0.068, 0.084, 0.036, 14).translate(0, 0.018, 0),
  collar: new THREE.CylinderGeometry(0.052, 0.056, 0.014, 12).translate(0, 0.038, 0),
  yoke: mergeGeometries([
    new THREE.CylinderGeometry(0.048, 0.052, 0.022, 12).translate(0, 0.011, 0),
    boxGeo(0.096, 0.016, 0.038, 0, 0.024, 0),
    boxGeo(0.014, 0.115, 0.034, 0.042, 0.078, 0),
    boxGeo(0.014, 0.115, 0.034, -0.042, 0.078, 0),
    new THREE.CylinderGeometry(0.018, 0.018, 0.108, 10).rotateZ(Math.PI / 2).translate(0, 0.134, 0),
  ]),
  body: mergeGeometries([
    new THREE.CylinderGeometry(0.027, 0.027, 0.25, 12).rotateX(Math.PI / 2).translate(0, 0, -0.01),
    new THREE.CylinderGeometry(0.023, 0.023, 0.21, 12).rotateX(Math.PI / 2).translate(0, -0.036, 0),
    boxGeo(0.042, 0.038, 0.19, 0, -0.018, -0.005),
    boxGeo(0.03, 0.076, 0.038, 0, -0.072, -0.052, 0.2),
    boxGeo(0.018, 0.048, 0.01, 0, -0.066, -0.012, -0.14),
    boxGeo(0.018, 0.01, 0.042, 0, -0.088, -0.032),
    new THREE.CylinderGeometry(0.018, 0.02, 0.078, 10).translate(0, -0.068, 0.068),
  ]),
  silver: mergeGeometries([
    new THREE.CylinderGeometry(0.022, 0.025, 0.032, 10).rotateX(Math.PI / 2).translate(0, 0, -0.148),
    boxGeo(0.008, 0.034, 0.012, 0, -0.064, -0.028, 0.1),
    new THREE.CylinderGeometry(0.019, 0.021, 0.046, 10).translate(0, 0.036, 0.01),
    boxGeo(0.032, 0.022, 0.044, 0, -0.108, -0.068),
    new THREE.CylinderGeometry(0.005, 0.005, 0.138, 6)
      .rotateX(Math.PI / 2 - 0.28)
      .translate(0, -0.092, 0.002),
    new THREE.CylinderGeometry(0.015, 0.017, 0.32, 10).rotateX(Math.PI / 2).translate(0, 0, 0.5),
    new THREE.CylinderGeometry(0.019, 0.016, 0.04, 10).rotateX(Math.PI / 2).translate(0, 0, 0.64),
  ]),
  accents: mergeGeometries([
    new THREE.CylinderGeometry(0.022, 0.022, 0.016, 10).translate(0, -0.042, 0.068),
    new THREE.CylinderGeometry(0.024, 0.024, 0.014, 10).translate(0, 0.042, 0.01),
    new THREE.CylinderGeometry(0.018, 0.018, 0.032, 10).rotateX(Math.PI / 2).translate(0, -0.038, -0.12),
  ]),
  barrelBack: new THREE.CylinderGeometry(0.019, 0.023, 0.225, 10).rotateX(Math.PI / 2).translate(0, 0, 0.227),
  tank: mergeGeometries([
    new THREE.CylinderGeometry(0.034, 0.034, 0.13, 12).rotateX(Math.PI / 2).translate(0, -0.038, -0.2),
    new THREE.SphereGeometry(0.034, 12, 8).translate(0, -0.038, -0.265),
    new THREE.SphereGeometry(0.034, 12, 8).scale(1, 1, 0.65).translate(0, -0.038, -0.135),
  ]),
  cam: boxGeo(0.036, 0.034, 0.068),
  lens: new THREE.CylinderGeometry(0.014, 0.014, 0.01, 10).rotateX(Math.PI / 2).translate(0, 0, 0.038),
};
const TURRET_LENS = new THREE.MeshStandardMaterial({
  color: 0x0d1a24,
  emissive: 0xff2a2a,
  emissiveIntensity: 0.5,
  roughness: 0.05,
}); // a red REC light in the glass
const HOPPER_GEO = {
  shell: new THREE.SphereGeometry(0.068, 14, 10).scale(0.76, 0.66, 1.38).translate(0, 0.048, -0.015),
  balls: new THREE.SphereGeometry(0.056, 12, 8).scale(0.74, 0.56, 1.3).translate(0, 0.038, -0.015),
  lid: new THREE.CylinderGeometry(0.036, 0.04, 0.012, 12).translate(0, 0.09, -0.02),
};
const HOPPER_SHELL = new THREE.MeshStandardMaterial({
  color: 0xeef5f9,
  transparent: true,
  opacity: 0.48,
  roughness: 0.12,
  depthWrite: false,
});
// Modded remote paintball marker on a slim gimbal mount with a low-profile loader hopper.
// Pivot heights: yaw +0.036, pitch +0.17, muzzle 0.66 along the barrel.
function buildSmallTurret(ballMat: THREE.MeshStandardMaterial, trimMat: THREE.MeshStandardMaterial) {
  const base = new THREE.Group();
  const puck = new THREE.Mesh(TURRET_GEO.puck, MARKER_SILVER);
  const collar = new THREE.Mesh(TURRET_GEO.collar, MARKER_GOLD);
  const yaw = new THREE.Group();
  yaw.position.y = 0.036;
  const yoke = new THREE.Mesh(TURRET_GEO.yoke, MARKER_SILVER);
  const pitch = new THREE.Group();
  pitch.position.set(0, 0.134, 0);
  const body = new THREE.Mesh(TURRET_GEO.body, MARKER_ANODIZED);
  const silver = new THREE.Mesh(TURRET_GEO.silver, MARKER_SILVER);
  const accents = new THREE.Mesh(TURRET_GEO.accents, MARKER_GOLD);
  const barrelBack = new THREE.Mesh(TURRET_GEO.barrelBack, trimMat);
  const tank = new THREE.Mesh(TURRET_GEO.tank, MARKER_TANK);
  const hopper = new THREE.Group();
  hopper.position.set(0, 0.055, 0.01);
  hopper.add(
    new THREE.Mesh(HOPPER_GEO.balls, ballMat),
    new THREE.Mesh(HOPPER_GEO.shell, HOPPER_SHELL),
    new THREE.Mesh(HOPPER_GEO.lid, trimMat),
  );
  // the camera the gunner watches through their goggles, clipped to the marker's side rail
  const cam = new THREE.Mesh(TURRET_GEO.cam, MARKER_SILVER),
    lens = new THREE.Mesh(TURRET_GEO.lens, TURRET_LENS);
  cam.position.set(0.042, 0.01, 0.02);
  lens.position.set(0.042, 0.01, 0.02);
  pitch.add(body, silver, accents, barrelBack, tank, hopper, cam, lens);
  yaw.add(yoke, pitch);
  base.add(puck, collar, yaw);
  for (const m of [puck, yoke, body, silver, barrelBack, tank]) m.castShadow = true;
  return { base, yaw, pitch };
}

// ---------------------------------------------------------------------
//  Rubber bumpers, like the dodgems at the fair: a fat black rubber tube round the front, the back and
//  along the doors, with a strip in the team colour. They soak up knocks and make cars bounce off
//  each other. Each bumper is a few pieces that tear off as it takes a beating; the mechanic fits
//  new ones from the spare bumpers.
// ---------------------------------------------------------------------
const BUMPER_Y = 0.47,
  BUMPER_R = 0.115;
function cornerPath(sx: number, sz: number) {
  // from the side, round the corner, to the start of the middle piece (x = sx * 0.93 side, z = sz * 2.43 end)
  const pts = [new THREE.Vector3(sx * 0.93, BUMPER_Y, sz * 1.62)];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    pts.push(new THREE.Vector3(sx * (0.58 + 0.35 * Math.cos(a)), BUMPER_Y, sz * (2.08 + 0.35 * Math.sin(a))));
  }
  pts.push(new THREE.Vector3(sx * 0.28, BUMPER_Y, sz * 2.43));
  return pts;
}
const line3 = (x0: number, z0: number, x1: number, z1: number) => [
  new THREE.Vector3(x0, BUMPER_Y, z0),
  new THREE.Vector3(x1, BUMPER_Y, z1),
];
export const BUMPERS: Record<string, BumperDefinition> = {
  front: {
    label: 'front bumper',
    hp: 34,
    pieces: [],
    paths: [cornerPath(1, 1), line3(0.28, 2.43, -0.28, 2.43), cornerPath(-1, 1)],
  },
  rear: {
    label: 'rear bumper',
    hp: 30,
    pieces: [],
    paths: [cornerPath(1, -1), line3(0.28, -2.43, -0.28, -2.43), cornerPath(-1, -1)],
  },
  left: {
    label: 'left door bumper',
    hp: 24,
    pieces: [],
    paths: [line3(0.95, 0.92, 0.95, 0.04), line3(0.95, -0.04, 0.95, -0.82)],
  },
  right: {
    label: 'right door bumper',
    hp: 24,
    pieces: [],
    paths: [line3(-0.95, 0.92, -0.95, 0.04), line3(-0.95, -0.04, -0.95, -0.82)],
  },
};
export const BUMPER_NAMES = Object.keys(BUMPERS);
const BUMPER_PIECES = BUMPER_NAMES.reduce((n, k) => n + (requireValue(BUMPERS[k]).paths ?? []).length, 0);
// how strong each is, and what the mechanic calls it (data/car.json); the tubes are the model's
onData(() => {
  for (const n of BUMPER_NAMES)
    Object.assign(requireValue(BUMPERS[n]), D.car.bumpers[n as keyof typeof D.car.bumpers]);
});
export const ZONE_BUMPER = { front: 'front', rear: 'rear', lf: 'left', lr: 'left', rf: 'right', rr: 'right' };
for (const d of Object.values(BUMPERS)) {
  d.pieces = (d.paths ?? []).map((pts) => {
    const curve =
      pts.length > 2
        ? new THREE.CatmullRomCurve3(pts, false, 'centripetal')
        : new THREE.LineCurve3(pts[0], pts[1]);
    const segs = pts.length > 2 ? 28 : 8;
    const rubber = mergeGeometries(
      [
        new THREE.TubeGeometry(curve, segs, BUMPER_R, 12, false),
        new THREE.SphereGeometry(BUMPER_R, 12, 8).translate(
          requireValue(pts[0]).x,
          requireValue(pts[0]).y,
          requireValue(pts[0]).z,
        ),
        new THREE.SphereGeometry(BUMPER_R, 12, 8).translate(
          requireValue(pts[pts.length - 1]).x,
          requireValue(pts[pts.length - 1]).y,
          requireValue(pts[pts.length - 1]).z,
        ),
      ].map((g) => g.toNonIndexed()),
    );
    const up = pts.map((p) => p.clone().add(new THREE.Vector3(0, BUMPER_R * 0.95, 0)));
    const trimCurve =
      up.length > 2
        ? new THREE.CatmullRomCurve3(up, false, 'centripetal')
        : new THREE.LineCurve3(up[0], up[1]);
    const trim = new THREE.TubeGeometry(trimCurve, segs, 0.032, 6, false).toNonIndexed();
    const geo = mergeGeometries([rubber, trim], true); // group 0 = rubber, group 1 = team-colour strip
    geo.computeBoundingBox();
    const pos = new THREE.Box3().setFromObject(new THREE.Mesh(geo)).getCenter(new THREE.Vector3());
    geo.translate(-pos.x, -pos.y, -pos.z); // pivot in the middle so it tumbles when it tears off
    geo.computeBoundingSphere();
    addCarPosAttribute(geo, pos);
    return { geo, pos };
  });
  delete d.paths;
}

// =====================================================================
//  Car instance
// =====================================================================
function newGunState(): GunState {
  return {
    yaw: 0,
    pitch: 0.02,
    cd: 0,
    heat: 0,
    overheat: false,
    jam: false,
    recoil: 0,
    firing: false,
    zoom: 0,
    aimPoint: new THREE.Vector3(),
  };
}

export function createCar(idx: number, cfg: CarSetup): Car {
  const team = requireValue(TEAMS[cfg.team]);
  if (!TPL) throw new Error('Car template is not loaded');
  const car: CarAssembly = {
    idx,
    num: idx + 1,
    team: cfg.team,
    cfg,
    ...createSystems(MAX_HP, D.mechanic.spares.start),
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    yaw: 0,
    yawRate: 0,
    grounded: true,
    mass: CARDIM.mass,
    inertia: CARDIM.inertia,
    steer: 0,
    spin: 0,
    boostFuel: 1,
    boosting: false,
    ctrl: { throttle: 0, steer: 0, handbrake: false, boost: false },
    hp: MAX_HP,
    alive: true,
    lastHitBy: null,
    lastHitTime: -99,
    occ: [null, null, null, null],
    gun: [null, newGunState(), newGunState(), null],
    lean: { p: 0, r: 0, vp: 0, vr: 0 },
    slope: { p: 0, r: 0 },
    prevVF: 0,
    stun: 0,
    land: 0,
    smokeT: 0,
    skidPrev: [null, null],
    bodywork: createBodyworkState(),
  };

  // ---- meshes ----
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const body = new THREE.Group();
  root.add(body);
  car.root = root;
  car.body = body;
  car.paint = makePaintMaterial(TPL, team.color);
  car.glassMat = makeGlassMaterial();
  car.rubberMat = makePaintedMaterial({ color: 0x1c1c1f, roughness: 0.82 });
  car.trimMat = makePaintedMaterial({ color: new THREE.Color(team.ui), roughness: 0.4 });
  car.ballMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(team.ui), roughness: 0.2 });
  car.crewMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: new THREE.Color(team.color).lerp(new THREE.Color(0xffffff), 0.6),
    roughness: 0.45,
  });
  body.add(buildCarInterior({ structure: SHARED.darkMetal, seats: car.rubberMat, metal: SHARED.gunMetal }));
  // body panels get their own copy of the geometry so they can be dented
  car.deformables = [];
  const paint = car.paint,
    glassMat = car.glassMat;
  const meshFor = (part: CarPart, deform = false): PaintMesh => {
    const mats = part.glassSlots.map((isGlass) => (isGlass ? glassMat : paint));
    let geo = part.geo;
    if (deform) {
      geo = part.geo.clone();
      geo.userData['orig'] = Float32Array.from(geo.getAttribute('position').array);
    }
    const m = new THREE.Mesh(geo, mats.length === 1 ? mats[0] : mats);
    m.position.copy(part.pos);
    m.castShadow = true;
    m.receiveShadow = true;
    if (deform) car.deformables?.push(m);
    return m;
  };
  car.meshFor = meshFor;
  for (const p of TPL.body) body.add(meshFor(p, true));
  car.parts = {};
  for (const n of DETACHABLE) {
    const p = TPL.parts[n];
    if (!p) continue;
    const m = meshFor(p, true);
    body.add(m);
    car.parts[n] = m;
  }
  if (TPL.steering) {
    const pivot = new THREE.Group();
    pivot.position.copy(TPL.steering.pos);
    const m = meshFor(TPL.steering);
    m.position.set(0, 0, 0);
    pivot.add(m);
    body.add(pivot);
    car.steeringPivot = pivot;
  }
  car.wheels = TPL.wheels.map((w, i: number) => {
    const steer = new THREE.Group();
    steer.position.copy(w.pos);
    const m = meshFor(w);
    m.position.set(0, 0, 0);
    steer.add(m);
    root.add(steer);
    return { steer, mesh: m, front: i < 2, left: w.pos.x > 0, baseY: w.pos.y, attached: true };
  });

  // race numbers: roof + both front doors
  const numMat = new THREE.MeshStandardMaterial({
    map: numberTexture(car.num),
    transparent: true,
    roughness: 0.6,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  car.numMat = numMat;
  const roofNum = new THREE.Mesh(
    Object.assign(new THREE.PlaneGeometry(0.7, 0.7), { userData: { own: true } }),
    numMat,
  );
  roofNum.rotation.set(-Math.PI / 2, 0, Math.PI); // reads the right way up from behind
  roofNum.position.set(0, CARDIM.top + 0.006, -0.1);
  body.add(roofNum);
  for (const [name, side] of [
    ['L_Door_Front', 1],
    ['R_Door_Front', -1],
  ] as [string, number][]) {
    const door = car.parts[name];
    if (!door) continue;
    const plate = new THREE.Mesh(
      Object.assign(new THREE.PlaneGeometry(0.44, 0.44), { userData: { own: true } }),
      numMat,
    );
    plate.position.set(side * 0.845 - door.position.x, 0.7 - door.position.y, 0.42 - door.position.z);
    plate.rotation.y = (side * Math.PI) / 2;
    door.add(plate);
  }

  car.panelMotion = createCarPanelMotion(car.parts, D.damage.bodywork);

  // Reinforced chassis mounts keep marker aim steady while the surrounding lids flap.
  car.turrets = {};
  for (const key of ['hood', 'trunk'] as const) {
    const rig = buildSmallTurret(car.ballMat, car.trimMat);
    const mount = TURRETS[key].pos;
    rig.base.position.set(mount[0], mount[1], mount[2]);
    body.add(rig.base);
    car.turrets[key] = rig;
  }

  // rubber bumpers, each made of a few pieces
  car.bumpers = {};
  for (const name of BUMPER_NAMES)
    car.bumpers[name] = {
      name,
      def: requireValue(BUMPERS[name]),
      hp: requireValue(BUMPERS[name]).hp,
      pieces: requireValue(BUMPERS[name]).pieces.map(() => null),
    };

  car.zoneDmg = { front: 0, rear: 0, lf: 0, rf: 0, lr: 0, rr: 0 };

  car.riders = [null, null, null, null];
  requireFields(car, ['body', 'paint', 'rubberMat', 'trimMat', 'glassMat', 'ballMat']);
  Object.assign(car, initCarPaint(car));
  car.radar = buildRadar(car);
  Object.assign(car, buildKit(car, cfg.kit || 'stock'));
  requireFields(car, CAR_ATTACHMENTS);
  for (const name of BUMPER_NAMES) attachBumper(car, name, true);
  scene.add(root);
  return car;
}

// How many pieces of a bumper are still on, and helpers to fit them / tear them off.
export const bumperLeft = (p: BumperState) => p.pieces.reduce((n: number, m) => n + (m ? 1 : 0), 0);
export const bumperShare = (car: Car) =>
  BUMPER_NAMES.reduce((n, k) => n + bumperLeft(requireValue(car.bumpers[k])), 0) / BUMPER_PIECES;

// Fit missing pieces (at most `max` of them). Returns how many went on.
export function attachBumper(car: Car, name: string, quiet = false, max = Infinity) {
  const p = requireValue(car.bumpers[name]);
  let added = 0;
  p.def.pieces.forEach((pc, i) => {
    if (p.pieces[i]) {
      p.pieces[i].rotation.set(0, 0, 0);
      p.pieces[i].position.copy(pc.pos);
      return;
    }
    if (added >= max) return;
    const m = new THREE.Mesh(pc.geo, [car.rubberMat, car.trimMat]);
    m.position.copy(pc.pos);
    m.castShadow = true;
    m.receiveShadow = true;
    car.body.add(m);
    p.pieces[i] = m;
    added++;
    if (!quiet) {
      const w = carToWorld(car, pc.pos.x, pc.pos.y, pc.pos.z, new THREE.Vector3());
      dust(w.x, w.y, w.z, 3);
    }
  });
  p.hp = (p.def.hp * bumperLeft(p)) / p.pieces.length;
  return added;
}

export function tearOffBumper(car: Car, name: string, i: number, boost = 1) {
  const p = requireValue(car.bumpers[name]),
    m = p.pieces[i];
  if (!m) return;
  p.pieces[i] = null;
  m.updateWorldMatrix(true, false);
  const pos = new THREE.Vector3(),
    quat = new THREE.Quaternion();
  m.matrixWorld.decompose(pos, quat, new THREE.Vector3());
  m.removeFromParent();
  const out = pos.clone().sub(car.pos).setY(0).normalize();
  const vel = car.vel
    .clone()
    .multiplyScalar(0.5)
    .addScaledVector(out, rand(3, 6) * boost);
  vel.y = rand(3, 6) * boost;
  addDebris(m, pos, quat, vel, 12);
  dust(pos.x, pos.y, pos.z, 4);
  SFX.thud(pos);
}

// After a bumper takes damage: the next piece hangs loose, and pieces drop to match what is left of it.
export function settleBumper(car: Car, name: string) {
  const p = requireValue(car.bumpers[name]),
    n = p.pieces.length;
  const keep = Math.max(0, Math.ceil((p.hp / p.def.hp) * n - 0.001));
  let left = bumperLeft(p);
  while (left > keep) {
    const on = p.pieces.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
    tearOffBumper(car, name, pick(on));
    left--;
  }
  hangBumper(car, name);
}

// The next piece to go hangs loose as the bumper wears down.
function hangBumper(car: Car, name: string) {
  const p = requireValue(car.bumpers[name]),
    n = p.pieces.length;
  const keep = Math.max(0, Math.ceil((p.hp / p.def.hp) * n - 0.001)),
    left = bumperLeft(p);
  const frac = ((p.hp / p.def.hp) * n) % 1;
  p.pieces.forEach((m, i) => {
    if (!m) return;
    const loose = left === keep && frac > 0 && frac < 0.4 ? (0.4 - frac) / 0.4 : 0;
    const pc = requireValue(p.def.pieces[i]);
    m.rotation.set(loose * 0.12 * ((i % 2) * 2 - 1), loose * 0.1, loose * 0.16);
    m.position.set(pc.pos.x, pc.pos.y - loose * 0.07, pc.pos.z);
  });
}

// Another screen's bumper, as the host has it: one bit per piece that is on, and its health.
export function setBumperPieces(car: Car, name: string, mask: number, hp: number) {
  const p = requireValue(car.bumpers[name]);
  p.pieces.forEach((m, i) => {
    const want = !!(mask & (1 << i));
    if (want && !m) {
      const pc = requireValue(p.def.pieces[i]);
      const piece = new THREE.Mesh(pc.geo, [car.rubberMat, car.trimMat]);
      piece.position.copy(pc.pos);
      piece.castShadow = true;
      piece.receiveShadow = true;
      car.body.add(piece);
      p.pieces[i] = piece;
    } else if (!want && m) tearOffBumper(car, name, i);
  });
  p.hp = hp;
  hangBumper(car, name);
}

// Wheels can be knocked off (and the mechanic can bolt a new one on).
export function dropWheel(car: Car, i: number, vel: THREE.Vector3 | null = null) {
  const w = requireValue(car.wheels[i]);
  if (!w.attached) return;
  w.attached = false;
  w.steer.updateWorldMatrix(true, true);
  const pos = new THREE.Vector3(),
    quat = new THREE.Quaternion();
  w.mesh.matrixWorld.decompose(pos, quat, new THREE.Vector3());
  w.steer.remove(w.mesh);
  addDebris(
    w.mesh,
    pos,
    quat,
    vel || new THREE.Vector3(car.vel.x * 0.6 + rand(-3, 3), rand(3, 6), car.vel.z * 0.6 + rand(-3, 3)),
    12,
  );
  sparks(pos.x, pos.y, pos.z, 20, 6);
}
export function refitWheel(car: Car, i: number) {
  const w = requireValue(car.wheels[i]);
  if (w.attached) return;
  w.mesh = car.meshFor(
    (() => {
      if (!TPL) throw new Error('Car template is not loaded');
      return requireValue(TPL.wheels[i]);
    })(),
  );
  w.mesh.position.set(0, 0, 0);
  w.steer.add(w.mesh);
  w.attached = true;
}

// Crumple the bodywork round a hit. lp = hit point in car space, dir = push direction (into the car).
const MAX_DENT = 0.24;
export function dentCar(
  car: Car,
  lp: import('./gameplay/geometry.ts').Vector,
  dir: import('./gameplay/geometry.ts').Vector,
  amount: number,
) {
  if (share(FX.dent, dentCar, [car, lp, dir, amount])) return;
  if (amount <= 0) return;
  const R = clamp(0.45 + amount * 0.04, 0.45, 1.25),
    push = Math.min(0.1, amount * 0.009),
    R2 = R * R;
  for (const m of car.deformables) {
    if (m.parent !== car.body) continue; // (knocked off: it's debris now)
    const g = m.geometry,
      P = g.getAttribute('position'),
      O = g.userData['orig'],
      D = g.getAttribute('aDent');
    const rest = car.panelMotion.restPosition(m);
    const ox = lp.x - rest.x,
      oy = lp.y - rest.y,
      oz = lp.z - rest.z;
    const bs = g.boundingSphere;
    if (!bs) continue;
    if (Math.hypot(ox - bs.center.x, oy - bs.center.y, oz - bs.center.z) > bs.radius + R) continue;
    let touched = false;
    for (let i = 0; i < P.count; i++) {
      const vx = P.getX(i),
        vy = P.getY(i),
        vz = P.getZ(i);
      const dx = vx - ox,
        dy = vy - oy,
        dz = vz - oz,
        d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      const f = (1 - Math.sqrt(d2) / R) ** 2;
      let nx = vx + dir.x * push * f,
        ny = vy + dir.y * push * f - push * f * 0.25,
        nz = vz + dir.z * push * f;
      // never crush a panel more than MAX_DENT from where it started
      const ex = nx - O[i * 3],
        ey = ny - O[i * 3 + 1],
        ez = nz - O[i * 3 + 2],
        el = Math.hypot(ex, ey, ez);
      if (el > MAX_DENT) {
        const k = MAX_DENT / el;
        nx = O[i * 3] + ex * k;
        ny = O[i * 3 + 1] + ey * k;
        nz = O[i * 3 + 2] + ez * k;
      }
      P.setXYZ(i, nx, ny, nz);
      D.setX(i, Math.min(1, D.getX(i) + f * Math.min(1, amount * 0.05)));
      touched = true;
    }
    if (touched) {
      P.needsUpdate = true;
      D.needsUpdate = true;
    }
  }
}

// camera goggles: a dark box over the eyes with a strap, lit from inside by the feed
const GOGGLES_GEO = mergeGeometries([
  boxGeo(0.25, 0.1, 0.1, 0, 0.03, 0.15),
  boxGeo(0.33, 0.035, 0.27, 0, 0.04, 0.01),
]);
const GOGGLES_MAT = new THREE.MeshStandardMaterial({
  color: 0x15171c,
  emissive: 0x3ad7ff,
  emissiveIntensity: 0.35,
  roughness: 0.4,
});

// What each player on this screen sees is sorted with layers: 0 = the world, 9+i = what local player i
// doesn't see (their own body), 17+c = car c's tag (its own crew doesn't see it, see addPlayerTag).
function setLayer(obj: THREE.Object3D, layer: number) {
  obj.traverse((o) => o.layers.set(layer));
}

export function refreshOccupantVisuals(car: Car) {
  for (let s = 0; s < 4; s++) {
    const occ = s === 0 ? car.occ[0] : null;
    let r = car.riders[s];
    if (!occ || !car.alive) {
      if (r) {
        car.body.remove(r);
        car.riders[s] = null;
      }
      continue;
    }
    if (!r) {
      r = car.riders[s] = new THREE.Mesh(buildCrewGeometry(), car.crewMat);
      const p = requireValue(SEAT_INSIDE[s]);
      r.position.set(p[0], p[1] - 0.04, p[2]);
      if (s === 1 || s === 2) r.add(new THREE.Mesh(GOGGLES_GEO, GOGGLES_MAT)); // the gunners watch their turret cameras
      car.body.add(r);
    }
    // this screen's players don't see their own body; everyone else's is plain to see
    setLayer(r, occ.kind === 'human' && !occ.h.remote ? 9 + occ.h.id : 0);
  }
}

// One floating tag per car naming the people in it ("P1 P2"). It lives on layer 17 + car index,
// which the cameras of that car's own crew leave switched off.
export function addPlayerTag(car: Car, names: string[]) {
  const w = 40 + names.length * 70;
  car.tagTex = canvasTexture(w, 52, (g, cw: number, ch: number) => {
    g.fillStyle = requireValue(TEAMS[car.team]).ui;
    g.beginPath();
    g.roundRect(4, 4, cw - 8, ch - 8, 12);
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 34px Impact, Arial Black, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(names.join(' '), cw / 2, ch / 2 + 2);
  });
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: car.tagTex,
      sizeAttenuation: false,
      depthWrite: false,
      transparent: true,
    }),
  );
  s.scale.set(0.053 * (w / 52), 0.053, 1);
  s.position.set(0, 2.35, 0);
  s.layers.set(17 + car.idx);
  s.renderOrder = 5;
  car.root.add(s);
  car.tagSprite = s;
}

// The tag again, after the crew changed (someone joined, left or took over a seat).
export function updatePlayerTag(car: Car) {
  if (car.tagSprite) {
    car.root.remove(car.tagSprite);
    car.tagSprite.material.dispose();
    car.tagSprite = null;
  }
  if (car.tagTex) {
    car.tagTex.dispose();
    car.tagTex = null;
  }
  // the short form of each name ("P1" for Player One): the tag is small; the HUD and lists have the full one
  const names = car.occ.flatMap((o) => (o?.kind === 'human' ? [o.h.tag ?? o.h.name] : []));
  if (names.length) addPlayerTag(car, names);
}

export function disposeCar(car: Car) {
  scene.remove(car.root);
  // geometry made for this car only: the dentable copies of the body panels and the number plates
  car.root.traverse((o) => {
    if (o instanceof THREE.Mesh && (o.geometry.userData['orig'] || o.geometry.userData['own']))
      o.geometry.dispose();
  });
  if (car.kitMat) car.kitMat.dispose();
  car.paint.dispose();
  car.glassMat.dispose();
  car.rubberMat.dispose();
  car.trimMat.dispose();
  car.ballMat.dispose();
  disposeCarPaint(car);
  car.crewMat.dispose();
  car.numMat.dispose(); // (not its map: the number textures are shared, see numberTexture)
  if (car.tagSprite) car.tagSprite.material.dispose();
  if (car.tagTex) car.tagTex.dispose();
}

// Copy physics state onto the meshes.
export function syncCarVisual(car: Car, dt: number) {
  const r = car.root;
  const sys = car.sys;
  r.position.copy(car.pos);
  const sy = Math.sin(car.yaw),
    cy = Math.cos(car.yaw);
  // a flat tyre drops its corner a little
  const low = (i: number) => (sys.wheelOff[i] ? 2.6 : sys.tires[i] ? 0 : 1); // how far each corner has dropped
  const flatL = low(0) + low(2),
    flatR = low(1) + low(3),
    flatF = low(0) + low(1),
    flatB = low(2) + low(3);
  if (car.grounded) {
    car.slope.p = damp(car.slope.p, (flatF - flatB) * 0.022, 18, dt);
    car.slope.r = damp(car.slope.r, -(flatL - flatR) * 0.035, 18, dt);
  } else {
    const vF = car.vel.x * sy + car.vel.z * cy;
    car.slope.p = damp(
      car.slope.p,
      clamp(-Math.atan2(car.vel.y, Math.max(Math.abs(vF), 4)) * 0.7, -0.5, 0.5),
      2.5,
      dt,
    );
    car.slope.r = damp(car.slope.r, 0, 2, dt);
  }
  r.rotation.set(car.slope.p, car.yaw, car.slope.r);
  car.body.rotation.set(car.lean.p, 0, car.lean.r);
  car.body.position.y = -car.land * 0.06;
  car.panelMotion.update(car.bodywork, G.time, Math.hypot(car.vel.x, car.vel.z), dt);
  // wheels: spin, steer, flat tyres squash, broken axles splay
  const vF = car.vel.x * sy + car.vel.z * cy;
  car.spin += (vF / CARDIM.wheelR) * dt;
  car.wheels.forEach((w, i) => {
    if (!w.attached) return;
    const flat = !sys.tires[i],
      bent = !sys.axles[w.front ? 0 : 1];
    w.mesh.rotation.x = car.spin;
    w.steer.scale.set(1, flat ? 0.78 : 1, flat ? 0.94 : 1);
    w.steer.position.y = w.baseY - (flat ? 0.06 : 0);
    w.steer.rotation.z = bent ? (w.left ? 0.22 : -0.22) : 0;
    w.steer.rotation.y = w.front ? -car.steer + (bent ? Math.sin(G.time * 11 + i) * 0.08 : 0) : 0;
  });
  if (car.steeringPivot) car.steeringPivot.quaternion.setFromAxisAngle(STEER_AXIS, car.steer * 3.2);
  for (const s of GUN_SEATS) {
    const g = gunAt(car, s),
      rig = requireValue(car.turrets[s === 1 ? 'hood' : 'trunk']);
    rig.yaw.rotation.y = wrapPi(g.yaw - car.yaw);
    rig.pitch.rotation.x = -(g.pitch + (g.loft || 0)) + g.recoil * 0.04; // barrel lifts to lob the balls
  }
}
const STEER_AXIS = new THREE.Vector3(0, 0.423, -0.906).normalize();

export function setTPL(value: typeof TPL): void {
  TPL = value;
}
