import type { Payload, Reader, Writer } from './codec.ts';
import { SERVER } from './protocol.ts';

export interface OpenInfo {
  /** Your seat. */
  readonly id: number;
  readonly hostId: number;
  /** Everyone else in the room, by seat: "Player Three". A dedicated authority is seat 254, "Server". */
  readonly peers: ReadonlyMap<number, string>;
}

/** Events every game connection has: a player's, and the hub's own seat for a dedicated authority. */
export interface GameEvents {
  /** Seated in the room. Also after a resume that failed and gave a new seat. */
  open: (info: OpenInfo) => void;
  /** An app message. Read r before returning: it is reused for the next message. */
  message: (from: number, type: number, r: Reader, reliable: boolean) => void;
  /** Someone took a seat. label is "Player Three". */
  peer: (id: number, label: string) => void;
  /** Someone left for good. */
  leave: (id: number) => void;
  /** Someone's link dropped. Their seat is kept while they reconnect. */
  away: (id: number) => void;
  /** Someone who was away is back on the same seat. */
  back: (id: number) => void;
  /** The host changed. */
  host: (hostId: number) => void;
  /** The end: you left, the hub stopped, or it refused you. */
  close: (code: number, message: string) => void;
  /**
   * A newer revision of the game landed for this room. Load its data (net.data) and start the next
   * round with it; engine true means its code changed, and the page must reload at rev.base. A game
   * that doesn't listen is reloaded there for every revision, keeping its seat.
   */
  revision: (rev: Revision) => void;
}

/** A revision of a game a host keeps (packages/revisions): r8 is served at /<game>/@r8/. */
export interface Revision {
  readonly id: string;
  /** Where its files are: /derby01/@r8/ */
  readonly base: string;
  /** Its code changed from the revision before it: a page reloads, a headless authority restarts. */
  readonly engine: boolean;
}

/**
 * The connection game code sees. In a browser it comes from connect(); a dedicated authority gets
 * one from the hub, with the same methods and events.
 */
export interface GameNet {
  /** Your seat: 1 is Player One. 0 until seated. A dedicated authority is 254. */
  readonly id: number;
  /** "Player Two", or "Server" for a dedicated authority. Players are numbered, never named. */
  readonly name: string;
  /** The seat that runs the game right now. */
  readonly hostId: number;
  /** Everyone else in the room, by seat. */
  readonly peers: ReadonlyMap<number, string>;
  /** True when the hub runs this code headless: it is not a player and has no screen. */
  readonly local: boolean;
  readonly connected: boolean;
  /** Smoothed round trip to the hub, in ms. 0 for the hub's own seat. */
  readonly rtt: number;
  readonly jitter: number;
  isHost(): boolean;
  /** Hub time in ms: the same timeline on every peer. */
  now(): number;
  /** A scratch Writer for one message, emptied each call. Pass it to send() or stream(). */
  begin(): Writer;
  /** Reliable and ordered. to: ALL, HOST or a seat. type: 0 to 223, your own message ids. */
  send(to: number, type: number, data?: Payload): void;
  /** Unreliable, latest wins: stale data is dropped, not queued. Payloads over 1000 bytes go reliably. */
  stream(to: number, type: number, data?: Payload): void;
  /** The revision this room plays now; null for the version the host installed. */
  readonly revision: Revision | null;
  /**
   * A block of the game's data: the JSON of data/<file> at a revision (default: the room's now), as
   * the host serves it. The same in a page and in a headless authority.
   */
  data(file: string, rev?: string): Promise<unknown>;
  on<K extends keyof GameEvents>(name: K, fn: GameEvents[K]): this;
  off<K extends keyof GameEvents>(name: K, fn: GameEvents[K]): this;
}

/** A data file's name in data/: relative, without dot segments. */
export const DATA_FILE = /^(?!.*(?:^|\/)\.)[\w.-]+(?:\/[\w.-]+)*$/;

/**
 * The seats of everyone playing, in order: the other players, plus yourself unless you are the
 * hub's own seat (a dedicated authority watches, it doesn't play).
 */
export function players(net: GameNet): number[] {
  const seats: number[] = [];
  for (const id of net.peers.keys()) if (id !== SERVER) seats.push(id);
  if (!net.local && net.id !== 0) seats.push(net.id);
  return seats.sort((a, b) => a - b);
}

export interface RoomInfo {
  readonly game: string;
  readonly room: string;
}

/**
 * A game's headless authority: the default export of its authority module. The hub calls it once
 * for every new room of that game, with the room's GameNet, and emits close on it when the room
 * empties. Stop timers there.
 */
export type Authority = (net: GameNet, room: RoomInfo) => void;
