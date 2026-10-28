export const SOUNDTRACK_URL = 'assets/audio/action-rock-instrumental-614585.mp3';
export const MAX_CLIP_BYTES = 16 * 1024 * 1024;
export const SOUNDTRACK_GAIN = 0.22;

export interface SoundtrackVoice {
  stop(): void;
}
export interface SoundtrackClip {
  startLoop(): SoundtrackVoice;
}
export interface SoundtrackContext {
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  decode(bytes: ArrayBuffer): Promise<SoundtrackClip>;
}
export interface SoundtrackAdapters {
  createContext?: () => SoundtrackContext;
  fetchClip?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
}

export async function fetchBoundedClip(
  url: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const response = await request(url, { signal, credentials: 'same-origin' });
  const declared = response.headers.get('content-length');
  if (!response.ok || !response.body || (declared !== null && Number(declared) > MAX_CLIP_BYTES)) {
    await response.body?.cancel();
    throw new Error('Soundtrack unavailable or oversized');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_CLIP_BYTES) throw new Error('Soundtrack exceeds byte limit');
      if (part.value.byteLength) chunks.push(part.value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output.buffer;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function createBrowserContext(): SoundtrackContext {
  const audio = new AudioContext();
  const gain = audio.createGain();
  gain.gain.value = SOUNDTRACK_GAIN;
  gain.connect(audio.destination);
  return {
    resume: () => audio.resume(),
    suspend: () => audio.suspend(),
    close: async () => {
      gain.disconnect();
      await audio.close();
    },
    decode: async (bytes) => {
      const buffer = await audio.decodeAudioData(bytes);
      return {
        startLoop: () => {
          const source = audio.createBufferSource();
          source.buffer = buffer;
          source.loop = true;
          source.connect(gain);
          source.start();
          return {
            stop: () => {
              try {
                source.stop();
              } finally {
                source.disconnect();
                source.buffer = null;
              }
            },
          };
        },
      };
    },
  };
}

/** Constructing/importing is inert. Call start from the game's Start click. */
export function createGameSoundtrack(adapters: SoundtrackAdapters = {}) {
  const createContext = adapters.createContext ?? createBrowserContext;
  const fetchClip = adapters.fetchClip ?? fetchBoundedClip;
  let context: SoundtrackContext | null = null;
  let voice: SoundtrackVoice | null = null;
  let pending: SoundtrackClip | null = null;
  let controller: AbortController | null = null;
  let loading: Promise<void> | null = null;
  let closing = Promise.resolve();
  let generation = 0;
  let playing = false;
  let destroyed = false;

  async function stop(): Promise<void> {
    playing = false;
    generation += 1;
    controller?.abort();
    controller = null;
    pending = null;
    loading = null;
    const old = context;
    const oldVoice = voice;
    context = null;
    voice = null;
    try {
      oldVoice?.stop();
    } finally {
      if (old) closing = Promise.all([closing, old.close()]).then(() => {});
      await closing;
    }
  }

  function resume(): Promise<void> {
    if (destroyed) return Promise.reject(new Error('Soundtrack was destroyed'));
    playing = true;
    try {
      context ??= createContext();
    } catch (error) {
      playing = false;
      return Promise.reject(error);
    }
    const owner = context;
    const ticket = generation;
    const current = () => context === owner && generation === ticket;
    const activate = () => {
      if (current() && playing && pending && !voice) {
        voice = pending.startLoop();
        pending = null;
      }
    };
    // This call happens inside the user gesture, before any asynchronous work.
    let activation: Promise<void>;
    try {
      activation = owner.resume();
    } catch (error) {
      activation = Promise.reject(error);
    }
    return activation
      .then(async () => {
        if (!current() || !playing) return;
        if (pending) {
          activate();
          return;
        }
        if (voice) return;
        if (loading) return loading;
        const abort = new AbortController();
        controller = abort;
        const load = (async () => {
          const bytes = await fetchClip(SOUNDTRACK_URL, abort.signal);
          if (!current()) return;
          if (!bytes.byteLength || bytes.byteLength > MAX_CLIP_BYTES)
            throw new Error('Invalid soundtrack size');
          const clip = await owner.decode(bytes);
          if (!current()) return;
          controller = null;
          pending = clip;
          activate();
        })();
        loading = load;
        try {
          await load;
        } finally {
          if (loading === load) loading = null;
        }
      })
      .catch(async (error: unknown) => {
        if (!current()) return; // A stopped fetch/decode completion cannot restart playback.
        await stop();
        throw error;
      });
  }

  return {
    start: resume,
    resume,
    pause: async () => {
      playing = false;
      await context?.suspend();
    },
    stop,
    destroy: async () => {
      destroyed = true;
      await stop();
    },
  };
}

// Game-owned singleton is inert until the explicit Start gesture.
export const gameSoundtrack = createGameSoundtrack();
