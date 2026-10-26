import { currentRole } from './role.ts';
import { getSession } from './context.ts';
import { MSG } from './protocol.ts';
import { DEFAULT_QUEUE, readMusicQueue, type MusicQueue } from '../music-model.ts';

let queue: MusicQueue = { ...DEFAULT_QUEUE, tracks: [...DEFAULT_QUEUE.tracks] };
const listeners = new Set<() => void>();
export const roomMusic = (): MusicQueue => ({ ...queue, tracks: [...queue.tracks] });
export function subscribeRoomMusic(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function sendRoomMusic(to = 0): void {
  const session = getSession();
  if (currentRole() === 'host' && session) session.net.send(to, MSG.radio, JSON.stringify(queue));
}
export function setRoomMusic(value: unknown): boolean {
  if (currentRole() === 'replica') return false;
  const next = readMusicQueue(value);
  if (!next) return false;
  queue = next;
  for (const listener of listeners) listener();
  sendRoomMusic();
  return true;
}
/** Only session's authority-routed replica handler may call this. */
export function receiveRoomMusic(value: unknown): void {
  const next = readMusicQueue(value);
  if (!next) return;
  queue = next;
  for (const listener of listeners) listener();
}
