/** A local recording owns its load and voices; late decoding cannot revive a disposed audio owner. */
export type AudioSampleLoader = (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
interface SampleRuntime {
  ctx: AudioContext;
  master: GainNode;
}

export async function fetchAudioSample(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error('Audio sample is unavailable');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) throw new Error('Invalid audio sample size');
  return bytes;
}

export function createAudioSample(url: string, loader: AudioSampleLoader = fetchAudioSample, limit = 12) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid audio voice limit');
  let owner: SampleRuntime | null = null;
  let buffer: AudioBuffer | null = null;
  let pending: {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    promise: Promise<void>;
  } | null = null;
  const voices = new Set<() => void>();

  function dispose() {
    owner = null;
    buffer = null;
    if (pending) {
      pending.controller.abort();
      clearTimeout(pending.timer);
      pending = null;
    }
    for (const stop of voices) stop();
  }

  function load(runtime: SampleRuntime): Promise<void> {
    if (owner !== runtime) {
      dispose();
      owner = runtime;
    }
    if (buffer) return Promise.resolve();
    if (pending?.controller.signal.aborted) {
      clearTimeout(pending.timer);
      pending = null;
    }
    if (pending) return pending.promise;
    const controller = new AbortController();
    const request = {
      controller,
      timer: setTimeout(() => controller.abort(), 15000),
      promise: Promise.resolve(),
    };
    pending = request;
    const active = () => owner === runtime && pending === request && !controller.signal.aborted;
    request.promise = (async () => {
      try {
        const bytes = await loader(url, controller.signal);
        if (!active()) return;
        const decoded = await runtime.ctx.decodeAudioData(bytes);
        if (active() && Number.isFinite(decoded.duration) && decoded.duration > 0 && decoded.duration <= 5)
          buffer = decoded;
      } catch {
        // The pneumatic fallback remains usable; the next unlock gesture can retry a failed load.
      } finally {
        clearTimeout(request.timer);
        if (pending === request) pending = null;
      }
    })();
    return request.promise;
  }

  function play(volume: number, rate = 1): boolean {
    if (!owner || !buffer || !Number.isFinite(volume) || !Number.isFinite(rate)) return false;
    const { ctx, master } = owner;
    let source: AudioBufferSourceNode | null = null;
    let gain: GainNode | null = null;
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      voices.delete(stop);
      if (source) source.onended = null;
      source?.disconnect();
      gain?.disconnect();
    };
    const stop = () => {
      if (stopped) return;
      try {
        source?.stop();
      } catch {
        // A source that failed to start still owns connections which need releasing.
      }
      cleanup();
    };
    try {
      source = ctx.createBufferSource();
      gain = ctx.createGain();
      source.buffer = buffer;
      source.playbackRate.value = Math.max(0.5, Math.min(2, rate));
      gain.gain.value = Math.max(0, Math.min(1, volume));
      source.connect(gain).connect(master);
      source.onended = cleanup;
      while (voices.size >= limit) voices.values().next().value?.();
      voices.add(stop);
      source.start();
      return true;
    } catch {
      stop();
      return false;
    }
  }
  return { load, play, dispose };
}
