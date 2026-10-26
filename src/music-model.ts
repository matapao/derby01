import catalogue from '../assets/audio/radio/catalog.json' with { type: 'json' };
import removed from '../assets/audio/radio/today.json' with { type: 'json' };

export interface MusicCredit {
  id: string;
  title: string;
  artist: string;
  source: string;
  license: string;
  licenseUrl: string;
}
export interface MusicQueue {
  title: string;
  tracks: string[];
}
export interface RadioPlaylist extends MusicQueue {
  id: string;
}
export const CATALOGUE: readonly MusicCredit[] = catalogue;
export const RADIO_PLAYLISTS: readonly RadioPlaylist[] = [
  { id: 'random', title: 'Random music', tracks: catalogue.map((track) => track.id) },
  { id: 'action', title: 'Action & adventure', tracks: ['simple-action-beat', 'covert-action'] },
  { id: 'focus', title: 'Focus & create', tracks: ['lofi-hip-hop', 'heavenly-loop', 'relax-background'] },
];
export const DEFAULT_QUEUE: Readonly<MusicQueue> = {
  title: 'Random music',
  tracks: catalogue.map((track) => track.id),
};
/** Track identity, rather than a user-supplied queue title, selects the random mode. */
export function isRandomMusicQueue(queue: MusicQueue): boolean {
  return (
    queue.title === DEFAULT_QUEUE.title &&
    queue.tracks.length === DEFAULT_QUEUE.tracks.length &&
    DEFAULT_QUEUE.tracks.every((id) => queue.tracks.includes(id))
  );
}
/** Shuffle only when a player activates random playback; saved playlists keep their order. */
export function randomMusicQueue(random: () => number = Math.random): MusicQueue {
  const tracks = [...DEFAULT_QUEUE.tracks];
  for (let i = tracks.length - 1; i > 0; i--) {
    const index = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    const other = tracks[index],
      current = tracks[i];
    if (other === undefined || current === undefined) throw new Error('Invalid random music queue');
    tracks[i] = other;
    tracks[index] = current;
  }
  return { title: DEFAULT_QUEUE.title, tracks };
}
export function trackUrl(id: string): string | undefined {
  return catalogue.find((t) => t.id === id)?.download;
}
export const musicCredit = (id: string): MusicCredit | undefined => CATALOGUE.find((t) => t.id === id);
/** Exact content matches preserve known credits even when a recording was imported as a personal file. */
export function recordingCredit(id: string): MusicCredit | undefined {
  return musicCredit(id) ?? catalogue.find((track) => track.sha256 === id);
}
export function readMusicQueue(value: unknown): MusicQueue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    typeof o['title'] !== 'string' ||
    !o['title'].trim() ||
    o['title'].length > 100 ||
    !Array.isArray(o['tracks']) ||
    o['tracks'].length > 40
  )
    return null;
  const tracks = o['tracks'];
  if (
    !tracks.every(
      (id: unknown): id is string =>
        typeof id === 'string' && id !== removed.sha256 && (!!musicCredit(id) || /^[a-f0-9]{64}$/.test(id)),
    )
  )
    return null;
  return { title: o['title'].trim(), tracks: [...tracks] };
}
/** Compatible with saved Zirbel Radio lists. Arbitrary URLs and unreviewed catalogue IDs are rejected. */
export function readRadioPlaylists(value: unknown): RadioPlaylist[] {
  const o =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const lists = Array.isArray(value) ? value : o['playlists'];
  if (!Array.isArray(lists)) return [];
  const seen = new Set<string>();
  return lists.slice(0, 30).flatMap((p: unknown) => {
    if (!p || typeof p !== 'object') return [];
    const v = p as Record<string, unknown>,
      queue = readMusicQueue(v),
      id = v['id'];
    if (
      !queue ||
      typeof id !== 'string' ||
      !/^personal-[a-z0-9-]{1,60}$/.test(id) ||
      seen.has(id) ||
      queue.tracks.some((t) => !musicCredit(t))
    )
      return [];
    seen.add(id);
    return [{ id, ...queue }];
  });
}
