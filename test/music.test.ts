import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SOUND, readSoundSettings, soundLevels, loadSoundSettings } from '../src/music-settings.ts';
import {
  readMusicQueue,
  readRadioPlaylists,
  randomMusicQueue,
  DEFAULT_QUEUE,
  isRandomMusicQueue,
  trackUrl,
  recordingCredit,
} from '../src/music-model.ts';
import { readRadioState, connectRadio } from '../src/music-bridge.ts';
import { createMusicPlayer, type MusicMedia } from '../src/music-player.ts';
import { hashMusic } from '../src/music-hash.ts';

class Media extends EventTarget implements MusicMedia {
  src = '';
  volume = 0;
  paused = true;
  plays = 0;
  pauses = 0;
  fail = false;
  async play() {
    this.plays++;
    if (this.fail) throw new DOMException('gesture', 'NotAllowedError');
    this.paused = false;
  }
  pause() {
    this.pauses++;
    this.paused = true;
  }
  load() {}
  removeAttribute() {
    this.src = '';
  }
}
test('ordinary HTTP LAN uploads use the reviewed hash owner without requiring Web Crypto', async () => {
  const bytes = new TextEncoder().encode('abc').buffer;
  assert.equal(
    await hashMusic(bytes, null),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(await hashMusic(bytes), await hashMusic(bytes, null));
});
test('audio defaults preserve the designed balance and modes never overwrite remembered sliders', () => {
  assert.deepEqual(soundLevels({ ...DEFAULT_SOUND }), { effects: 0.55, music: 0.22 });
  for (const [mode, expected] of [
    ['effects', { effects: 0.55, music: 0 }],
    ['music', { effects: 0, music: 0.22 }],
    ['muted', { effects: 0, music: 0 }],
  ] as const)
    assert.deepEqual(soundLevels({ ...DEFAULT_SOUND, mode }), expected);
  assert.equal(DEFAULT_SOUND.music, 0.22);
  assert.deepEqual(
    readSoundSettings({ effects: Infinity, music: -1, mode: '__proto__', playlist: 'javascript:bad' }),
    { ...DEFAULT_SOUND, mode: 'muted', music: 0 },
  );
  assert.deepEqual(
    loadSoundSettings({
      getItem() {
        throw Error('blocked');
      },
    }),
    DEFAULT_SOUND,
  );
});
test('radio queues accept reviewed tracks or content hashes, rejecting unknown sources and excessive payloads', () => {
  assert.deepEqual(readMusicQueue({ title: 'My room', tracks: ['lofi-hip-hop', 'a'.repeat(64)] }), {
    title: 'My room',
    tracks: ['lofi-hip-hop', 'a'.repeat(64)],
  });
  for (const tracks of [
    ['https://bad.test/file.mp3'],
    ['__proto__'],
    Array(41).fill('lofi-hip-hop'),
    ['today'],
  ])
    assert.equal(readMusicQueue({ title: 'Room', tracks }), null);
  assert.equal(readMusicQueue({ title: 'x'.repeat(101), tracks: ['today'] }), null);
});
test('Zirbel saved playlist decoder bounds, validates and deduplicates compatible lists', () => {
  const good = { id: 'personal-drive', title: 'Drive', tracks: ['simple-action-beat', 'covert-action'] };
  assert.deepEqual(
    readRadioPlaylists({
      playlists: [good, good, { ...good, id: 'evil', tracks: ['https://evil.test/a'] }, null],
    }),
    [good],
  );
  assert.deepEqual(readRadioPlaylists({ playlists: [{ ...good, tracks: ['unknown'] }] }), []);
});
test('radio state accepts bounded reviewed catalogues and never trusts arbitrary track metadata', () => {
  assert.equal(
    readRadioState({ playing: true, muted: false, volume: Infinity, selected: 'today', playlists: [] }),
    null,
  );
  assert.equal(
    readRadioState({
      playing: true,
      muted: false,
      volume: 0.2,
      selected: 'today',
      playlists: Array(61).fill({}),
    }),
    null,
  );
  const state = readRadioState({
    playing: true,
    muted: false,
    volume: 0.2,
    selected: 'today',
    playlists: [{ id: 'random', title: 'Random music', tracks: ['lofi-hip-hop'] }],
    track: { id: 'javascript:evil' },
    error: 'x'.repeat(500),
  });
  assert.equal(state?.trackId, null);
  assert.equal(state?.error.length, 200);
  assert.equal(state?.playlists.length, 1);
});
test('one music voice advances the queue, wraps, applies independent gain, and revokes device URLs', async () => {
  const media = new Media(),
    revoked: string[] = [],
    messages: string[] = [];
  const player = createMusicPlayer(
    media,
    (m) => messages.push(m),
    (u) => revoked.push(u),
  );
  player.setQueue([
    { id: 'one', title: 'One', url: 'blob:one', owned: true },
    { id: 'two', title: 'Two', url: 'blob:two', owned: true },
  ]);
  assert.equal(media.plays, 0);
  player.setLevel(0.22);
  await Promise.resolve();
  assert.equal(media.volume, 0.22);
  assert.equal(media.src, 'blob:one');
  media.dispatchEvent(new Event('ended'));
  await Promise.resolve();
  assert.equal(media.src, 'blob:two');
  player.skip();
  await Promise.resolve();
  assert.equal(media.src, 'blob:one');
  player.setLevel(0);
  assert.equal(media.paused, true);
  player.destroy();
  player.destroy();
  assert.deepEqual(revoked, ['blob:one', 'blob:two']);
  assert.equal(media.src, '');
  const calls = media.plays;
  media.dispatchEvent(new Event('ended'));
  assert.equal(media.plays, calls);
});
test('late playback completion cannot restart music after muting or disposal', async () => {
  const media = new Media();
  let complete: () => void = () => {};
  media.play = () =>
    new Promise<void>((resolve) => {
      complete = () => {
        media.paused = false;
        resolve();
      };
    });
  const player = createMusicPlayer(media, () => {});
  player.setQueue([{ id: 'one', title: 'One', url: 'one' }]);
  player.setLevel(0.2);
  player.setLevel(0);
  complete();
  await Promise.resolve();
  assert.equal(media.paused, true);
  player.setLevel(0.2);
  player.destroy();
  complete();
  await Promise.resolve();
  assert.equal(media.paused, true);
});
test('blocked playback stays retryable; failed queues terminate rather than loop forever', async () => {
  const media = new Media(),
    messages: string[] = [];
  media.fail = true;
  const player = createMusicPlayer(media, (m) => messages.push(m));
  player.setQueue([
    { id: 'one', title: 'One', url: 'one' },
    { id: 'two', title: 'Two', url: 'two' },
  ]);
  player.setLevel(0.2);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(messages.includes('Press Play to start music.'));
  media.fail = false;
  await player.play();
  assert.equal(media.paused, false);
  media.dispatchEvent(new Event('error'));
  media.dispatchEvent(new Event('error'));
  assert.equal(media.paused, true);
  assert.match(messages.at(-1) ?? '', /unavailable/);
  player.destroy();
});
test('a repeating queue with duplicate song IDs stops when every recording is unavailable', () => {
  const media = new Media(),
    messages: string[] = [];
  const player = createMusicPlayer(media, (message) => messages.push(message));
  player.setQueue([
    { id: 'one', title: 'One', url: 'one' },
    { id: 'one', title: 'One again', url: 'one' },
  ]);
  player.setLevel(0.2);
  media.dispatchEvent(new Event('error'));
  assert.match(messages.at(-1) ?? '', /unavailable/);
  assert.equal(media.paused, true);
  player.destroy();
});

test('radio capability uses the exact parent origin and secret, coalesces slider updates, and acknowledges saves', async () => {
  let remote: MessagePort | null = null;
  let hello: unknown = null,
    target = '';
  const parent = {
    postMessage(message: unknown, origin: string, ports: Transferable[]) {
      hello = message;
      target = origin;
      remote = ports[0] as MessagePort;
    },
  };
  const win = {
    parent,
    document: { referrer: 'https://untrusted-embed.test/' },
    location: { origin: 'https://hub.test', hash: '#zs=private-capability' },
  } as unknown as Window;
  const states: string[] = [];
  let ready: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const bridge = connectRadio(win, (state) => {
    states.push(state.selected);
    ready();
  });
  assert.ok(bridge);
  const port = remote as unknown as MessagePort;
  try {
    assert.equal(target, 'https://hub.test');
    assert.deepEqual(hello, { type: 'zirbel:radio-connect', version: 1, secret: 'private-capability' });
    const commands: Record<string, unknown>[] = [];
    port.onmessage = (event: MessageEvent<unknown>) => {
      const command = event.data as Record<string, unknown>;
      commands.push(command);
      if (command['request'])
        port.postMessage({ type: 'result', version: 1, request: command['request'], ok: true });
    };
    port.start();
    port.postMessage({
      type: 'state',
      version: 1,
      state: { playing: true, muted: false, volume: 0.22, selected: 'today', playlists: [] },
    });
    await connected;
    assert.deepEqual(states, ['today']);
    for (let i = 0; i < 100; i++) bridge.send({ action: 'volume', value: i / 100 });
    await bridge.request({ action: 'deletePlaylist', value: 'device-test' });
    assert.equal(commands.filter((c) => c['action'] === 'volume').length, 1);
    assert.equal(commands[0]?.['value'], 0.99);
  } finally {
    bridge.destroy();
    bridge.destroy();
    port.close();
  }
});

test('random defaults use only reviewed CC0 tracks and never resolve removed recordings', () => {
  const original = [...DEFAULT_QUEUE.tracks];
  const first = randomMusicQueue(() => 0);
  const second = randomMusicQueue(() => 0.99);
  assert.equal(first.tracks.length, 5);
  assert.deepEqual([...first.tracks].sort(), [...original].sort());
  assert.notDeepEqual(first.tracks, second.tracks);
  assert.deepEqual(DEFAULT_QUEUE.tracks, original);
  for (const id of first.tracks) assert.equal(recordingCredit(id)?.license, 'CC0-1.0');
  assert.equal(trackUrl('today'), undefined);
  assert.equal(recordingCredit('today'), undefined);
  assert.equal(
    readMusicQueue({
      title: 'Removed',
      tracks: ['9e293cbd46ffdfe96b527706f2c8ddc8dfbab91b19707aeb84f58255177363a6'],
    }),
    null,
  );
  assert.deepEqual(readMusicQueue({ title: 'Silence', tracks: [] }), { title: 'Silence', tracks: [] });
  assert.deepEqual(soundLevels(readSoundSettings({ mode: 'unsupported' })), { effects: 0, music: 0 });
});

test('a personal queue title cannot replace its selected recordings with the random catalogue', () => {
  assert.equal(isRandomMusicQueue({ title: 'Random music', tracks: ['simple-action-beat'] }), false);
  assert.equal(isRandomMusicQueue({ title: 'Random music', tracks: ['a'.repeat(64)] }), false);
  assert.equal(isRandomMusicQueue(randomMusicQueue(() => 0)), true);
});
