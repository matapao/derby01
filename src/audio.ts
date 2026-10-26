import { requireValue } from './required-fields.ts';
import type { Car } from './car-types.ts';
import type { Vector3 } from 'three';
import { clamp } from './math.ts';
import { createAudioSample, fetchAudioSample, type AudioSampleLoader } from './audio-sample.ts';
type Position = Pick<Vector3, 'x' | 'y' | 'z'>;
interface NoiseOptions {
  freq?: number;
  q?: number;
  type?: BiquadFilterType;
  vol?: number;
  attack?: number;
  pitchDrop?: number;
  pos?: Position | null;
  delay?: number;
}
interface ToneOptions {
  type?: OscillatorType;
  vol?: number;
  slide?: number;
  pos?: Position | null;
  delay?: number;
}
interface AudioRuntime {
  ctx: AudioContext;
  master: GainNode;
  noiseBuf: AudioBuffer;
}
// Shared visual effects temporarily replace Math.random; sound must never consume their sequence.
const audioRandom = Math.random;

// =====================================================================
//  Procedural Web Audio: independent of rendering and world state
// =====================================================================
export function createSoundEffects(
  createContext: () => AudioContext = () => new AudioContext(),
  random: () => number = audioRandom,
  loadSample: AudioSampleLoader = fetchAudioSample,
) {
  const rand = (a: number, b: number): number => a + random() * (b - a);
  let runtime: AudioRuntime | null = null;
  let volume = 0.55;
  const marker = createAudioSample('assets/audio/paintball-shot-fabianofa.mp3', loadSample);
  const listeners: Vector3[] = []; // world positions of local players' cameras
  function init() {
    if (runtime) {
      const { ctx } = runtime;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      void marker.load(runtime);
      return;
    } // ('interrupted' on iOS too)
    let candidate: AudioContext | null = null;
    try {
      const ctx = (candidate = createContext());
      const master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = random() * 2 - 1;
      runtime = { ctx, master, noiseBuf };
      void marker.load(runtime);
    } catch {
      void candidate?.close().catch(() => {});
      runtime = null;
    } // no sound, then
  }
  function gainAt(pos: Position | null) {
    if (!pos || !listeners.length) return 1;
    let best = Infinity;
    for (const l of listeners) best = Math.min(best, l.distanceToSquared(pos));
    return clamp(1 / (1 + Math.sqrt(best) * 0.06), 0.05, 1);
  }
  function noise(
    dur: number,
    {
      freq = 1000,
      q = 1,
      type = 'bandpass',
      vol = 0.5,
      attack = 0.002,
      pitchDrop = 0,
      pos = null,
      delay = 0,
    }: NoiseOptions,
  ) {
    if (!runtime) return;
    const { ctx, master, noiseBuf } = runtime;
    const g = vol * gainAt(pos);
    if (g < 0.02) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = rand(0.85, 1.15);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (pitchDrop) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * pitchDrop), t + dur);
    const a = ctx.createGain();
    a.gain.setValueAtTime(0, t);
    a.gain.linearRampToValueAtTime(g, t + attack);
    a.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(a).connect(master);
    src.onended = () => {
      src.disconnect();
      f.disconnect();
      a.disconnect();
    };
    src.start(t, random() * 0.5, dur + 0.05);
  }
  function tone(
    freq: number,
    dur: number,
    { type = 'square', vol = 0.2, slide = 1, pos = null, delay = 0 }: ToneOptions = {},
  ) {
    if (!runtime) return;
    const { ctx, master } = runtime;
    const g = vol * gainAt(pos);
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const a = ctx.createGain();
    a.gain.setValueAtTime(g, t);
    a.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.onended = () => {
      o.disconnect();
      a.disconnect();
    };
    o.connect(a).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  // engines: one voice per car someone local is sitting in
  // The engine: a V8-ish burble. The revs come from a five-speed box, so they climb through every gear
  // and stay up at top speed; the throttle opens it up, and lifting off at high revs pops and crackles.
  const engines = new Map<Car, ReturnType<typeof makeEngine>>();
  const retiringEngines = new Map<ReturnType<typeof makeEngine>, ReturnType<typeof setTimeout>>();
  const GEARS = [0, 0.15, 0.31, 0.5, 0.72, 1.0]; // the top of each gear, as a share of top speed
  let driveCurve: Float32Array<ArrayBuffer> | null = null;
  function makeEngine({ ctx, master, noiseBuf }: AudioRuntime) {
    if (!driveCurve) {
      driveCurve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) driveCurve[i] = Math.tanh((i / 511.5 - 1) * 1.65) * 0.9;
    }
    const osc = (type: OscillatorType) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.start();
      return o;
    };
    const gain = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const out = gain(0),
      mix = gain(0.8),
      trem = gain(0.7);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.8;
    lp.frequency.value = 700;
    const chest = ctx.createBiquadFilter();
    chest.type = 'peaking';
    chest.frequency.value = 95;
    chest.Q.value = 0.7;
    chest.gain.value = 8;
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve;
    shaper.oversample = '2x';
    // A rounded firing pulse carries the weight; a lower saw adds exhaust texture, with a little bite above.
    const o1 = osc('triangle'),
      o2 = osc('sawtooth'),
      o3 = osc('sawtooth');
    o1.connect(gain(0.66)).connect(mix);
    o2.connect(gain(0.4)).connect(mix);
    o3.connect(gain(0.08)).connect(mix);
    // the lumpy idle: the level wobbles at a quarter of the firing rate
    const lfo = osc('sine'),
      lfoAmt = gain(0.3);
    lfo.connect(lfoAmt).connect(trem.gain);
    mix.connect(trem).connect(shaper).connect(chest).connect(lp).connect(out);
    // exhaust roar: noise through a band-pass that follows the revs
    const nz = ctx.createBufferSource();
    nz.buffer = noiseBuf;
    nz.loop = true;
    nz.start();
    const nbp = ctx.createBiquadFilter();
    nbp.type = 'bandpass';
    nbp.Q.value = 0.85;
    const ng = gain(0);
    nz.connect(nbp).connect(ng).connect(lp);
    // supercharger whine on boost
    const wh = osc('sine'),
      wg = gain(0);
    wh.connect(wg).connect(out);
    out.connect(master);
    return {
      out,
      lp,
      o1,
      o2,
      o3,
      lfo,
      lfoAmt,
      nbp,
      ng,
      wh,
      wg,
      rpm: 0.2,
      gear: 1,
      shift: 0,
      last: ctx.currentTime,
      thr: 0,
      popCd: 0,
      stop() {
        for (const n of [o1, o2, o3, lfo, wh, nz]) {
          try {
            n.stop();
          } catch {
            /* stopped already */
          }
        }
        for (const n of [o1, o2, o3, lfo, lfoAmt, mix, trem, shaper, chest, lp, nz, nbp, ng, wh, wg, out])
          n.disconnect();
      },
    };
  }
  function engine(car: Car, on: boolean) {
    if (!runtime) return;
    const { ctx } = runtime;
    let e = engines.get(car);
    if (!on) {
      if (e) {
        e.out.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
        const stopped = e;
        retiringEngines.set(
          stopped,
          setTimeout(() => {
            retiringEngines.delete(stopped);
            stopped.stop();
          }, 500),
        );
        engines.delete(car);
      }
      return;
    }
    if (!e) {
      e = makeEngine(runtime);
      engines.set(car, e);
    }
    const t = ctx.currentTime,
      dt = clamp(t - e.last, 0.001, 0.1);
    e.last = t;
    const thr = Math.max(0, car.ctrl.throttle),
      sp = Math.hypot(car.vel.x, car.vel.z),
      u = sp / 29;
    if (e.gear < 5 && u > requireValue(GEARS[e.gear])) {
      e.gear++;
      e.shift = 0.14;
    } // up a gear (with a little dip)
    else if (e.gear > 1 && u < requireValue(GEARS[e.gear - 1]) * 0.88) e.gear--;
    const lo = requireValue(GEARS[e.gear - 1]),
      hi = requireValue(GEARS[e.gear]);
    let want = 0.34 + 0.62 * clamp((u - lo) / (hi - lo), 0, 1.08);
    if (e.gear === 1 && sp < 1.5) want = 0.18 + thr * 0.45; // standing still: idling, or revving it
    if (car.burn && car.burn.on) want += 0.1; // wheels spinning in a burn
    if (car.boosting) want += 0.04;
    if (car.mods.power <= 0 || !car.alive) want = 0.08;
    want = Math.min(1.05, want);
    e.rpm += (want - e.rpm) * (1 - Math.exp(-(want > e.rpm ? 10 : 7) * dt));
    e.shift = Math.max(0, e.shift - dt);
    const r = e.rpm,
      f = 22 + r * 115; // firing pulse: roughly 43 Hz at idle, 132 Hz near the top of a gear
    e.o1.frequency.setTargetAtTime(f, t, 0.02);
    e.o2.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    e.o3.frequency.setTargetAtTime(f * 2, t, 0.02);
    e.lfo.frequency.setTargetAtTime(f * 0.25, t, 0.03);
    e.lfoAmt.gain.setTargetAtTime(0.3 * (1 - r * 0.8), t, 0.05);
    e.lp.frequency.setTargetAtTime(320 + r * 1550 + thr * 1200 + (car.boosting ? 250 : 0), t, 0.04);
    e.nbp.frequency.setTargetAtTime(100 + r * 650, t, 0.05);
    e.ng.gain.setTargetAtTime(0.035 + thr * r * 0.11, t, 0.05);
    e.wh.frequency.setTargetAtTime(650 + r * 1300, t, 0.05);
    e.wg.gain.setTargetAtTime(car.boosting ? 0.004 + r * 0.006 : 0, t, 0.08);
    e.out.gain.setTargetAtTime(
      car.alive ? (0.09 + thr * 0.07 + r * 0.06) * (e.shift > 0 ? 0.6 : 1) : 0,
      t,
      0.04,
    );
    // off the throttle at high revs: the exhaust pops and crackles
    e.popCd -= dt;
    if (e.thr > 0.6 && thr < 0.15 && r > 0.6 && e.popCd <= 0) {
      e.popCd = 0.8;
      for (let i = 0, n = 2 + ((random() * 3) | 0); i < n; i++)
        noise(0.045, {
          freq: rand(500, 1100),
          type: 'lowpass',
          vol: rand(0.12, 0.22),
          delay: 0.04 + i * rand(0.06, 0.12),
        });
    }
    e.thr = thr;
  }
  function stopEngines() {
    for (const car of [...engines.keys()]) engine(car, false);
  }
  function setVolume(value: number): void {
    if (!Number.isFinite(value)) return;
    volume = clamp(value, 0, 1);
    if (runtime) runtime.master.gain.setTargetAtTime(volume, runtime.ctx.currentTime, 0.02);
  }
  function dispose(): void {
    marker.dispose();
    for (const engine of engines.values()) engine.stop();
    engines.clear();
    for (const [engine, timer] of retiringEngines) {
      clearTimeout(timer);
      engine.stop();
    }
    retiringEngines.clear();
    const previous = runtime;
    runtime = null;
    void previous?.ctx.close().catch(() => {});
  }
  return {
    init,
    setVolume,
    dispose,
    listeners,
    engine,
    stopEngines,
    // A recorded paintball marker, with a pneumatic fallback while it loads or if audio decoding fails.
    gun: (pos: Position | null) => {
      if (!marker.play(0.5 * gainAt(pos), rand(0.96, 1.04)))
        noise(0.065, { freq: 1900, q: 0.8, type: 'bandpass', vol: 0.22, pos });
    },
    // wet splat; strength > 1 for paint bombs
    splat: (pos: Position | null, s = 1) => {
      noise(0.07 + s * 0.05, {
        freq: 1100 / Math.sqrt(s),
        q: 0.7,
        type: 'lowpass',
        vol: Math.min(0.5, 0.13 * s),
        pitchDrop: 0.4,
        pos,
      });
      tone(rand(240, 300) / Math.sqrt(s), 0.06 + s * 0.02, {
        type: 'triangle',
        vol: Math.min(0.3, 0.07 * s),
        slide: 0.45,
        pos,
      });
    },
    // rubber bumper torn off
    thud: (pos: Position | null) => {
      tone(rand(70, 90), 0.16, { type: 'sine', vol: 0.3, slide: 0.6, pos });
      noise(0.1, { freq: 400, type: 'lowpass', vol: 0.18, pos });
    },
    // glass cracking
    crack: (pos: Position | null, s = 1) => {
      noise(0.05 + s * 0.03, { freq: 4200, q: 0.8, type: 'highpass', vol: Math.min(0.3, 0.1 * s), pos });
      tone(rand(2600, 3400), 0.04, { type: 'triangle', vol: 0.05, slide: 0.7, pos });
    },
    beepOk: () => {
      tone(1320, 0.07, { type: 'square', vol: 0.07 });
      tone(1760, 0.09, { type: 'square', vol: 0.06, delay: 0.06 });
    },
    // party popper for a car that is out, and a cheer from somewhere
    popper: (pos: Position | null) => {
      noise(0.12, { freq: 2400, q: 0.6, type: 'highpass', vol: 0.5, pos });
      tone(rand(180, 220), 0.1, { type: 'sine', vol: 0.4, slide: 0.4, pos });
      noise(1.3, { freq: 1300, q: 0.35, type: 'bandpass', vol: 0.12, attack: 0.25 });
      tone(880, 0.12, { type: 'square', vol: 0.05, delay: 0.1 });
      tone(1175, 0.18, { type: 'square', vol: 0.05, delay: 0.2 });
    },
    pickup: () => {
      tone(523, 0.08, { type: 'square', vol: 0.08 });
      tone(659, 0.08, { type: 'square', vol: 0.08, delay: 0.07 });
      tone(988, 0.16, { type: 'square', vol: 0.08, delay: 0.14 });
    },
    crash: (pos: Position | null, s: number) => {
      noise(0.25 + Math.min(s, 15) * 0.03, {
        freq: 700,
        q: 0.6,
        type: 'lowpass',
        vol: clamp(s * 0.07, 0.1, 0.8),
        pitchDrop: 0.3,
        pos,
      });
      if (s > 6) tone(90, 0.2, { type: 'triangle', vol: 0.25, slide: 0.5, pos });
    },
    clank: (pos: Position | null) => noise(0.12, { freq: 2500, q: 4, vol: 0.12, pos }),
    nitro: (pos: Position | null) => {
      noise(0.8, { freq: 700, q: 0.7, vol: 0.4, pitchDrop: 0.6, pos });
      noise(0.25, { freq: 3200, q: 1.5, vol: 0.18, pos });
      tone(62, 0.7, { type: 'sawtooth', vol: 0.14, slide: 1.8, pos });
    }, // the nitro hitting: whoosh and roar
    hit: () => tone(1250, 0.05, { type: 'square', vol: 0.07 }),
    click: () => tone(300, 0.04, { type: 'square', vol: 0.06 }),
    count: (go: boolean) => tone(go ? 880 : 440, go ? 0.5 : 0.18, { type: 'square', vol: 0.15 }),
    // mechanic jobs
    weld: () => noise(0.09, { freq: 4200, q: 1.5, type: 'highpass', vol: 0.07 }),
    clang: () => {
      tone(620, 0.14, { type: 'triangle', vol: 0.13, slide: 0.8 });
      noise(0.06, { freq: 3200, q: 6, vol: 0.07 });
    },
    spray: () => noise(0.2, { freq: 2600, q: 0.5, type: 'highpass', vol: 0.05 }),
    glug: () => tone(rand(120, 170), 0.12, { type: 'sine', vol: 0.14, slide: 1.6 }),
    ok: () => {
      tone(660, 0.1, { type: 'square', vol: 0.09 });
      tone(990, 0.18, { type: 'square', vol: 0.09, delay: 0.09 });
    },
    fail: () => tone(150, 0.18, { type: 'square', vol: 0.08, slide: 0.7 }),
  };
}

export const SFX = createSoundEffects();

// Browsers only let sound start from a click or a key: the first one anywhere wakes it up (the menu's
// START button does too), so players who join or play by keyboard hear it as well.
export function bindAudio(target: EventTarget = window, sound: Pick<typeof SFX, 'init'> = SFX): () => void {
  const unlock = () => sound.init();
  for (const event of ['pointerdown', 'keydown']) target.addEventListener(event, unlock, { passive: true });
  return () => {
    for (const event of ['pointerdown', 'keydown']) target.removeEventListener(event, unlock);
  };
}
