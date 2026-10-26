import { readRadioPlaylists, readMusicQueue, type RadioPlaylist, musicCredit } from './music-model.ts';
import type { Playlist } from './music-library.ts';
import { volume } from './music-settings.ts';
export interface RadioState {
  loading: boolean;
  playing: boolean;
  muted: boolean;
  volume: number;
  selected: string;
  playlists: RadioPlaylist[];
  trackId: string | null;
  error: string;
  localTracks: { id: string; title: string }[];
}
export type RadioCommand =
  | { action: 'play' | 'pause' | 'next' | 'previous' }
  | { action: 'mute'; value: boolean }
  | { action: 'volume'; value: number }
  | { action: 'playlist'; value: string }
  | { action: 'queue'; value: { title: string; tracks: string[] } }
  | { action: 'upload'; value: Playlist }
  | { action: 'deletePlaylist'; value: string };
export function readRadioState(value: unknown): RadioState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['playing'] !== 'boolean' ||
    typeof v['muted'] !== 'boolean' ||
    typeof v['selected'] !== 'string' ||
    v['selected'].length > 80 ||
    typeof v['volume'] !== 'number' ||
    !Number.isFinite(v['volume']) ||
    !Array.isArray(v['playlists']) ||
    v['playlists'].length > 60
  )
    return null;
  const playlists = [...readRadioPlaylists(v['playlists'])];
  const localTracks: { id: string; title: string }[] = [];
  if (Array.isArray(v['catalog']))
    for (const raw of v['catalog'].slice(0, 806)) {
      if (!raw || typeof raw !== 'object') continue;
      const t = raw as Record<string, unknown>;
      if (
        typeof t['id'] === 'string' &&
        /^[a-f0-9]{64}$/.test(t['id']) &&
        typeof t['title'] === 'string' &&
        t['title'].length <= 100 &&
        t['local'] === true
      )
        localTracks.push({ id: t['id'], title: t['title'] });
    }
  // Platform built-ins and the host's temporary queue are reviewed just like personal radio lists.
  for (const raw of v['playlists']) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const queue = readMusicQueue(p);
    if (
      queue &&
      typeof p['id'] === 'string' &&
      /^device-[a-zA-Z0-9-]{1,60}$/.test(p['id']) &&
      queue.tracks.every((id) => localTracks.some((t) => t.id === id))
    ) {
      playlists.push({ id: p['id'], ...queue });
      continue;
    }
    if (
      typeof p['id'] === 'string' &&
      ['random', 'all', 'focus', 'ambient', 'action', 'host'].includes(p['id']) &&
      typeof p['title'] === 'string' &&
      p['title'].length <= 100 &&
      Array.isArray(p['tracks']) &&
      p['tracks'].length <= 40 &&
      p['tracks'].every(
        (id: unknown) =>
          typeof id === 'string' && (!!musicCredit(id) || localTracks.some((t) => t.id === id)),
      )
    )
      playlists.push({ id: p['id'], title: p['title'], tracks: p['tracks'] as string[] });
  }
  const track = v['track'];
  const id = track && typeof track === 'object' ? (track as Record<string, unknown>)['id'] : null;
  return {
    loading: v['loading'] === true,
    playing: v['playing'],
    muted: v['muted'],
    volume: volume(v['volume'], 0.22),
    selected: v['selected'],
    playlists,
    trackId: typeof id === 'string' && (musicCredit(id) || localTracks.some((t) => t.id === id)) ? id : null,
    error: typeof v['error'] === 'string' ? v['error'].slice(0, 200) : '',
    localTracks,
  };
}
/** Opt-in port to the radio owner. The parent authenticates this iframe; the game never reads parent storage. */
export function connectRadio(win: Window, change: (state: RadioState) => void) {
  let origin: string;
  try {
    // Hub frames and site solo frames have a same-origin radio owner. Never give uploaded files to
    // an arbitrary embedding site's parent merely because it appears in document.referrer.
    origin = win.location.origin;
    if (origin === 'null') return null;
  } catch {
    return null;
  }
  const channel = new MessageChannel();
  let connected = false,
    closed = false;
  let sequence = 0;
  let tokens = 8,
    tokenAt = performance.now();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const outgoing = new Map<string, Record<string, unknown>>();
  function flush(): void {
    flushTimer = null;
    if (closed) return;
    const now = performance.now();
    tokens = Math.min(8, tokens + (now - tokenAt) * 0.02);
    tokenAt = now;
    while (tokens >= 1 && outgoing.size) {
      const entry = outgoing.entries().next().value;
      if (!entry) break;
      outgoing.delete(entry[0]);
      tokens--;
      channel.port1.postMessage(entry[1]);
    }
    if (outgoing.size) flushTimer = setTimeout(flush, 50);
  }
  function enqueue(command: RadioCommand, request?: string): void {
    const key =
      request ??
      (command.action === 'play' || command.action === 'pause'
        ? 'transport'
        : command.action === 'queue' || command.action === 'playlist'
          ? 'selection'
          : command.action);
    outgoing.set(key, { type: 'command', version: 1, ...command, ...(request ? { request } : {}) });
    if (flushTimer === null) flushTimer = setTimeout(flush, 0);
  }
  const requests = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    if (closed || !event.data || typeof event.data !== 'object') return;
    const msg = event.data as Record<string, unknown>;
    if (msg['version'] === 1 && msg['type'] === 'result' && typeof msg['request'] === 'string') {
      const request = requests.get(msg['request']);
      if (!request) return;
      requests.delete(msg['request']);
      clearTimeout(request.timer);
      if (msg['ok'] === true) request.resolve();
      else
        request.reject(
          new Error(
            typeof msg['error'] === 'string'
              ? msg['error'].slice(0, 200)
              : 'Radio could not save that playlist.',
          ),
        );
      return;
    }
    if (msg['type'] !== 'state' || msg['version'] !== 1) return;
    const state = readRadioState(msg['state']);
    if (state) {
      connected = true;
      change(state);
    }
  };
  channel.port1.start();
  win.parent.postMessage(
    {
      type: 'zirbel:radio-connect',
      version: 1,
      secret: new URLSearchParams(win.location.hash.slice(1)).get('zs'),
    },
    origin,
    [channel.port2],
  );
  return {
    connected: () => connected,
    send(command: RadioCommand): void {
      if (!closed && connected) enqueue(command);
    },
    request(command: RadioCommand): Promise<void> {
      if (closed || !connected) return Promise.reject(new Error('Zirbel Radio is not connected.'));
      const request = String(++sequence);
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          requests.delete(request);
          reject(new Error('Radio did not finish saving. Try again.'));
        }, 60_000);
        requests.set(request, { resolve, reject, timer });
        enqueue(command, request);
      });
    },
    destroy(): void {
      closed = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
      outgoing.clear();
      if (connected) channel.port1.postMessage({ type: 'disconnect', version: 1 });
      for (const request of requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Radio connection closed.'));
      }
      requests.clear();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
