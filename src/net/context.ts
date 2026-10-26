import type * as ZN from '/zirbel-net.js';
import { localName, playerName, playerTag } from './protocol.ts';
import { useLoaded } from '../data.ts';

type ZirbelNet = typeof ZN;

export interface Session {
  readonly zn: ZirbelNet;
  readonly net: ZN.Connection;
}
export let session: Session | null = null;

export const getSession = (): Session | null => session;
/** This screen's seat in the room, or 0 offline. */
export const mySeat = (): number => session?.net.id ?? 0;
/** The other players' seats (not the headless authority's: derby01 has none). */
export function peerSeats(): number[] {
  return session ? [...session.net.peers.keys()].filter((id) => id !== session!.zn.SERVER) : [];
}

/** What the hub calls a seat in this room ("Player Three", "Bot One"), so every screen shows the same. */
export function seatName(seat: number): string {
  if (!session) return '';
  const { net, zn } = session;
  return (seat === net.id ? net.name : net.peers.get(seat)) || zn.playerName(seat);
}

/**
 * A player's names, the full one for the lists and the HUD and the short one for the tags and the
 * kill feed: online after their screen's seat (Player Three, Player Three B; P3, P3b), offline after
 * their place on this screen (Player One, Player Two; P1, P2).
 */
export function nameOf(p: number, i: number): { name: string; tag: string } {
  const seat = session ? seatName(p) : localName(i),
    k = session ? i : 0;
  return { name: playerName(seat, k), tag: playerTag(seat, k) };
}

/** A revision of the data that landed for the room mid-round: the host plays it from the next round on. */
let pendingRev: string | null = null;

/** The host, as a round starts: a revision that landed meanwhile is put in place (once it is read). */
export function takeRevision(): void {
  if (pendingRev !== null && useLoaded(pendingRev)) pendingRev = null;
}

export function setSession(value: Session | null): void {
  session = value;
}
export function setPendingRevision(revision: string): void {
  pendingRev = revision;
}
export let lastSetup: Record<string, unknown> | null = null;
export function setLastSetup(value: Record<string, unknown> | null): void {
  lastSetup = value;
}
