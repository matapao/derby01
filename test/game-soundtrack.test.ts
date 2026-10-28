import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGameSoundtrack,
  fetchBoundedClip,
  MAX_CLIP_BYTES,
  SOUNDTRACK_URL,
  type SoundtrackClip,
  type SoundtrackContext,
} from '../src/game-soundtrack.ts';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function audio(
  overrides: {
    resume?: () => Promise<void>;
    decode?: (bytes: ArrayBuffer) => Promise<SoundtrackClip>;
    close?: () => Promise<void>;
  } = {},
) {
  const count = { resumes: 0, suspends: 0, decodes: 0, loops: 0, stops: 0, closes: 0 };
  const clip: SoundtrackClip = {
    startLoop: () => {
      count.loops += 1;
      return {
        stop: () => {
          count.stops += 1;
        },
      };
    },
  };
  const context: SoundtrackContext = {
    resume: () => {
      count.resumes += 1;
      return overrides.resume?.() ?? Promise.resolve();
    },
    suspend: async () => {
      count.suspends += 1;
    },
    close: () => {
      count.closes += 1;
      return overrides.close?.() ?? Promise.resolve();
    },
    decode: (bytes) => {
      count.decodes += 1;
      return overrides.decode?.(bytes) ?? Promise.resolve(clip);
    },
  };
  return { context, clip, count };
}
const bytes = () => new Uint8Array([1, 2, 3]).buffer;

test('construction is inert; Start resumes synchronously and concurrent starts share one load', async () => {
  const ready = deferred<void>();
  const a = audio({ resume: () => ready.promise });
  let creates = 0;
  let fetches = 0;
  const player = createGameSoundtrack({
    createContext: () => {
      creates += 1;
      return a.context;
    },
    fetchClip: async (url) => {
      assert.equal(url, SOUNDTRACK_URL);
      fetches += 1;
      return bytes();
    },
  });
  assert.equal(creates, 0);
  assert.equal(fetches, 0);
  const first = player.start();
  assert.equal(creates, 1);
  assert.equal(a.count.resumes, 1);
  assert.equal(fetches, 0, 'resume is called in the gesture before asynchronous fetch');
  const duplicate = player.start();
  ready.resolve();
  await Promise.all([first, duplicate]);
  assert.equal(fetches, 1);
  assert.equal(a.count.decodes, 1);
  assert.equal(a.count.loops, 1);
  await player.destroy();
});

test('pause/resume preserves the same looping source and decoded buffer', async () => {
  const a = audio();
  let fetches = 0;
  const player = createGameSoundtrack({
    createContext: () => a.context,
    fetchClip: async () => {
      fetches += 1;
      return bytes();
    },
  });
  await player.start();
  for (let round = 0; round < 3; round += 1) {
    await player.pause();
    await player.resume();
  }
  assert.equal(fetches, 1);
  assert.equal(a.count.decodes, 1);
  assert.equal(a.count.loops, 1);
  assert.equal(a.count.stops, 0);
  assert.equal(a.count.suspends, 3);
  await player.stop();
  assert.equal(a.count.stops, 1);
  assert.equal(a.count.closes, 1);
});

test('pause during decode holds the clip without starting it until resume', async () => {
  const decoded = deferred<SoundtrackClip>();
  const entered = deferred<void>();
  const a = audio({
    decode: () => {
      entered.resolve();
      return decoded.promise;
    },
  });
  const player = createGameSoundtrack({ createContext: () => a.context, fetchClip: async () => bytes() });
  const started = player.start();
  await entered.promise;
  await player.pause();
  decoded.resolve(a.clip);
  await started;
  assert.equal(a.count.loops, 0);
  await player.resume();
  assert.equal(a.count.loops, 1);
  assert.equal(a.count.decodes, 1);
  await player.destroy();
});

test('stop aborts fetch; even an adapter ignoring abort cannot start decode or playback later', async () => {
  const fetched = deferred<ArrayBuffer>();
  const entered = deferred<void>();
  const signals: AbortSignal[] = [];
  const first = audio();
  const second = audio();
  let creates = 0;
  let fetches = 0;
  const player = createGameSoundtrack({
    createContext: () => (++creates === 1 ? first.context : second.context),
    fetchClip: (_url, signal) => {
      signals.push(signal);
      fetches += 1;
      entered.resolve();
      return fetches === 1 ? fetched.promise : Promise.resolve(bytes());
    },
  });
  const started = player.start();
  await entered.promise;
  await player.stop();
  assert.equal(signals[0]?.aborted, true);
  fetched.resolve(bytes());
  await started;
  assert.equal(first.count.decodes, 0);
  assert.equal(first.count.loops, 0);
  assert.equal(first.count.closes, 1);
  await player.start();
  assert.equal(fetches, 2, 'a stopped session is not a library cache');
  assert.equal(second.count.loops, 1);
  await player.destroy();
});

test('destroy while native decode is pending ignores its completion and is terminal', async () => {
  const decoded = deferred<SoundtrackClip>();
  const entered = deferred<void>();
  const a = audio({
    decode: () => {
      entered.resolve();
      return decoded.promise;
    },
  });
  const player = createGameSoundtrack({ createContext: () => a.context, fetchClip: async () => bytes() });
  const started = player.start();
  await entered.promise;
  await player.destroy();
  decoded.resolve(a.clip);
  await started;
  assert.equal(a.count.loops, 0);
  assert.equal(a.count.closes, 1);
  await assert.rejects(player.start(), /destroyed/);
  await assert.rejects(player.resume(), /destroyed/);
});

test('repeated cleanup waits for the same context close and stops the voice once', async () => {
  const closed = deferred<void>();
  const a = audio({ close: () => closed.promise });
  const player = createGameSoundtrack({ createContext: () => a.context, fetchClip: async () => bytes() });
  await player.start();
  let completed = false;
  const first = player.stop().then(() => {
    completed = true;
  });
  const second = player.destroy();
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(a.count.stops, 1);
  assert.equal(a.count.closes, 1);
  closed.resolve();
  await Promise.all([first, second]);
  assert.equal(completed, true);
});

test('fetch, resume and invalid-size failures reject and close without starting a source', async () => {
  for (const failure of ['fetch', 'resume', 'empty', 'oversize']) {
    const a = audio(
      failure === 'resume'
        ? {
            resume: async () => {
              throw new Error('resume denied');
            },
          }
        : {},
    );
    const player = createGameSoundtrack({
      createContext: () => a.context,
      fetchClip: async () => {
        if (failure === 'fetch') throw new Error('fetch failed');
        return new ArrayBuffer(failure === 'oversize' ? MAX_CLIP_BYTES + 1 : 0);
      },
    });
    await assert.rejects(player.start());
    assert.equal(a.count.decodes, 0);
    assert.equal(a.count.loops, 0);
    assert.equal(a.count.closes, 1);
  }
});

test('bounded fetch rejects declared and streamed oversize, cancelling the reader', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!declared) {
          controller.enqueue(new Uint8Array(MAX_CLIP_BYTES));
          controller.enqueue(new Uint8Array([1]));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: declared ? { 'content-length': String(MAX_CLIP_BYTES + 1) } : {},
    });
    await assert.rejects(
      fetchBoundedClip(SOUNDTRACK_URL, new AbortController().signal, async () => response),
      /oversized|limit/,
    );
    assert.equal(cancelled, true);
  }
  const result = await fetchBoundedClip(
    SOUNDTRACK_URL,
    new AbortController().signal,
    async () => new Response(new Uint8Array([7, 8])),
  );
  assert.deepEqual(new Uint8Array(result), new Uint8Array([7, 8]));
});
