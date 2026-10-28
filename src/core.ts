import { requireValue } from './required-fields.ts';
import { CAR_HALF_LENGTH } from './gameplay/geometry.ts';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import * as THREE from 'three';
import { D, onData } from './data.ts';

// =====================================================================
//  Small helpers
// =====================================================================
export { TAU, clamp, damp, lerp, wrapPi } from './math.ts';
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export function pick<T>(arr: readonly T[]): T {
  const value = arr[(Math.random() * arr.length) | 0];
  if (value === undefined) throw new Error('Cannot pick from an empty list');
  return value;
}
export function $(sel: string, root: ParentNode = document): HTMLElement {
  const node = root.querySelector(sel);
  if (!(node instanceof HTMLElement)) throw new Error(`Missing HTML element: ${sel}`);
  return node;
}
export const _v1 = new THREE.Vector3(),
  _v2 = new THREE.Vector3(),
  _v3 = new THREE.Vector3();
export const _q1 = new THREE.Quaternion();

// =====================================================================
//  Game constants
// =====================================================================
// The teams (data/teams.json): the car's paint (color) and the brighter colour of its paint and HUD (ui).
export const TEAMS: { name: string; color: string; ui: string }[] = [];
onData(() => {
  TEAMS.length = 0;
  for (const t of D.teams.teams) TEAMS.push({ name: t.name, color: t.paint, ui: t.ui });
});

// Car-local space: +Z = forward, +X = left side, +Y = up, ground at y = 0.
// Everyone sits inside. The driver is front left; both guns are small remote turrets.
export const SEATS: {
  key: string;
  label: string;
  role: string;
  eye?: [number, number, number];
  turret?: 'hood' | 'trunk';
}[] = [
  { key: 'driver', label: 'Driver', role: 'DRIVER', eye: [0.38, 1.2, 0.08] },
  { key: 'hood', label: 'Rear left · hood gun', role: 'HOOD GUNNER', turret: 'hood' },
  { key: 'trunk', label: 'Rear right · trunk gun', role: 'TRUNK GUNNER', turret: 'trunk' },
  { key: 'mech', label: 'Mechanic · front seat', role: 'MECHANIC', eye: [-0.38, 1.2, 0.08] },
];
// where they sit: the driver front left, the mechanic front right, and the two gunners in the back,
// wearing goggles that show them the camera on their turret (the hood one and the trunk one)
export const SEAT_INSIDE: [number, number, number][] = [
  [0.4, 1.16, 0.02],
  [0.4, 1.14, -0.85],
  [-0.4, 1.14, -0.85],
  [-0.4, 1.16, 0.02],
];
export const GUN_SEATS = [1, 2] as const;
// what the seats are called (data/car.json)
onData(() =>
  SEATS.forEach((s, i) =>
    Object.assign(s, D.car.seats[(['driver', 'hood', 'trunk', 'mechanic'] as const)[i]!]),
  ),
);
// Turret mounts: position on the car, the direction it faces at rest, and how far it can swing.
export const TURRETS: Record<
  'hood' | 'trunk',
  { pos: [number, number, number]; center: number; arc: number; cam: [number, number, number] }
> = {
  // cam: how far behind / above the gun its gunner's camera sits
  hood: { pos: [0, 0.915, 1.45], center: 0, arc: 1.95, cam: [1.3, 0.68, -0.08] },
  trunk: { pos: [0, 0.84, -1.72], center: Math.PI, arc: 1.95, cam: [1.3, 0.72, -0.08] },
};
// which way each faces and how far it swings (data/car.json); where it is mounted is the model's
onData(() => {
  for (const k of ['hood', 'trunk'] as const)
    Object.assign(TURRETS[k], { center: D.car.turrets[k].facing, arc: D.car.turrets[k].arc });
});

// Input devices. Devices that share a resource cannot be used by two people at once.
export { DEVICES, deviceInfo } from './gameplay/devices.ts';
export const isHumanSlot = (s: string | null | undefined): s is string =>
  typeof s === 'string' && s.length > 0 && s !== 'bot' && s !== 'empty';

// Both turrets are paintball markers. Balls fly in an arc (the gun lofts them onto the crosshair).
// The marker barely cools while firing, so holding the trigger overheats it in about three seconds;
// a hot marker can jam (a ball breaks in the breech) and its gunner has to clear it.
export const GUN = D.guns; // (data/guns.json)

const CAR_HW = 0.97,
  CAR_HL = CAR_HALF_LENGTH;
export const CARDIM = {
  hw: CAR_HW,
  hl: CAR_HL,
  top: 1.48,
  bottom: 0.22, // half width / length include the rubber bumpers
  mass: 1200,
  wheelbase: 2.4,
  wheelR: 0.289,
  inertia: 0, // a box's, about the vertical axis
  // FL, FR, RL, RR  (x, z)
  wheels: [
    [0.71, 1.281],
    [-0.7, 1.281],
    [0.71, -1.123],
    [-0.7, -1.123],
  ] as [number, number][],
};
/** A car's health at the start of a round (data/car.json hp). */
export let MAX_HP = 100;
onData(() => {
  CARDIM.mass = D.car.mass;
  CARDIM.inertia = (CARDIM.mass * ((2 * CAR_HL) ** 2 + (2 * CAR_HW) ** 2)) / 12;
  MAX_HP = D.car.hp;
});
// slope frames of the glass (bottom edge, direction up the glass, outward normal), measured from the model
export const GLASS = {
  shield: { y: 0.932, z: 0.94, uy: 0.72, uz: -0.694, ny: 0.694, nz: 0.72, rx: -0.767, len: 0.706 },
  rear: { y: 0.903, z: -1.317, uy: 0.821, uz: 0.572, ny: 0.572, nz: -0.821, rx: 0.609, len: 0.642 },
};
export const STEP = 1 / 120;

// =====================================================================
//  Car model: load the FBX and prepare reusable parts
// =====================================================================
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
export const DETACHABLE = ['car_hood', 'trunk', 'L_Door_Front', 'R_Door_Front', 'L_Door_Back', 'R_Door_Back'];

// The car model, cut into parts: the body, four wheels, the steering wheel and the panels that come off.
export interface CarPart {
  geo: THREE.BufferGeometry;
  glassSlots: boolean[];
  pos: THREE.Vector3;
}
export interface CarTemplate {
  tex: { base: THREE.Texture; mask: THREE.Texture; emissive: THREE.Texture } | null; // null: the boxy stand-in
  body: CarPart[];
  wheels: CarPart[];
  steering: CarPart | null;
  parts: Record<string, CarPart | null>;
}

export async function loadCarTemplate(): Promise<CarTemplate> {
  const dir = 'assets/car/';
  const res = await fetch(dir + 'Car.fbx');
  if (!res.ok) throw new Error(`Car.fbx: HTTP ${res.status}`);
  const fbxBuf = await res.arrayBuffer();
  const urls = [dir + 'car-paint-base.jpg', dir + 'car-paint-mask.png', dir + 'car-emissive.png'] as const;
  // The model names texture files that aren't shipped (the game paints the car itself): a blank pixel instead.
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(() => BLANK_PNG);
  const fbx = new FBXLoader(manager).parse(fbxBuf, '');
  const tl = new THREE.TextureLoader();
  const [base, mask, emissive] = await Promise.all([
    tl.loadAsync(urls[0]),
    tl.loadAsync(urls[1]),
    tl.loadAsync(urls[2]),
  ]);
  base.colorSpace = THREE.SRGBColorSpace;
  emissive.colorSpace = THREE.SRGBColorSpace;
  for (const t of [base, mask, emissive]) {
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return buildTemplateFromFbx(fbx, { base, mask, emissive });
}

function buildTemplateFromFbx(fbx: THREE.Group, tex: CarTemplate['tex']): CarTemplate {
  fbx.updateMatrixWorld(true);
  const raw: Record<string, { geo: THREE.BufferGeometry; glassSlots: boolean[] }> = {};
  const box = new THREE.Box3();
  fbx.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld); // bake the messy FBX pivots into the vertices
    g.computeBoundingBox();
    if (g.boundingBox) box.union(g.boundingBox);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    raw[o.name.toLowerCase()] = { geo: g, glassSlots: mats.map((m) => /window|glass/i.test(m.name)) };
  });
  // Normalise: 4.73 m long, centred on X/Z, wheels touching y = 0.
  const size = box.getSize(new THREE.Vector3());
  const s = 4.73 / Math.max(size.z, 1e-6);
  const c = box.getCenter(new THREE.Vector3());
  for (const part of Object.values(raw)) {
    part.geo.translate(-c.x, -box.min.y, -c.z);
    part.geo.scale(s, s, s);
    part.geo.computeBoundingBox();
  }
  const take = (name: string) => {
    const p = raw[name.toLowerCase()];
    if (!p) return null;
    delete raw[name.toLowerCase()];
    const bounds = p.geo.boundingBox;
    if (!bounds) throw new Error('Car part has no bounds');
    const ctr = bounds.getCenter(new THREE.Vector3());
    p.geo.translate(-ctr.x, -ctr.y, -ctr.z); // pivot at the part's own centre
    p.geo.computeBoundingSphere();
    return { geo: p.geo, glassSlots: p.glassSlots, pos: ctr };
  };
  const tpl: CarTemplate = {
    tex,
    parts: {},
    body: [],
    wheels: ['L_Tire_front', 'R_Tire_Front', 'L_Tire_Back', 'R_Tire_Back'].map((name) => {
      const part = take(name);
      if (!part) throw new Error(`Missing wheel ${name}`);
      return part;
    }),
    steering: null,
  };
  for (const n of DETACHABLE) tpl.parts[n] = take(n);
  tpl.steering = take('Steering_wheel');
  tpl.body = Object.values(raw).map((p: { geo: THREE.BufferGeometry; glassSlots: boolean[] }) => {
    p.geo.computeBoundingSphere();
    return { geo: p.geo, glassSlots: p.glassSlots, pos: new THREE.Vector3() };
  });
  if (tpl.wheels.some((w) => !w)) throw new Error('Unexpected car model layout');
  addDentAttribute(tpl);
  return tpl;
}

// aDent: how crumpled each vertex is (0 = untouched). aCar: where the vertex sits on the car at rest,
// which is where paint splats are looked up (so paint stays put on dented or flying panels).
function addDentAttribute(tpl: CarTemplate) {
  const all = [...tpl.body, ...tpl.wheels, ...Object.values(tpl.parts), tpl.steering].filter(
    (p): p is CarPart => p !== null,
  );
  for (const p of all) {
    if (!p.geo.getAttribute('aDent'))
      p.geo.setAttribute(
        'aDent',
        new THREE.BufferAttribute(new Float32Array(p.geo.getAttribute('position').count), 1),
      );
    if (!p.geo.getAttribute('aCar')) addCarPosAttribute(p.geo, p.pos);
  }
}
export function addCarPosAttribute(geo: THREE.BufferGeometry, offset: THREE.Vector3) {
  const P = geo.getAttribute('position'),
    a = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++)
    a.set([P.getX(i) + offset.x, P.getY(i) + offset.y, P.getZ(i) + offset.z], i * 3);
  geo.setAttribute('aCar', new THREE.BufferAttribute(a, 3));
}

// Paint on a car lives in one canvas per car: the car seen from the left, right, top, front and back
// at 88 px per metre. Regions are [x, y, w, h] in canvas pixels.
export const ATLAS = {
  W: 432,
  H: 576,
  PX: 88,
  ZMIN: -2.45,
  YMAX: 1.55,
  XMIN: -0.95,
  L: [0, 0, 431, 136],
  R: [0, 136, 431, 136],
  T: [0, 272, 431, 167],
  F: [0, 439, 167, 136],
  B: [168, 439, 167, 136],
};
const f4 = (n: number) => n.toFixed(4);
const v4 = (r: number[]) => `vec4(${r.map(f4).join(', ')})`;
const CAR_PAINT_VERT = 'attribute vec3 aCar;\nvarying vec3 vCar;\nvarying vec3 vCarN;\n';
const CAR_PAINT_FRAG = `uniform sampler2D paintAtlas;
varying vec3 vCar;
varying vec3 vCarN;
vec4 carPaint() {
  vec3 n = normalize(vCarN), a = abs(n);
  vec4 r; vec2 p;
  if (a.x >= a.y && a.x >= a.z) { r = n.x > 0.0 ? ${v4(ATLAS.L)} : ${v4(ATLAS.R)}; p = vec2(vCar.z - (${f4(ATLAS.ZMIN)}), ${f4(ATLAS.YMAX)} - vCar.y); }
  else if (a.y >= a.z) { if (n.y < 0.0) return vec4(0.0); r = ${v4(ATLAS.T)}; p = vec2(vCar.z - (${f4(ATLAS.ZMIN)}), vCar.x - (${f4(ATLAS.XMIN)})); }
  else { r = n.z > 0.0 ? ${v4(ATLAS.F)} : ${v4(ATLAS.B)}; p = vec2(vCar.x - (${f4(ATLAS.XMIN)}), ${f4(ATLAS.YMAX)} - vCar.y); }
  p = clamp(p * ${f4(ATLAS.PX)}, vec2(0.5), r.zw - 0.5) + r.xy;
  return texture2D(paintAtlas, vec2(p.x / ${f4(ATLAS.W)}, 1.0 - p.y / ${f4(ATLAS.H)}));
}
`;
const EMPTY_TEX = new THREE.DataTexture(new Uint8Array(4), 1, 1);
EMPTY_TEX.needsUpdate = true;
// Adds the car's paint on top of whatever the material draws: glossy wet paint that also covers the lights.
function injectCarPaint(sh: THREE.WebGLProgramParametersWithUniforms, u: Record<string, THREE.IUniform>) {
  Object.assign(sh.uniforms, u);
  sh.vertexShader =
    CAR_PAINT_VERT +
    sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vCar = aCar;\n  vCarN = normal;',
    );
  sh.fragmentShader =
    CAR_PAINT_FRAG +
    sh.fragmentShader
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n  vec4 pnt = carPaint();\n  diffuseColor.rgb = mix( diffuseColor.rgb, pnt.rgb, pnt.a );',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix( roughnessFactor, 0.22, pnt.a );',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n  metalnessFactor = mix( metalnessFactor, 0.0, pnt.a );',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= 1.0 - pnt.a * 0.85;',
      );
}

// Simple boxy stand-in, used only if the car model can't be loaded.
export function buildFallbackTemplate(): CarTemplate {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => ({
    geo: new THREE.BoxGeometry(w, h, d),
    glassSlots: [false],
    pos: new THREE.Vector3(x, y, z),
  });
  const body = box(1.66, 0.55, 4.6, 0, 0.55, 0);
  const cabin = box(1.4, 0.55, 2.0, 0, 1.18, -0.3);
  const wheelGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.22, 16).rotateZ(Math.PI / 2);
  const tpl: CarTemplate = {
    tex: null,
    parts: {},
    body: [body, cabin],
    wheels: CARDIM.wheels.map(([x, z]) => ({
      geo: wheelGeo,
      glassSlots: [false],
      pos: new THREE.Vector3(x, 0.289, z),
    })),
    steering: null,
  };
  tpl.parts['car_hood'] = box(1.4, 0.06, 1.2, 0, 0.86, 1.6);
  tpl.parts['trunk'] = box(1.4, 0.06, 0.8, 0, 0.86, -1.8);
  tpl.parts['L_Door_Front'] = box(0.06, 0.6, 0.95, 0.84, 0.75, 0.44);
  tpl.parts['R_Door_Front'] = box(0.06, 0.6, 0.95, -0.84, 0.75, 0.44);
  tpl.parts['L_Door_Back'] = box(0.06, 0.6, 0.85, 0.84, 0.75, -0.53);
  tpl.parts['R_Door_Back'] = box(0.06, 0.6, 0.85, -0.84, 0.75, -0.53);
  addDentAttribute(tpl);
  return tpl;
}

// ---------------------------------------------------------------------
//  Materials. One paint texture + a paint mask gives any team colour.
// ---------------------------------------------------------------------
export function makePaintMaterial(tpl: CarTemplate, colorHex: THREE.ColorRepresentation) {
  const u: Record<string, THREE.IUniform> = {
    paintColor: { value: new THREE.Color(colorHex) },
    damage: { value: 0 },
    lightsF: { value: 1 },
    lightsR: { value: 1 },
    paintAtlas: { value: EMPTY_TEX },
  };
  if (!tpl.tex) {
    const m = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.55, metalness: 0.1 });
    m.userData['u'] = u;
    m.onBeforeCompile = (sh) => injectCarPaint(sh, { paintAtlas: requireValue(u['paintAtlas']) });
    m.customProgramCacheKey = () => 'car-paint-plain';
    return m;
  }
  const m = new THREE.MeshStandardMaterial({
    map: tpl.tex.base,
    emissiveMap: tpl.tex.emissive,
    emissive: 0xffffff,
    emissiveIntensity: 1.1,
    roughness: 0.52,
    metalness: 0.12,
  });
  m.userData['u'] = u;
  u['paintMask'] = { value: tpl.tex.mask };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader =
      'attribute float aDent;\nvarying float vDent;\nvarying vec3 vObjPos;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vDent = aDent;\n  vObjPos = position;',
      );
    sh.fragmentShader =
      'uniform vec3 paintColor;\nuniform sampler2D paintMask;\nuniform float damage, lightsF, lightsR;\nvarying float vDent;\nvarying vec3 vObjPos;\n' +
      'float h21(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }\n' +
      'float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);\n' +
      '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }\n' +
      sh.fragmentShader
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          float pm = texture2D( paintMask, vMapUv ).r;
          sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * paintColor, pm );
          float grime = h21( floor( vMapUv * 96.0 ) );
          sampledDiffuseColor.rgb *= 1.0 - damage * ( 0.45 + 0.45 * grime );
          // dented panels: scraped to bare metal along creases, darker in the folds
          float dent = clamp( vDent, 0.0, 1.0 );
          float scrape = smoothstep( 0.55, 0.8, vnoise( vMapUv * vec2( 90.0, 14.0 ) ) + dent * 0.45 ) * dent * pm;
          sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, vec3( 0.58, 0.57, 0.55 ), scrape * 0.75 );
          sampledDiffuseColor.rgb *= 1.0 - dent * 0.32;
          // a beaten car rusts through in patches
          float rust = smoothstep( 0.6, 0.85, vnoise( vMapUv * 26.0 ) + dent * 0.25 ) * clamp( damage * 1.4 + dent * 0.6, 0.0, 1.0 ) * pm;
          sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, vec3( 0.36, 0.17, 0.07 ), rust * 0.8 );
          diffuseColor *= sampledDiffuseColor;
        #endif`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= vObjPos.z > 0.0 ? lightsF : lightsR;',
        );
    injectCarPaint(sh, {});
  };
  m.customProgramCacheKey = () => 'car-paint';
  return m;
}

// Any part of a car that should show the paint splats (the rubber bumpers).
export function makePaintedMaterial(params: THREE.MeshStandardMaterialParameters) {
  const u = { paintAtlas: { value: EMPTY_TEX } };
  const m = new THREE.MeshStandardMaterial(params);
  m.userData['u'] = u;
  m.onBeforeCompile = (sh) => injectCarPaint(sh, u);
  m.customProgramCacheKey = () => 'painted-part';
  return m;
}

// Car windows: paint and cracks on the side and rear windows come from the car's atlases.
// The view is picked by where the pane sits, so both faces of a pane show the same thing.
// The windshield is left alone here: it has its own paint (that the wipers clear) and cracks.
const GLASS_FRAG = `uniform sampler2D paintAtlas;
uniform sampler2D crackAtlas;
uniform float frontGlassOn;
uniform float rearGlassOn;
varying vec3 vCar;
varying vec3 vCarN;
bool glassUV(out vec2 uv) {
  vec3 a = abs(normalize(vCarN));
  vec4 r; vec2 p;
  if (a.x >= a.y && a.x >= a.z) { r = vCar.x > 0.0 ? ${v4(ATLAS.L)} : ${v4(ATLAS.R)}; p = vec2(vCar.z - (${f4(ATLAS.ZMIN)}), ${f4(ATLAS.YMAX)} - vCar.y); }
  else if (vCar.z < -0.3) { r = ${v4(ATLAS.B)}; p = vec2(vCar.x - (${f4(ATLAS.XMIN)}), ${f4(ATLAS.YMAX)} - vCar.y); }
  else return false;
  p = clamp(p * ${f4(ATLAS.PX)}, vec2(0.5), r.zw - 0.5) + r.xy;
  uv = vec2(p.x / ${f4(ATLAS.W)}, 1.0 - p.y / ${f4(ATLAS.H)});
  return true;
}
`;
export function makeGlassMaterial() {
  const u = {
    paintAtlas: { value: EMPTY_TEX },
    crackAtlas: { value: EMPTY_TEX },
    frontGlassOn: { value: 1 },
    rearGlassOn: { value: 1 },
  };
  const m = new THREE.MeshStandardMaterial({
    color: 0x1b2833,
    transparent: true,
    opacity: 0.42,
    roughness: 0.06,
    metalness: 0.35,
    depthWrite: false,
  });
  m.userData['u'] = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader =
      CAR_PAINT_VERT +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vCar = aCar;\n  vCarN = normal;',
      );
    sh.fragmentShader =
      GLASS_FRAG +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  vec3 ga = abs(normalize(vCarN));
  if (!(ga.x >= ga.y && ga.x >= ga.z)) {
    if (vCar.z < -0.3 && rearGlassOn < 0.5) discard;
    if (vCar.z >= -0.3 && frontGlassOn < 0.5) discard;
  }
  vec2 guv;
  if ( glassUV( guv ) ) {
    vec4 ck = texture2D( crackAtlas, guv ), pnt = texture2D( paintAtlas, guv );
    diffuseColor.rgb = mix( diffuseColor.rgb, ck.rgb, ck.a * 0.85 );
    diffuseColor.a = max( diffuseColor.a, ck.a * 0.8 );
    diffuseColor.rgb = mix( diffuseColor.rgb, pnt.rgb, pnt.a );
    diffuseColor.a = max( diffuseColor.a, pnt.a * 0.95 );
  }`,
      );
  };
  m.customProgramCacheKey = () => 'car-glass';
  return m;
}

export function setPaintDamage(mat: THREE.MeshStandardMaterial, d: number) {
  const u = mat.userData['u'];
  u.damage.value = d;
  if (!mat.map) mat.color.copy(u.paintColor.value).multiplyScalar(1 - d * 0.75);
}

export const SHARED = {
  gunMetal: new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.45, metalness: 0.75 }),
  darkMetal: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.6, metalness: 0.5 }),
};
