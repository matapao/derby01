/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { bindAudio, createSoundEffects } from '../src/audio.ts';
import { canvasContext, dataValue, setHtml } from '../src/browser-dom.ts';
import { requireFields, requireValue } from '../src/required-fields.ts';
import { deviceInfo } from '../src/gameplay/devices.ts';
import { isDropKind } from '../src/gameplay/supplies.ts';
import { gunAt, gunKey, isGunSeat } from '../src/gameplay/guns.ts';
import { createChaseState, advanceChaseOrbit } from '../src/gameplay/camera-state.ts';
import type { VehicleState, GunState } from '../src/gameplay/model.ts';
import type { Car } from '../src/car-types.ts';
import { withSeed } from '../src/net/seeded.ts';
import { createAudioSample } from '../src/audio-sample.ts';

const noSample = async (): Promise<ArrayBuffer> => {
  throw new Error('No recording in this fixture');
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise is not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function audioFixture() {
  let starts = 0;
  let failStart = false;
  let closed = 0;
  const parameter = () => ({
    value: 0,
    setValueAtTime(value: number) {
      this.value = value;
    },
    linearRampToValueAtTime(value: number) {
      this.value = value;
    },
    exponentialRampToValueAtTime(value: number) {
      this.value = value;
    },
    setTargetAtTime(value: number) {
      this.value = value;
    },
  });
  const node = () => {
    const value = {
      type: '',
      buffer: null as AudioBuffer | null,
      onended: null as (() => void) | null,
      stops: 0,
      disconnects: 0,
      gain: parameter(),
      frequency: parameter(),
      Q: parameter(),
      playbackRate: parameter(),
      connect() {
        return value;
      },
      disconnect() {
        this.disconnects++;
      },
      start() {
        if (failStart) {
          failStart = false;
          throw new Error('Audio source failed to start');
        }
        starts++;
      },
      stop() {
        this.stops++;
      },
    };
    return value;
  };
  const oscillators: ReturnType<typeof node>[] = [];
  const filters: ReturnType<typeof node>[] = [];
  const gains: ReturnType<typeof node>[] = [];
  const sources: ReturnType<typeof node>[] = [];
  const decoded = { duration: 0.468 } as AudioBuffer;
  let decode = async (_bytes: ArrayBuffer): Promise<AudioBuffer> => decoded;
  const context = {
    state: 'running',
    currentTime: 0,
    sampleRate: 8,
    destination: node(),
    createGain: () => {
      const value = node();
      gains.push(value);
      return value;
    },
    createBuffer: () => ({ getChannelData: () => new Float32Array(12) }),
    createBufferSource: () => {
      const value = node();
      sources.push(value);
      return value;
    },
    createBiquadFilter: () => {
      const value = node();
      filters.push(value);
      return value;
    },
    createOscillator: () => {
      const value = node();
      oscillators.push(value);
      return value;
    },
    createWaveShaper: node,
    decodeAudioData: (bytes: ArrayBuffer) => decode(bytes),
    close: async () => {
      closed++;
    },
  };
  return {
    context: context as unknown as AudioContext,
    oscillators,
    filters,
    gains,
    sources,
    decoded,
    closed: () => closed,
    failNextStart() {
      failStart = true;
    },
    setDecode(value: typeof decode) {
      decode = value;
    },
    advance() {
      context.currentTime += 0.1;
    },
    starts: () => starts,
  };
}

function engineCar(): Car {
  // Audio reads only these fields; this fixture owns no renderer or game state.
  return {
    ctrl: { throttle: 0 },
    vel: { x: 0, z: 0 },
    mods: { power: 1 },
    alive: true,
    boosting: false,
    burn: null,
  } as unknown as Car;
}

test('a spectator chase camera starts finite and stays finite while orbiting', () => {
  const state = createChaseState();
  for (let frame = 0; frame < 600; frame++) {
    assert.ok(Number.isFinite(advanceChaseOrbit(state, 0.7, 1 / 60, 0.22)));
    assert.ok(Number.isFinite(state.orbitIdle));
  }
  state.orbit = 100;
  const before = state.orbitYaw;
  advanceChaseOrbit(state, 0.7, 1 / 60);
  assert.ok(state.orbitYaw < before);
  state.orbit = 0;
  for (let frame = 0; frame < 600; frame++) advanceChaseOrbit(state, 0.7, 1 / 60);
  assert.ok(Math.abs(state.orbitYaw) < 0.001, 'letting go returns the camera behind the car');
});

test('only gun seats can access gun state or mount keys', () => {
  const makeGun = (): GunState => ({
    yaw: 0,
    pitch: 0,
    cd: 0,
    heat: 0,
    overheat: false,
    jam: false,
    recoil: 0,
    firing: false,
    zoom: 0,
    aimPoint: new Vector3(),
  });
  const car: Pick<VehicleState, 'gun'> = { gun: [null, makeGun(), makeGun(), null] };
  assert.equal(gunAt(car, 1), car.gun[1]);
  assert.equal(gunAt(car, 2), car.gun[2]);
  assert.equal(gunKey(1), 'hood');
  assert.equal(gunKey(2), 'trunk');
  for (const seat of [0, 3, -1, 4, 1.5, NaN]) {
    assert.equal(isGunSeat(seat), false);
    assert.throws(() => gunAt(car, seat), /has no gun/);
    assert.throws(() => gunKey(seat), /has no gun/);
  }
});

test('device and supply lookup reject prototype keys and unknown values', () => {
  assert.deepEqual(deviceInfo('kbm')?.uses, ['keysL', 'mouse']);
  for (const value of ['__proto__', 'constructor', 'peer:1', 'missing'])
    assert.equal(deviceInfo(value), undefined);
  for (const value of ['fuel', 'tyre', 'bumper', 'glass']) assert.equal(isDropKind(value), true);
  for (const value of [null, undefined, {}, 'constructor', 'tyres']) assert.equal(isDropKind(value), false);
});

test('incomplete construction cannot publish missing attachments', () => {
  const state: { body?: object | null; wheels?: object[] } = {};
  assert.throws(() => requireFields(state, ['body', 'wheels']), /body/);
  state.body = {};
  assert.throws(() => requireFields(state, ['body', 'wheels']), /wheels/);
  state.wheels = [];
  assert.doesNotThrow(() => requireFields(state, ['body', 'wheels']));
  state.body = null;
  assert.throws(() => requireFields(state, ['body']), /body/);
});

test('unavailable canvas contexts fail before the first drawing call', () => {
  const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
  assert.throws(() => canvasContext(canvas), /Canvas 2D/);
});

test('markup caching repairs externally cleared content and validates required data', () => {
  const element = { innerHTML: '', dataset: { seat: '3' } } as unknown as HTMLElement;
  setHtml(element, '<b>Score</b>');
  element.innerHTML = '';
  setHtml(element, '<b>Score</b>');
  assert.equal(element.innerHTML, '<b>Score</b>');
  assert.equal(dataValue(element, 'seat'), '3');
  assert.throws(() => dataValue(element, 'car'), /data-car/);
  assert.throws(() => dataValue(element, 'constructor'), /data-constructor/);
});

test('audio unlock listeners are owned and removable', () => {
  const target = new EventTarget();
  let unlocks = 0;
  const unbind = bindAudio(target, {
    init: () => {
      unlocks++;
    },
  });
  target.dispatchEvent(new Event('pointerdown'));
  target.dispatchEvent(new Event('keydown'));
  assert.equal(unlocks, 2);
  unbind();
  unbind();
  target.dispatchEvent(new Event('pointerdown'));
  target.dispatchEvent(new Event('keydown'));
  assert.equal(unlocks, 2);
});

test('denied audio creation stays silent and retries on a later gesture', () => {
  let attempts = 0;
  const sound = createSoundEffects(() => {
    attempts++;
    throw new Error('Audio is blocked');
  });
  sound.init();
  assert.doesNotThrow(() => {
    sound.click();
    sound.crack(null);
    sound.stopEngines();
  });
  sound.init();
  assert.equal(attempts, 2);
});

test('failed audio initialization closes its partially created context', () => {
  let closed = 0;
  const context = {
    createGain() {
      throw new Error('Audio resources exhausted');
    },
    close() {
      closed++;
      return Promise.resolve();
    },
  } as unknown as AudioContext;
  const sound = createSoundEffects(() => context);
  assert.doesNotThrow(() => sound.init());
  assert.equal(closed, 1);
  assert.doesNotThrow(() => sound.click());
});

test('engine voices stay deep while RPM and throttle retain audible feedback', () => {
  const audio = audioFixture();
  const sound = createSoundEffects(
    () => audio.context,
    () => 0.5,
    noSample,
  );
  const car = engineCar();
  sound.init();
  assert.equal(audio.gains[0]?.gain.value, 0.55, 'effects start at the established default volume');
  function run(frames: number) {
    for (let frame = 0; frame < frames; frame++) {
      audio.advance();
      sound.engine(car, true);
    }
  }
  run(20);
  const [fundamental, sub, upper, , whine] = audio.oscillators;
  const lowpass = audio.filters.find((filter) => filter.type === 'lowpass');
  const exhaust = audio.filters.find((filter) => filter.type === 'bandpass');
  assert.ok(fundamental && sub && upper && whine && lowpass && exhaust);
  const idlePitch = fundamental.frequency.value;
  const idleCutoff = lowpass.frequency.value;
  const idleExhaust = exhaust.frequency.value;
  assert.ok(idlePitch > 30 && idlePitch < 55, 'idle has a low firing pulse, rather than a high buzz');
  assert.equal(fundamental.type, 'triangle', 'a rounded fundamental carries the low end');
  assert.ok(sub.frequency.value < idlePitch, 'a subharmonic adds low-end weight');
  assert.equal(audio.gains.at(-1)?.gain.value, 0, 'boost whine is silent during normal driving');

  car.ctrl.throttle = 1;
  car.vel.z = 28;
  run(30);
  const loadedPitch = fundamental.frequency.value;
  assert.ok(loadedPitch > idlePitch * 2 && loadedPitch < 155, 'revving climbs without a moped pitch');
  assert.ok(lowpass.frequency.value > idleCutoff * 2, 'load opens the engine timbre');
  assert.ok(exhaust.frequency.value > idleExhaust * 2 && exhaust.frequency.value < 900);
  assert.ok(upper.frequency.value > loadedPitch, 'an upper harmonic retains engine bite');

  car.boosting = true;
  run(10);
  assert.ok(whine.frequency.value < 2200, 'boost avoids a piercing high whine');
  const boostGain = audio.gains.at(-1)?.gain.value;
  assert.ok(boostGain !== undefined && boostGain > 0 && boostGain < 0.015, 'boost stays behind the engine');
});

test('audio unlock, effects and engine pops never consume seeded presentation randomness', () => {
  function sequence(unlocked: boolean) {
    const audio = audioFixture();
    return withSeed(731, () => {
      // Construction and unlock can happen while a shared effect is running.
      const sound = createSoundEffects(() => audio.context, undefined, noSample);
      const samples = [Math.random()];
      if (unlocked) sound.init();
      sound.gun(null);
      sound.splat(null);
      sound.thud(null);
      sound.crack(null);
      sound.popper(null);
      sound.crash(null, 10);
      sound.clank(null);
      sound.nitro(null);
      sound.weld();
      sound.clang();
      sound.spray();
      sound.glug();
      samples.push(Math.random());
      const car = engineCar();
      car.ctrl.throttle = 1;
      car.vel.z = 28;
      for (let frame = 0; frame < 20; frame++) {
        audio.advance();
        sound.engine(car, true);
      }
      const beforeLift = audio.starts();
      car.ctrl.throttle = 0;
      audio.advance();
      sound.engine(car, true);
      if (unlocked) assert.ok(audio.starts() > beforeLift, 'lifting at high revs produces exhaust pops');
      samples.push(Math.random());
      return samples;
    });
  }
  const expected = withSeed(731, () => [Math.random(), Math.random(), Math.random()]);
  assert.deepEqual(sequence(false), expected);
  assert.deepEqual(sequence(true), expected);
});

test('marker recording loads only after unlock, falls back while pending and replaces synthesis when ready', async () => {
  const audio = audioFixture();
  const bytes = deferred<ArrayBuffer>();
  let requests = 0;
  const sound = createSoundEffects(
    () => audio.context,
    () => 0.5,
    async (url) => {
      requests++;
      assert.equal(url, 'assets/audio/paintball-marker-dry-fabianofa.wav');
      return bytes.promise;
    },
  );
  sound.gun(null);
  assert.equal(requests, 0);
  assert.equal(audio.sources.length, 0);
  sound.setVolume(0.3);
  sound.init();
  sound.init();
  assert.equal(requests, 1, 'repeated gestures share an in-flight request');
  assert.equal(audio.gains[0]?.gain.value, 0.3);
  sound.gun(null);
  assert.equal(audio.sources.length, 1, 'loading keeps a pneumatic noise fallback');
  assert.equal(audio.oscillators.length, 0, 'marker firing has no synthesized pitched tone');
  bytes.resolve(new ArrayBuffer(8));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const filtersBeforeShot = audio.filters.length;
  sound.gun(null);
  assert.equal(audio.sources.length, 2, 'one ready shot adds only one recording voice');
  assert.equal(audio.sources.at(-1)?.buffer, audio.decoded, 'ready shots play the actual recording');
  assert.equal(audio.sources.at(-1)?.playbackRate.value, 1);
  assert.equal(audio.gains.at(-1)?.gain.value, 0.7, 'the dry marker uses its reviewed mix level');
  assert.equal(audio.filters.length, filtersBeforeShot, 'ready shots do not also create fallback noise');
  assert.equal(audio.oscillators.length, 0);
  sound.setVolume(2);
  assert.equal(audio.gains[0]?.gain.value, 1);
  sound.setVolume(NaN);
  assert.equal(audio.gains[0]?.gain.value, 1);
  sound.setVolume(-1);
  assert.equal(audio.gains[0]?.gain.value, 0);
  sound.dispose();
  sound.dispose();
  assert.equal(audio.closed(), 1);
  assert.equal(audio.sources.at(-1)?.stops, 1);
  assert.equal(audio.sources.at(-1)?.disconnects, 1);
});

test('dry marker shots retain distance attenuation, nearest-listener choice and slight pitch variation', async () => {
  const audio = audioFixture();
  let variation = 0.5;
  const sound = createSoundEffects(
    () => audio.context,
    () => variation,
    async () => new ArrayBuffer(8),
  );
  sound.init();
  await new Promise<void>((resolve) => setImmediate(resolve));
  sound.listeners.push(new Vector3(0, 0, 0));
  variation = 0;
  sound.gun(new Vector3(0, 0, 0));
  const nearGain = audio.gains.at(-1)?.gain.value;
  assert.equal(nearGain, 0.7);
  assert.equal(audio.sources.at(-1)?.playbackRate.value, 0.96);

  variation = 1;
  const distantPosition = new Vector3(100, 0, 0);
  sound.gun(distantPosition);
  const distantGain = audio.gains.at(-1)?.gain.value;
  assert.ok(distantGain !== undefined && distantGain > 0 && distantGain < nearGain);
  assert.equal(audio.sources.at(-1)?.playbackRate.value, 1.04);

  sound.listeners.push(distantPosition);
  sound.gun(distantPosition);
  assert.equal(audio.gains.at(-1)?.gain.value, nearGain, 'the closest local listener owns attenuation');
  assert.equal(audio.sources.length, 3, 'three ready shots create three recording voices');
  assert.ok(audio.sources.every((source) => source.buffer === audio.decoded));
  assert.equal(audio.filters.length, 0, 'ready firing has no synthesized noise layer');
  assert.equal(audio.oscillators.length, 0, 'ready firing has no synthesized tone layer');
  sound.dispose();
});

test('sample failure remains playable through fallback and retries on another unlock', async () => {
  const audio = audioFixture();
  let requests = 0;
  const sound = createSoundEffects(
    () => audio.context,
    () => 0.5,
    async () => {
      if (++requests === 1) throw new Error('Offline');
      return new ArrayBuffer(8);
    },
  );
  sound.init();
  await new Promise<void>((resolve) => setImmediate(resolve));
  sound.gun(null);
  assert.notEqual(audio.sources.at(-1)?.buffer, audio.decoded);
  sound.init();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  sound.gun(null);
  assert.equal(audio.sources.at(-1)?.buffer, audio.decoded);
  sound.dispose();
});

test('a disposed or replaced sample owner cannot be revived by a late load', async () => {
  const first = audioFixture();
  const second = audioFixture();
  const bytes = deferred<ArrayBuffer>();
  let firstSignal: AbortSignal | undefined;
  let calls = 0;
  const sample = createAudioSample('marker.mp3', async (_url, signal) => {
    if (++calls === 1) {
      firstSignal = signal;
      return bytes.promise;
    }
    return new ArrayBuffer(8);
  });
  const oldLoad = sample.load({ ctx: first.context, master: first.context.createGain() });
  await sample.load({ ctx: second.context, master: second.context.createGain() });
  assert.equal(firstSignal?.aborted, true);
  bytes.resolve(new ArrayBuffer(8));
  await oldLoad;
  assert.equal(sample.play(0.5), true);
  assert.equal(first.sources.length, 0);
  assert.equal(second.sources.at(-1)?.buffer, second.decoded);
  sample.dispose();
  assert.equal(sample.play(0.5), false);
});

test('late decoding after disposal is ignored and invalid decoded recordings can retry', async () => {
  const audio = audioFixture();
  const decoded = deferred<AudioBuffer>();
  audio.setDecode(() => decoded.promise);
  const sample = createAudioSample('marker.mp3', async () => new ArrayBuffer(8));
  const runtime = { ctx: audio.context, master: audio.context.createGain() };
  const load = sample.load(runtime);
  await Promise.resolve();
  sample.dispose();
  decoded.resolve(audio.decoded);
  await load;
  assert.equal(sample.play(0.5), false);
  audio.setDecode(async () => ({ duration: Infinity }) as AudioBuffer);
  await sample.load(runtime);
  assert.equal(sample.play(0.5), false);
  audio.setDecode(async () => audio.decoded);
  await sample.load(runtime);
  assert.equal(sample.play(0.5), true);
  sample.dispose();
});

test('sample polyphony is bounded and completion, failed starts and disposal clean each voice once', async () => {
  const audio = audioFixture();
  const sample = createAudioSample('marker.mp3', async () => new ArrayBuffer(8), 2);
  await sample.load({ ctx: audio.context, master: audio.context.createGain() });
  assert.equal(sample.play(NaN), false);
  assert.equal(sample.play(0.5, NaN), false);
  assert.equal(sample.play(2, 9), true);
  assert.equal(audio.sources[0]?.playbackRate.value, 2);
  assert.equal(audio.gains.at(-1)?.gain.value, 1);
  sample.play(0.5);
  sample.play(0.5);
  assert.equal(audio.sources[0]?.stops, 1, 'the oldest voice is stopped at the cap');
  assert.equal(audio.sources[0]?.disconnects, 1);
  audio.sources[1]?.onended?.();
  assert.equal(audio.sources[1]?.disconnects, 1);
  sample.play(0.5);
  assert.equal(audio.sources[2]?.stops, 0, 'a completed voice frees capacity');
  audio.failNextStart();
  assert.equal(sample.play(0.5), false);
  assert.equal(audio.sources.at(-1)?.disconnects, 1, 'failed starts release their graph');
  sample.dispose();
  sample.dispose();
  for (const source of audio.sources) assert.equal(source.disconnects, 1);
  assert.throws(() => createAudioSample('marker.mp3', noSample, 0), /voice limit/);
});

test('required indexed attachments reject missing entries and retain explicit null or zero', () => {
  const entries: (number | null)[] = [0, null];
  assert.equal(requireValue(entries[0]), 0);
  assert.equal(requireValue(entries[1]), null);
  assert.throws(() => requireValue(entries[2]), /Missing required indexed value/);
});
