/**
 * Which part this screen plays.
 *
 *   offline  no zirbel host (the plain web build): the game as it always was, local split screen
 *   host     it runs the game for the room: everyone's cars, the bots, the rules
 *   replica  it draws the host's game and sends its own players' controls
 */
export type Role = 'offline' | 'host' | 'replica';

let role: Role = 'offline';
const listeners = new Set<() => void>();
export function subscribeRole(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setRole(r: Role): void {
  if (role === r) return;
  role = r;
  for (const listener of listeners) listener();
}
export const currentRole = (): Role => role;
export const isReplica = (): boolean => role === 'replica';
export const isNetHost = (): boolean => role === 'host';
