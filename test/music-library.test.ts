/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMusicLibrary,
  decodeMusicLibrary,
  decodeMusicPlaylist,
  musicTrackFromFile,
  validateMusicFile,
  MUSIC_LIMITS,
  MusicStorageError,
  type Playlist,
} from '../src/music-library.ts';

function playlist(id = 'mix', bytes = 4): Playlist {
  return {
    id,
    title: 'My driving mix',
    tracks: [
      { id: 'recording', title: 'Track', blob: new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }) },
    ],
  };
}
function errorCode(code: MusicStorageError['code']): (error: unknown) => boolean {
  return (error) => error instanceof MusicStorageError && error.code === code;
}

interface FakeRequest<T> {
  result: T;
  onsuccess: (() => void) | null;
}
/** Only the native transaction boundary is faked; validation and repository code run unchanged. */
class MemoryDatabase {
  rows = new Map<string, Playlist>();
  closed = false;
  upgrades = 0;
  failCommit = false;
  holdCommit = false;
  commits: (() => void)[] = [];
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  objectStoreNames = { contains: () => this.upgrades > 0 };
  createObjectStore(): void {
    this.upgrades++;
  }
  close(): void {
    this.closed = true;
  }
  transaction(): IDBTransaction {
    let pending = 0;
    let finished = false;
    const writes: (() => void)[] = [];
    const transaction = {
      error: null as DOMException | null,
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      oncomplete: null as (() => void) | null,
      abort: () => {
        if (finished) return;
        finished = true;
        queueMicrotask(() => transaction.onabort?.());
      },
      objectStore: () => store,
    };
    const complete = () => {
      if (finished || pending) return;
      const commit = () => {
        if (finished || pending) return;
        finished = true;
        if (this.failCommit) {
          transaction.error = new DOMException('Device quota exceeded', 'QuotaExceededError');
          transaction.onerror?.();
          transaction.onabort?.();
          return;
        }
        for (const write of writes) write();
        transaction.oncomplete?.();
      };
      if (this.holdCommit) this.commits.push(commit);
      else queueMicrotask(commit);
    };
    const request = <T>(read: () => T): FakeRequest<T> => {
      pending++;
      const result = { result: undefined as T, onsuccess: null as (() => void) | null };
      queueMicrotask(() => {
        if (finished) return;
        result.result = read();
        result.onsuccess?.();
        pending--;
        complete();
      });
      return result;
    };
    const store = {
      getAll: () => request(() => [...this.rows.values()]),
      put: (entry: Playlist) => {
        writes.push(() => this.rows.set(entry.id, entry));
        return request(() => entry.id);
      },
      delete: (id: string) => {
        writes.push(() => this.rows.delete(id));
        return request(() => undefined);
      },
    };
    return transaction as unknown as IDBTransaction;
  }
}
function factoryFor(db: MemoryDatabase, blocked = false): IDBFactory {
  return {
    open: () => {
      const request = {
        result: db,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (blocked) request.onblocked?.();
        else request.onupgradeneeded?.();
        // A blocked native open may still succeed later; the rejected owner must close it.
        queueMicrotask(() => request.onsuccess?.());
      });
      return request;
    },
  } as unknown as IDBFactory;
}

test('uploaded recordings have stable content IDs across filenames and explicit imports preserve IDs', async () => {
  const a = await musicTrackFromFile(new File(['music'], 'Morning.mp3', { type: 'audio/mpeg' }));
  const b = await musicTrackFromFile(new File(['music'], 'Evening.ogg', { type: 'audio/ogg' }));
  const c = await musicTrackFromFile(new File(['different'], 'Morning.mp3', { type: 'audio/mpeg' }));
  assert.match(a.id, /^[a-f0-9]{64}$/);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.equal(a.title, 'Morning');
  assert.equal(await a.blob.text(), 'music');
  const imported = await musicTrackFromFile(new File(['music'], 'Old.mp3'), 'old-recording');
  assert.equal(imported.id, 'old-recording');
  assert.equal(imported.blob.type, 'audio/mpeg');
});

test('upload validation rejects empty, oversized and nonaudio files before reading their data', () => {
  assert.equal(validateMusicFile({ name: 'recording.WAV', type: '', size: 9 }), 'audio/wav');
  assert.equal(
    validateMusicFile({ name: 'recording.flac', type: 'application/octet-stream', size: 9 }),
    'audio/flac',
  );
  assert.throws(
    () => validateMusicFile({ name: 'empty.mp3', type: 'audio/mpeg', size: 0 }),
    errorCode('invalid'),
  );
  assert.throws(
    () => validateMusicFile({ name: 'big.mp3', type: 'audio/mpeg', size: MUSIC_LIMITS.trackBytes + 1 }),
    errorCode('limit'),
  );
  assert.throws(
    () => validateMusicFile({ name: 'pretend.mp3', type: 'text/html', size: 9 }),
    errorCode('invalid'),
  );
  assert.throws(() => validateMusicFile({ name: 'text.txt', type: '', size: 9 }), errorCode('invalid'));
});

test('saved playlist decoding rebuilds bounded fields and requires real audio Blobs', () => {
  const original = playlist();
  const copy = decodeMusicPlaylist({ ...original, title: '  My mix  ', extra: 'discard me' });
  assert.equal(copy.title, 'My mix');
  assert.deepEqual(Object.keys(copy), ['id', 'title', 'tracks']);
  assert.notEqual(copy, original);
  assert.notEqual(copy.tracks, original.tracks);
  assert.throws(
    () => decodeMusicPlaylist({ ...original, tracks: [{ id: 'url', title: 'URL', blob: 'blob:temporary' }] }),
    errorCode('invalid'),
  );
  assert.throws(() => decodeMusicPlaylist({ ...original, title: 'x'.repeat(101) }), errorCode('invalid'));
  assert.throws(
    () => decodeMusicPlaylist({ ...original, tracks: [...original.tracks, ...original.tracks] }),
    errorCode('invalid'),
  );
  assert.throws(
    () =>
      decodeMusicPlaylist({
        ...original,
        tracks: Array.from({ length: 41 }, (_, i) => ({ ...original.tracks[0], id: String(i) })),
      }),
    errorCode('limit'),
  );
});

test('library decoding rejects duplicate IDs, excessive playlist counts and total stored bytes', () => {
  assert.throws(() => decodeMusicLibrary([playlist(), playlist()]), errorCode('invalid'));
  assert.throws(
    () =>
      decodeMusicLibrary(Array.from({ length: 21 }, (_, i) => ({ id: String(i), title: 'Mix', tracks: [] }))),
    errorCode('limit'),
  );
  const blob = new Blob([new Uint8Array(MUSIC_LIMITS.trackBytes)], { type: 'audio/ogg' });
  const tracks = Array.from({ length: 11 }, (_, i) => ({ id: String(i), title: 'Track', blob }));
  assert.throws(() => decodeMusicLibrary([{ id: 'large', title: 'Large mix', tracks }]), errorCode('limit'));
});

test('repository upgrades once, persists actual Blobs, replaces playlists and removes them', async () => {
  const db = new MemoryDatabase();
  const library = createMusicLibrary(factoryFor(db));
  await library.save(playlist());
  assert.equal(db.upgrades, 1);
  const saved = await library.list();
  assert.equal(saved.length, 1);
  assert.equal(await saved[0]?.tracks[0]?.blob.text(), '\0\0\0\0');
  await library.save({ ...playlist(), title: 'Renamed' });
  assert.equal((await library.list())[0]?.title, 'Renamed');
  assert.equal(db.rows.size, 1);
  await library.remove('mix');
  assert.deepEqual(await library.list(), []);
  library.close();
  library.close();
  assert.equal(db.closed, true);
  await assert.rejects(library.list(), errorCode('closed'));
});

test('a failed commit rejects save without publishing uncommitted audio', async () => {
  const db = new MemoryDatabase();
  db.failCommit = true;
  const library = createMusicLibrary(factoryFor(db));
  await assert.rejects(library.save(playlist()), errorCode('failed'));
  assert.equal(db.rows.size, 0);
  library.close();
});

test('save does not report success before its transaction commits', async () => {
  const db = new MemoryDatabase();
  db.holdCommit = true;
  const library = createMusicLibrary(factoryFor(db));
  let settled = false;
  const saving = library.save(playlist()).then(() => {
    settled = true;
  });
  // Flush the finite open/read/write microtask chain, without relying on a wall-clock delay.
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(db.rows.size, 0);
  assert.ok(db.commits.length > 0);
  for (const commit of db.commits) commit();
  await saving;
  assert.equal(db.rows.size, 1);
  library.close();
});

test('playlist limits are checked in the write transaction and rejection leaves existing rows intact', async () => {
  const db = new MemoryDatabase();
  for (let i = 0; i < MUSIC_LIMITS.playlists; i++)
    db.rows.set(String(i), { id: String(i), title: 'Mix', tracks: [] });
  const library = createMusicLibrary(factoryFor(db));
  await assert.rejects(library.save(playlist('extra')), errorCode('limit'));
  assert.equal(db.rows.size, MUSIC_LIMITS.playlists);
  await library.save(playlist('0'));
  assert.equal(db.rows.size, MUSIC_LIMITS.playlists);
  library.close();
});

test('blocked or unavailable storage reports an explicit error and closes a late connection', async () => {
  const db = new MemoryDatabase();
  const blocked = createMusicLibrary(factoryFor(db, true));
  await assert.rejects(blocked.list(), errorCode('blocked'));
  await Promise.resolve();
  assert.equal(db.closed, true);
  blocked.close();
  const unavailable = createMusicLibrary({
    open: () => {
      throw new DOMException('Storage is disabled', 'SecurityError');
    },
  } as unknown as IDBFactory);
  await assert.rejects(unavailable.list(), errorCode('unavailable'));
  unavailable.close();
});

test('closing while a connection opens rejects the operation and closes any later database', async () => {
  const db = new MemoryDatabase();
  const library = createMusicLibrary(factoryFor(db));
  const pending = library.list();
  library.close();
  await assert.rejects(pending, errorCode('closed'));
  await Promise.resolve();
  assert.equal(db.closed, true);
});
