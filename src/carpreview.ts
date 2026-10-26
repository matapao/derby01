import type { Car } from './car-types.ts';
import { canvasContext } from './browser-dom.ts';
import * as THREE from 'three';
import { createCar, disposeCar, syncCarVisual } from './car.ts';

// =====================================================================
//  The setup screen's car previews: each car row shows its car, kit and colour, turning slowly. One
//  small renderer draws them all in turn and copies each into the row's canvas, at one pixel for each
//  CSS pixel (shown with square pixels, like the game). It runs only while the setup screen is up:
//  stopCarPreviews() frees it (GPU memory and all) when a game starts.
// =====================================================================
const W = 132,
  H = 72; // the previews' size
interface PreviewRow {
  key: string;
  car: Car;
  canvas?: HTMLCanvasElement;
}
interface Preview {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cars: Map<number, PreviewRow>;
  raf: number;
}
let P: Preview | null = null; // { renderer, scene, camera, cars: Map(row -> { key, car }), raf }

function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setSize(W, H, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3344, 1.3));
  const sun = new THREE.DirectionalLight(0xfff4e6, 1.8);
  sun.position.set(3, 6, 5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(26, W / H, 0.1, 50);
  camera.position.set(3.5, 1.55, 4.6); // close enough that the car fills the frame
  camera.lookAt(0, 0.6, 0);
  P = { renderer, scene, camera, cars: new Map(), raf: 0 };
  P.raf = requestAnimationFrame(frame);
  return P;
}

// Show these cars ({ team, kit } each) in these canvases (one per car row).
export function showCarPreviews(
  cars: Pick<import('./setup.ts').CarSetup, 'team' | 'kit'>[],
  canvases: HTMLCanvasElement[],
): void {
  const preview = P ?? start();
  const live = new Set();
  cars.forEach((cfg, i: number) => {
    const canvas = canvases[i],
      key = `${cfg.team}:${cfg.kit}`;
    if (!canvas) return;
    canvas.width = W;
    canvas.height = H;
    let row = preview.cars.get(i);
    if (row && row.key !== key) {
      drop(row);
      row = undefined;
    }
    if (!row) {
      const car = createCar(i, { team: cfg.team, kit: cfg.kit, seats: ['bot', 'bot', 'bot', 'bot'] });
      preview.scene.add(car.root);
      row = { key, car };
      preview.cars.set(i, row);
    }
    row.canvas = canvas;
    live.add(i);
  });
  for (const [i, row] of preview.cars)
    if (!live.has(i)) {
      drop(row);
      preview.cars.delete(i);
    }
}

function drop(row: PreviewRow) {
  row.car.root.removeFromParent();
  disposeCar(row.car);
}

function frame(t: number) {
  if (!P) return;
  const preview = P;
  P.raf = requestAnimationFrame(frame);
  for (const [i, row] of preview.cars) {
    if (!row.canvas || !row.canvas.isConnected) continue;
    for (const r of P.cars.values()) r.car.root.visible = r === row; // one car at a time
    row.car.yaw = t * 0.0006 + i * 1.3;
    syncCarVisual(row.car, 0);
    P.renderer.render(P.scene, P.camera);
    const g = canvasContext(row.canvas);
    if (!g) throw new Error('Preview canvas 2D is unavailable');
    g.clearRect(0, 0, row.canvas.width, row.canvas.height);
    g.drawImage(P.renderer.domElement, 0, 0);
  }
}

export function stopCarPreviews(): void {
  if (!P) return;
  cancelAnimationFrame(P.raf);
  for (const row of P.cars.values()) drop(row);
  P.renderer.dispose();
  P.renderer.forceContextLoss();
  P = null;
}
