/** Device-local audio storage. Persist recordings, never temporary object URLs. */
import { hashMusic } from './music-hash.ts';
export interface Track {
  id: string;
  title: string;
  blob: Blob;
}
export interface Playlist {
  id: string;
  title: string;
  tracks: Track[];
}
export interface MusicLibrary {
  list(): Promise<Playlist[]>;
  save(playlist: Playlist): Promise<void>;
  remove(id: string): Promise<void>;
  close(): void;
}
export const MUSIC_LIMITS = {
  playlists: 20,
  tracksPerPlaylist: 40,
  trackBytes: 20 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024,
  titleLength: 100,
  idLength: 80,
} as const;
export type MusicStorageCode = 'unavailable' | 'blocked' | 'closed' | 'failed' | 'invalid' | 'limit';
export class MusicStorageError extends Error {
  readonly code: MusicStorageCode;
  constructor(code: MusicStorageCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MusicStorageError';
    this.code = code;
  }
}
const EXTENSIONS: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  webm: 'audio/webm',
};
function audioMime(type: string): boolean {
  return /^audio\/[a-z0-9.+-]+$/i.test(type) || type === 'application/ogg';
}
function boundedText(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value))
    throw new MusicStorageError('invalid', `Invalid music ${label}.`);
  return value.trim();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function checkBlob(blob: unknown): asserts blob is Blob {
  if (!(blob instanceof Blob) || !audioMime(blob.type) || blob.size <= 0)
    throw new MusicStorageError('invalid', 'Choose a nonempty audio recording.');
  if (blob.size > MUSIC_LIMITS.trackBytes)
    throw new MusicStorageError('limit', 'Each recording must be 20 MiB or smaller.');
}
export function validateMusicFile(file: Pick<File, 'name' | 'type' | 'size'>): string {
  if (!Number.isSafeInteger(file.size) || file.size <= 0)
    throw new MusicStorageError('invalid', 'Choose a nonempty audio recording.');
  if (file.size > MUSIC_LIMITS.trackBytes)
    throw new MusicStorageError('limit', 'Each recording must be 20 MiB or smaller.');
  const mime = file.type.toLowerCase();
  if (audioMime(mime)) return mime;
  const extension = file.name.toLowerCase().split('.').at(-1) ?? '';
  if ((mime === '' || mime === 'application/octet-stream') && Object.hasOwn(EXTENSIONS, extension)) {
    const inferred = EXTENSIONS[extension];
    if (inferred) return inferred;
  }
  throw new MusicStorageError('invalid', 'Choose an audio file such as MP3, Ogg, WAV, M4A or FLAC.');
}
/** A content hash lets another screen match the same recording without sending its audio. */
export async function musicTrackFromFile(file: File, id?: string): Promise<Track> {
  const mime = validateMusicFile(file);
  let trackId = id;
  if (trackId === undefined) {
    try {
      trackId = await hashMusic(await file.arrayBuffer());
    } catch (cause) {
      throw new MusicStorageError('unavailable', 'This browser cannot identify local recordings.', cause);
    }
  }
  const title =
    file.name
      .replace(/\.[^.]+$/, '')
      .trim()
      .slice(0, MUSIC_LIMITS.titleLength) || 'Recording';
  return {
    id: boundedText(trackId, MUSIC_LIMITS.idLength, 'track ID'),
    title: boundedText(title, MUSIC_LIMITS.titleLength, 'title'),
    blob: file.slice(0, file.size, mime),
  };
}
export function decodeMusicPlaylist(value: unknown): Playlist {
  if (!record(value)) throw new MusicStorageError('invalid', 'Invalid saved playlist.');
  const tracks = value['tracks'];
  if (!Array.isArray(tracks)) throw new MusicStorageError('invalid', 'Invalid playlist recordings.');
  if (tracks.length > MUSIC_LIMITS.tracksPerPlaylist)
    throw new MusicStorageError('limit', 'A playlist can contain at most 40 recordings.');
  const seen = new Set<string>();
  const decoded = tracks.map((track: unknown): Track => {
    if (!record(track)) throw new MusicStorageError('invalid', 'Invalid saved recording.');
    const id = boundedText(track['id'], MUSIC_LIMITS.idLength, 'track ID');
    if (seen.has(id)) throw new MusicStorageError('invalid', 'A recording occurs twice in the playlist.');
    seen.add(id);
    const blob = track['blob'];
    checkBlob(blob);
    return { id, title: boundedText(track['title'], MUSIC_LIMITS.titleLength, 'title'), blob };
  });
  return {
    id: boundedText(value['id'], MUSIC_LIMITS.idLength, 'playlist ID'),
    title: boundedText(value['title'], MUSIC_LIMITS.titleLength, 'title'),
    tracks: decoded,
  };
}
export function decodeMusicLibrary(value: unknown): Playlist[] {
  if (!Array.isArray(value)) throw new MusicStorageError('invalid', 'Invalid saved music library.');
  if (value.length > MUSIC_LIMITS.playlists)
    throw new MusicStorageError('limit', 'This device can store at most 20 playlists.');
  const playlists = value.map(decodeMusicPlaylist);
  const seen = new Set<string>();
  let bytes = 0;
  for (const playlist of playlists) {
    if (seen.has(playlist.id)) throw new MusicStorageError('invalid', 'Duplicate saved playlist ID.');
    seen.add(playlist.id);
    for (const track of playlist.tracks) bytes += track.blob.size;
  }
  if (bytes > MUSIC_LIMITS.totalBytes)
    throw new MusicStorageError('limit', 'The local music library must be 200 MiB or smaller.');
  return playlists;
}
function failure(cause: unknown): MusicStorageError {
  return cause instanceof MusicStorageError
    ? cause
    : new MusicStorageError('failed', 'Music storage could not complete the change.', cause);
}
const STORE = 'playlists';
const DATABASE = 'derby01-music';

export function createMusicLibrary(factory?: IDBFactory): MusicLibrary {
  let database: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;
  let cancelOpening: (() => void) | null = null;
  let closed = false;
  function connection(): Promise<IDBDatabase> {
    if (closed) return Promise.reject(new MusicStorageError('closed', 'Music storage is closed.'));
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: MusicStorageError) => {
        if (settled) return;
        settled = true;
        cancelOpening = null;
        reject(error);
      };
      cancelOpening = () => fail(new MusicStorageError('closed', 'Music storage is closed.'));
      let request: IDBOpenDBRequest;
      try {
        const storage = factory ?? globalThis.indexedDB;
        if (!storage) throw new MusicStorageError('unavailable', 'Local music storage is unavailable.');
        request = storage.open(DATABASE, 1);
      } catch (cause) {
        fail(
          cause instanceof MusicStorageError
            ? cause
            : new MusicStorageError('unavailable', 'Local music storage is unavailable.', cause),
        );
        return;
      }
      request.onupgradeneeded = () => {
        if (settled || closed) {
          request.transaction?.abort();
          return;
        }
        try {
          if (!request.result.objectStoreNames.contains(STORE))
            request.result.createObjectStore(STORE, { keyPath: 'id' });
        } catch (cause) {
          request.transaction?.abort();
          fail(failure(cause));
        }
      };
      request.onerror = () => fail(failure(request.error));
      request.onblocked = () =>
        fail(new MusicStorageError('blocked', 'Close other derby01 tabs to update local music storage.'));
      request.onsuccess = () => {
        const db = request.result;
        if (settled || closed) {
          db.close();
          return;
        }
        settled = true;
        cancelOpening = null;
        database = db;
        db.onversionchange = () => {
          db.close();
          if (database === db) database = null;
        };
        db.onclose = () => {
          if (database === db) database = null;
        };
        resolve(db);
      };
    });
    opening = promise;
    void promise.then(
      () => {
        if (opening === promise) opening = null;
      },
      () => {
        if (opening === promise) opening = null;
      },
    );
    return promise;
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    perform: (store: IDBObjectStore, done: (result: T) => void, abort: (error: unknown) => void) => void,
  ): Promise<T> {
    const db = await connection();
    if (closed) throw new MusicStorageError('closed', 'Music storage is closed.');
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE, mode);
      } catch (cause) {
        reject(failure(cause));
        return;
      }
      let result: T;
      let ready = false;
      let error: MusicStorageError | null = null;
      const abort = (cause: unknown) => {
        error = failure(cause);
        try {
          tx.abort();
        } catch {
          reject(error);
        }
      };
      tx.onabort = () => reject(error ?? failure(tx.error));
      tx.onerror = () => {
        error ??= failure(tx.error);
      };
      tx.oncomplete = () => {
        if (ready) resolve(result);
        else reject(failure('Music transaction finished without a result.'));
      };
      try {
        perform(
          tx.objectStore(STORE),
          (value) => {
            result = value;
            ready = true;
          },
          abort,
        );
      } catch (cause) {
        abort(cause);
      }
    });
  }
  async function list(): Promise<Playlist[]> {
    return transaction('readonly', (store, done, abort) => {
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          done(decodeMusicLibrary(request.result));
        } catch (cause) {
          abort(cause);
        }
      };
    });
  }
  async function save(value: Playlist): Promise<void> {
    const playlist = decodeMusicPlaylist(value);
    return transaction('readwrite', (store, done, abort) => {
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          // Reading and writing in one transaction serializes the size limit across tabs.
          const current = decodeMusicLibrary(request.result).filter((entry) => entry.id !== playlist.id);
          decodeMusicLibrary([...current, playlist]);
          store.put(playlist);
          done(undefined);
        } catch (cause) {
          abort(cause);
        }
      };
    });
  }
  async function remove(id: string): Promise<void> {
    const key = boundedText(id, MUSIC_LIMITS.idLength, 'playlist ID');
    return transaction('readwrite', (store, done) => {
      store.delete(key);
      done(undefined);
    });
  }
  function close(): void {
    if (closed) return;
    closed = true;
    cancelOpening?.();
    database?.close();
    database = null;
  }
  return { list, save, remove, close };
}
