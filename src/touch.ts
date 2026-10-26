import { requireValue } from './required-fields.ts';
import {
  bindInputFocusLoss,
  gameControlsActive,
  releaseTouchInput,
  type TouchInputState,
} from './browser-input-lifecycle.ts';
import { requiredElement, dataValue } from './browser-dom.ts';
import { deviceInfo } from './gameplay/devices.ts';
import { gunAt } from './gameplay/guns.ts';
import type { Viewport } from './hud-types.ts';
import type { LocalHuman } from './human-types.ts';
import type { ControlFrame, Direction } from './gameplay/input.ts';
import { clamp } from './core.ts';
import { G } from './state.ts';
import { usesMouse } from './device-mode.ts';
import { Input } from './gameplay/input.ts';
import { JOBS, JOB_AREA, dashFit, taskAt } from './mechanic.ts';
import { lifecycle } from './lifecycle.ts';
import { isReplica } from './net/role.ts';

// =====================================================================
//  Touch: phones and tablets
//  Touch is a device like the keys and the gamepads (DEVICES.touch). Whoever plays by touch gets
//  controls laid out for their seat, over their view: the driver's left thumb steers and the right
//  one works the pedals; a gunner drags to aim and holds FIRE; a mechanic taps a job, then works the
//  screen. readControls() turns them into the same control frame as every other device's, so touch
//  plays the same offline, on the host and on other screens. The pointer handlers only record what
//  the fingers do: each frame reads that (readTouch) and draws the controls (syncTouch).
// =====================================================================
const STEER_SIDE = 0.45; // the driver's left part of the view, where a thumb steers
const STEER_DEAD = 0.08; // how much of the steering knob's reach steers nothing
const LOOK = 0.0048; // how far a turret turns for a pixel dragged (radians)
const TAP_SLOP = 12; // how far a finger may move and still tap (px)
const SWIPE = 34; // how far a finger moves on the dash for a direction (px)
const DIAL = 40; // how far off where it landed a finger pushes the dial's needle all the way (px)
const HOSE = 0.004; // GAMES.spray: how far the hose moves for a pixel of the mouse (of its area)

// ---------------------------------------------------------------------
//  Which device: the touch screen, and the last device used
// ---------------------------------------------------------------------
const coarse = matchMedia('(pointer: coarse)');
let touched = false; // a finger (or a pen) has been on this screen
/** Whether this screen can be touched: a phone, a tablet, or a screen with a finger on it before. */
export const touchScreen = (): boolean => coarse.matches || touched || navigator.maxTouchPoints > 0;
document.documentElement.classList.toggle('touchscreen', touchScreen());

// The last device used wins: what was used last (touch, kbm or a gamepad), and a count of everything
// used so far. Players, and the setup's seats, go over to it when there's been input since they looked.
// Before any input it's what the screen suggests: touch where the main pointer is a finger.
const last = { dev: coarse.matches ? 'touch' : 'kbm', seq: 0 };
let setupSeq = -1;
const used = (dev: string): void => {
  last.dev = dev;
  last.seq++;
};
const NOT_PLAYING = new Set(['Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']); // (Esc pauses for everyone)
let mouseMoved = 0; // a mouse nudged a little doesn't take anyone off the touch screen
addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'mouse') return used('kbm');
    touched = true;
    mouseMoved = 0;
    document.documentElement.classList.add('touchscreen');
    used('touch');
  },
  { capture: true, passive: true },
);
addEventListener(
  'pointermove',
  (e) => {
    if (e.pointerType !== 'mouse' || last.dev === 'kbm') return;
    mouseMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (mouseMoved > 40) {
      mouseMoved = 0;
      used('kbm');
    }
  },
  { passive: true },
);
addEventListener('wheel', () => used('kbm'), { passive: true });
addEventListener('keydown', (e) => {
  if (!NOT_PLAYING.has(e.key)) used('kbm');
});

/** A button pressed on a gamepad is using it (control.ts, once a frame when the pads are read). */
export function notePads(): void {
  Input.pads.forEach((p, i) => {
    if (p && p.buttons.some((b, k) => b && !Input.padPrev[i]?.[k])) used('pad' + i);
  });
}

/** This screen's own device for a player: touch if a finger was used last, else the keys and mouse. */
export const screenDevice = (): string => (last.dev === 'touch' ? 'touch' : 'kbm');

/**
 * The device a player of this screen plays with now. They go over to the last device used: the
 * player at the keys and mouse to the touch screen and back, and a player alone on this screen to a
 * gamepad too. The keys split between players (WASD, arrows, the mouse) stay with whoever has them.
 */
export function nextDevice(h: LocalHuman): string {
  const seen = h.devSeq ?? Math.max(setupSeq, 0); // (a new player: whatever came after the setup)
  h.devSeq = last.seq;
  const to = last.dev,
    from = h.device;
  if (seen === last.seq || to === from) return from;
  if (from !== 'kbm' && from !== 'touch' && !from.startsWith('pad')) return from;
  if (G.humans.length > 1 && (from.startsWith('pad') || to.startsWith('pad'))) return from; // split screen: the pads stay put
  if (to.startsWith('pad') && !Input.pads[+requireValue(to[3])]) return from;
  const taken = new Set(G.humans.filter((o) => o !== h).flatMap((o) => deviceInfo(o.device)?.uses ?? []));
  return deviceInfo(to)?.uses.some((r: string) => taken.has(r)) ? from : to;
}

/** A player goes over to another device. Offline and on the host the setup seats them by it: renamed there too. */
export function useDevice(h: LocalHuman, dev: string): void {
  const was = h.device;
  h.device = dev;
  if (!isReplica()) {
    for (const cars of [G.cfg.cars, lifecycle().getSetup().cars])
      for (const c of cars) c.seats = c.seats.map((s) => (s === was ? dev : s));
    lifecycle().saveSetup();
  }
  if (document.pointerLockElement && !usesMouse()) document.exitPointerLock();
  lifecycle().rebuildHud();
}

/** On the start screen the player at the keys and mouse, or at the touch screen, follows the last of them used. */
export function followSetup(cars: { seats: string[] }[]): void {
  if (setupSeq === last.seq) return;
  setupSeq = last.seq;
  const to = last.dev,
    from = to === 'touch' ? 'kbm' : to === 'kbm' ? 'touch' : '';
  const seats = cars.flatMap((c) => c.seats);
  if (!from || !seats.includes(from)) return;
  const taken = new Set(
    seats.filter((s) => s !== from && deviceInfo(s)).flatMap((s) => deviceInfo(s)?.uses ?? []),
  );
  if (deviceInfo(to)?.uses.some((r: string) => taken.has(r))) return;
  for (const c of cars) c.seats = c.seats.map((s) => (s === from ? to : s));
}

// ---------------------------------------------------------------------
//  Full screen, and the screen kept on
// ---------------------------------------------------------------------
/** Full screen and sideways, where the browser lets a page ask (an iPhone doesn't: there it's Add to Home Screen). */
export function goFullscreen(): void {
  const page = document.documentElement;
  if (document.fullscreenElement || !document.fullscreenEnabled || !page.requestFullscreen) return;
  page
    .requestFullscreen({ navigationUI: 'hide' })
    .then(async () => {
      const orientation = screen.orientation;
      if ('lock' in orientation && typeof orientation.lock === 'function')
        await orientation.lock('landscape');
    })
    .catch(() => {});
}
const fullButtons = [...document.querySelectorAll<HTMLElement>('[data-fullscreen]')]; // in the pause menu and while waiting
for (const b of fullButtons) b.addEventListener('click', goFullscreen);
// Starting by touch goes full screen at once, before the round's first finger has to.
document.getElementById('startBtn')?.addEventListener('click', () => {
  if (last.dev === 'touch') {
    askedFull = true;
    goFullscreen();
  }
});

// While a round is played by touch the screen stays on (a mechanic waiting for a job touches nothing for a while).
let wake: WakeLockSentinel | null = null;
let wakePending = false,
  wakeGeneration = 0;
function keepAwake(): void {
  if (wake || wakePending || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  wakePending = true;
  const generation = wakeGeneration;
  navigator.wakeLock
    .request('screen')
    .then((lock) => {
      // The controls may have closed while the browser was handling the request.
      if (generation !== wakeGeneration) {
        lock.release().catch(() => {});
        return;
      }
      wake = lock;
      lock.addEventListener('release', () => {
        if (wake === lock) wake = null;
      });
    })
    .catch(() => {
      /* transient denial: the next touch can try again */
    })
    .finally(() => {
      wakePending = false;
    });
}

// ---------------------------------------------------------------------
//  The controls (index.html #touch), and what the fingers on them do
// ---------------------------------------------------------------------
const root = requiredElement('#touch', HTMLElement);
const part = (sel: string): HTMLElement => requiredElement(sel, HTMLElement, root);
const steerBase = part('.t-steer'),
  steerKnob = part('.t-steer i'),
  dpad = part('.t-dpad'),
  jobsPad = part('.t-jobs');
const dropButton = part('.t-drop'),
  seatButton = part('.t-seat');
const pedals = [...root.querySelectorAll<HTMLElement>('[data-pedal]')];
// everything that lights up while it's held, by name
const lights: [HTMLElement, string][] = [
  ...pedals.map((p): [HTMLElement, string] => [p, dataValue(p, 'pedal')]),
  ...[...dpad.querySelectorAll<HTMLElement>('[data-dir]')].map((d): [HTMLElement, string] => [
    d,
    dataValue(d, 'dir'),
  ]),
  [part('.t-fire'), 'fire'],
  [part('.t-zoom'), 'zoom'],
  [steerBase, 'steer'],
  [jobsPad, 'jobs'],
];

// What the controls show, as the last frame laid them out: the handlers go by it.
const view: { h: LocalHuman | null; seat: string; job: string; vp: Viewport } = {
  h: null,
  seat: '',
  job: '',
  vp: { x: 0, y: 0, w: 1, h: 1 },
};

type Kind = 'none' | 'button' | 'steer' | 'pedal' | 'look' | 'fire' | 'dpad' | 'list' | 'job';
interface Finger {
  kind: Kind;
  x: number;
  y: number; // where it is
  x0: number;
  y0: number; // where it landed
  sx: number;
  sy: number; // where its last swipe ended
  moved: boolean;
  reach: number;
  pedal?: string;
  dir?: Direction | null;
}
const touchInput: TouchInputState<Finger> = {
  fingers: new Map(),
  look: { dx: 0, dy: 0 }, // finger movement since the last frame (px)
  presses: new Set(),
  dirs: [], // oldest first: a frame takes one
  listTap: null,
  zoomed: false,
};
const { fingers, look, presses, dirs } = touchInput;
let read = false,
  askedFull = false;

// The controls' boxes, measured when a finger first needs them after the layout changed (between
// frames the page's layout is clean, so that costs no extra layout).
let boxes: Map<HTMLElement, DOMRect> | null = null;
function box(e: HTMLElement): DOMRect {
  boxes ??= new Map();
  let r = boxes.get(e);
  if (!r) {
    r = e.getBoundingClientRect();
    boxes.set(e, r);
  }
  return r;
}
// The pedal under a finger. The one it's on keeps a margin, so a thumb between two doesn't flicker.
function pedalAt(x: number, y: number, held: string | undefined): string | undefined {
  let hit: string | undefined;
  for (const p of pedals) {
    const r = box(p),
      m = p.dataset['pedal'] === held ? 16 : 0;
    if (x < r.left - m || x > r.right + m || y < r.top - m || y > r.bottom + m) continue;
    if (p.dataset['pedal'] === held) return held;
    hit ??= p.dataset['pedal'];
  }
  return hit;
}
// The arrow under a finger on the arrows: whichever way it is from the middle.
function dirAt(x: number, y: number): Direction | null {
  const r = box(dpad),
    dx = x - (r.left + r.width / 2),
    dy = y - (r.top + r.height / 2);
  if (Math.max(Math.abs(dx), Math.abs(dy)) < r.width * 0.12) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}
const dirOf = (dx: number, dy: number): Direction =>
  Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
// A point of the page on the mechanic's dash, in its units.
function onDash(vp: Viewport, x: number, y: number): { x: number; y: number } {
  const f = dashFit(vp);
  return { x: (x - vp.x - f.x) / f.s, y: (y - vp.y - f.y) / f.s };
}

root.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!view.seat) return;
  try {
    root.setPointerCapture(e.pointerId);
  } catch {
    /* it's lifted already */
  }
  if (!askedFull) {
    askedFull = true;
    goFullscreen();
  }
  keepAwake();
  if (!(e.target instanceof Element)) return;
  const x = e.clientX,
    y = e.clientY,
    t = e.target,
    vp = view.vp;
  const f: Finger = { kind: 'none', x, y, x0: x, y0: y, sx: x, sy: y, moved: false, reach: 1 };
  const pedal = t.closest<HTMLElement>('[data-pedal]'),
    button = t.closest<HTMLElement>('[data-touch]');
  if (pedal) {
    f.kind = 'pedal';
    f.pedal = dataValue(pedal, 'pedal');
  } else if (button?.dataset['touch'] === 'fire') f.kind = 'fire';
  else if (button) {
    f.kind = 'button';
    presses.add(dataValue(button, 'touch'));
    if (button.dataset['touch'] === 'pause') Input.pressed.add('Escape'); // it does what Esc does (flow.ts)
  } else if (t.closest('.t-dpad')) {
    f.kind = 'dpad';
    f.dir = dirAt(x, y);
    if (f.dir) dirs.push(f.dir);
  } else if (view.seat === 'drive' && x - vp.x < vp.w * STEER_SIDE) {
    f.kind = 'steer';
    f.reach = Math.max(20, (steerBase.offsetWidth - steerKnob.offsetWidth) / 2);
  } else if (view.seat === 'drive' || view.seat === 'gun') f.kind = 'look';
  else if (view.seat === 'mech' && view.job !== 'list') {
    f.kind = 'job';
    presses.add('act');
  } // the job in hand: the screen is its button
  else if (view.seat === 'mech') {
    const p = onDash(vp, x, y);
    if (p.x >= JOBS.x && p.x <= JOBS.x + JOBS.w && p.y >= JOBS.y && p.y <= JOBS.y + JOBS.h) f.kind = 'list';
  }
  fingers.set(e.pointerId, f);
});

root.addEventListener('pointermove', (e) => {
  const f = fingers.get(e.pointerId);
  if (!f) return;
  const x = e.clientX,
    y = e.clientY;
  if (f.kind === 'look' || f.kind === 'fire' || f.kind === 'job') {
    look.dx += x - f.x;
    look.dy += y - f.y;
  } // (FIRE aims as it slides)
  f.x = x;
  f.y = y;
  if (!f.moved && Math.hypot(x - f.x0, y - f.y0) > TAP_SLOP) f.moved = true;
  if (f.kind === 'pedal') {
    const pedal = pedalAt(x, y, f.pedal);
    if (pedal === undefined) delete f.pedal;
    else f.pedal = pedal;
  } else if (f.kind === 'dpad') {
    const d = dirAt(x, y);
    if (d && d !== f.dir) dirs.push(d); // a thumb rolled onto the next arrow presses it
    f.dir = d;
  } else if (f.kind === 'job' || f.kind === 'list') {
    // a swipe on the dash is a direction; on the jobs list a drag moves the pick, a row at a time
    const dx = x - f.sx,
      dy = y - f.sy,
      step = f.kind === 'list' ? 23 * dashFit(view.vp).s : SWIPE;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < step || (f.kind === 'list' && Math.abs(dx) > Math.abs(dy)))
      return;
    if (dirs.length < 6) dirs.push(dirOf(dx, dy));
    f.sx = x;
    f.sy = y;
  }
});

function lift(e: PointerEvent, cancelled: boolean): void {
  const f = fingers.get(e.pointerId);
  if (!f) return;
  fingers.delete(e.pointerId);
  if (f.kind === 'list' && !f.moved && !cancelled) touchInput.listTap = { x: f.x0, y: f.y0 };
}
root.addEventListener('pointerup', (e) => lift(e, false));
root.addEventListener('pointercancel', (e) => lift(e, true));
root.addEventListener('lostpointercapture', (e) => lift(e, true));
// No scrolling, zooming, long-press menus, or the mouse events a browser makes up after a tap.
root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
root.addEventListener('contextmenu', (e) => e.preventDefault());

// Everything let go of (the controls go away, or someone else plays by touch now).
function letGo(): void {
  releaseTouchInput(touchInput);
  read = false;
  wakeGeneration++;
  const lock = wake;
  wake = null;
  lock?.release().catch(() => {});
}

bindInputFocusLoss(window, document, () => document.hidden, letGo);

// ---------------------------------------------------------------------
//  Every frame: the control frame, and the controls drawn
// ---------------------------------------------------------------------
const seatOf = (h: LocalHuman): string =>
  h.dead || !h.car.alive ? 'out' : h.seat === 0 ? 'drive' : h.seat === 3 ? 'mech' : 'gun';

/** The touch screen as one control frame (control.ts readControls): each seat reads the fields it needs. */
export function readTouch(h: LocalHuman, out: ControlFrame, _dt: number): void {
  read = true;
  const seat = seatOf(h),
    held = { up: false, down: false, left: false, right: false };
  let gas = false,
    brake = false,
    hand = false,
    nitro = false,
    fire = false,
    steer: Finger | null = null,
    job: Finger | null = null;
  for (const f of fingers.values()) {
    if (f.kind === 'pedal') {
      gas ||= f.pedal === 'gas' || f.pedal === 'nitro'; // (nitro is full throttle with the boost)
      brake ||= f.pedal === 'brake';
      hand ||= f.pedal === 'hand';
      nitro ||= f.pedal === 'nitro';
    } else if (f.kind === 'fire') fire = true;
    else if (f.kind === 'steer') steer = f;
    else if (f.kind === 'job') job = f;
    else if (f.kind === 'dpad' && f.dir) held[f.dir] = true;
  }
  out.switchP = presses.has('seat');
  if (seat === 'drive') {
    out.throttle = (gas ? 1 : 0) - (brake ? 1 : 0);
    out.handbrake = hand;
    out.boost = nitro;
    if (steer) {
      const u = clamp((steer.x - steer.x0) / steer.reach, -1, 1),
        a = Math.max(0, (Math.abs(u) - STEER_DEAD) / (1 - STEER_DEAD));
      out.steer = Math.sign(u) * a ** 1.3;
    }
    out.camP = presses.has('cam');
    out.orbit = look.dx; // a drag on the right looks round in the chase camera
    dirs.length = 0;
    return;
  }
  out.x = (held.right ? 1 : 0) - (held.left ? 1 : 0);
  out.y = (held.up ? 1 : 0) - (held.down ? 1 : 0);
  out.tap = dirs.shift() ?? null;
  if (seat === 'gun') {
    if (presses.has('zoom')) touchInput.zoomed = !touchInput.zoomed;
    out.dYaw = -look.dx * LOOK;
    out.dPitch = -look.dy * LOOK;
    out.fire = fire;
    out.zoom = touchInput.zoomed;
  } else if (seat === 'mech') {
    const M = h.mech,
      game = M?.game?.type;
    out.a = !!job;
    out.aP = presses.has('act');
    out.bP = presses.has('drop');
    if (game === 'dial' && job) out.x = clamp(out.x + (job.x - job.x0) / DIAL, -1, 1); // the finger pushes the needle
    if (game === 'spray') {
      // the hose follows the finger
      const s = dashFit(h.vp).s;
      out.mdx = look.dx / (JOB_AREA.w * s * HOSE);
      out.mdy = look.dy / (JOB_AREA.h * s * HOSE);
    }
    if (touchInput.listTap && M && !game) {
      const p = onDash(h.vp, touchInput.listTap.x, touchInput.listTap.y),
        id = taskAt(M, p.x, p.y);
      if (id) {
        out.pick = id;
        out.aP = id === M.sel;
      } // a job picked already starts
    }
  }
}

/** The end of a frame (control.ts endInputFrame): what was pressed is used up. */
export function endTouchFrame(): void {
  look.dx = look.dy = 0;
  presses.clear();
  touchInput.listTap = null;
  if (!read) dirs.length = 0; // nobody read them
  read = false;
}

// What was last written to the page, so that a frame writes only what changed.
const shown = { on: false, layout: '', lit: '', base: '', knob: '', seat: '', full: null as boolean | null };

/** Every frame (views.ts updateHud): the controls for the seat of whoever plays by touch, over their view. */
export function syncTouch(): void {
  const can = touchScreen() && !!document.fullscreenEnabled && !document.fullscreenElement;
  if (can !== shown.full) {
    shown.full = can;
    for (const b of fullButtons) b.hidden = !can;
  }
  const h = gameControlsActive(G.state, G.menuOpen, document.hidden)
    ? (G.humans.find((p) => p.device === 'touch') ?? null)
    : null;
  if (!!h !== shown.on) {
    shown.on = !!h;
    root.hidden = !h;
    if (!h) letGo();
  }
  if (!h) {
    view.h = null;
    view.seat = '';
    return;
  }
  const seat = seatOf(h),
    game = seat === 'mech' ? h.mech?.game : null,
    jam = seat === 'gun' && gunAt(h.car, h.seat).jam;
  const job = seat === 'mech' ? (game?.type ?? 'list') : '';
  // the arrows: a gunner clearing a jam, and the mechanic's jobs that go by directions
  const arrows =
    jam || job === 'dents' || job === 'dial' || (game?.type === 'nuts' && game.i < game.seq.length);
  if (h !== view.h || seat !== view.seat) letGo(); // held gestures belong to the previous owner/seat
  view.h = h;
  view.seat = seat;
  view.job = job;
  view.vp = h.vp;
  const vp = h.vp,
    layout = `${seat} ${job} ${jam} ${arrows} ${vp.x} ${vp.y} ${vp.w} ${vp.h}`;
  if (layout !== shown.layout) {
    shown.layout = layout;
    boxes = null;
    Object.assign(root.style, {
      left: vp.x + 'px',
      top: vp.y + 'px',
      width: vp.w + 'px',
      height: vp.h + 'px',
    });
    root.dataset['seat'] = seat;
    root.dataset['job'] = job;
    root.toggleAttribute('data-jam', jam);
    root.toggleAttribute('data-arrows', arrows);
    if (seat === 'mech') {
      // the job screen on the dash, and its button to drop the job
      const f = dashFit(vp);
      Object.assign(jobsPad.style, {
        left: f.x + JOBS.x * f.s + 'px',
        top: f.y + JOBS.y * f.s + 'px',
        width: JOBS.w * f.s + 'px',
        height: JOBS.h * f.s + 'px',
      });
      Object.assign(dropButton.style, {
        left: f.x + (JOBS.x + JOBS.w) * f.s + 'px',
        top: f.y + (JOBS.y - 6) * f.s + 'px',
      });
    }
  }
  const label = seat === 'out' ? 'View' : 'Seat'; // wrecked: watch another car
  if (label !== shown.seat) {
    shown.seat = label;
    seatButton.textContent = label;
  }
  // what's held lights up; the steering comes to the thumb
  const lit = new Set<string>(),
    steer = [...fingers.values()].find((f) => f.kind === 'steer');
  for (const f of fingers.values()) {
    if (f.kind === 'pedal' && f.pedal) lit.add(f.pedal);
    else if (f.kind === 'fire') lit.add('fire');
    else if (f.kind === 'dpad' && f.dir) lit.add(f.dir);
    else if (f.kind === 'job' || f.kind === 'list') lit.add('jobs');
  }
  if (touchInput.zoomed) lit.add('zoom');
  if (steer) lit.add('steer');
  const litKey = [...lit].join(' ');
  if (litKey !== shown.lit) {
    shown.lit = litKey;
    for (const [e, name] of lights) e.classList.toggle('on', lit.has(name));
  }
  const base = steer ? `${steer.x0 - vp.x} ${steer.y0 - vp.y}` : '';
  if (base !== shown.base) {
    shown.base = base;
    steerBase.style.left = steer ? steer.x0 - vp.x + 'px' : '';
    steerBase.style.top = steer ? steer.y0 - vp.y + 'px' : '';
  }
  const knob = steer ? `${clamp(steer.x - steer.x0, -steer.reach, steer.reach)}px 0` : '';
  if (knob !== shown.knob) {
    shown.knob = knob;
    steerKnob.style.translate = knob;
  }
}

addEventListener('resize', () => {
  boxes = null;
});
