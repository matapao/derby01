/**
 * zirbel-net wire protocol, version 2. Every WebSocket message is one frame:
 *
 *   frame    = kind:u8  message*                 kind 0 (1 was the retired WebRTC lane)
 *   message  = type:u8  peer:u8  lenflags:varint  payload[len]
 *   lenflags = len * 2 + (unreliable ? 1 : 0)
 *   type     = 1..31 system messages, 32..255 app messages (app type + 32)
 *   peer     = to the hub: 0 everyone else, 255 the host, otherwise a seat
 *              from the hub: the sender's seat, 0 for the hub itself
 *   varint   = unsigned LEB128;  str = varint byte length + UTF-8;  numbers little-endian
 *
 * System messages:
 *
 *   HELLO    to hub     u8 version, str game, str room, str key, str resumeToken, str instanceNonce, u8 caps (0)
 *   WELCOME  from hub   u8 id, u8 hostId, str token, f64 hubTime, u8 resumed, u8 hubCaps, varint n, n x u8 id, varint maxMsg,
 *                       and when the room plays a revision: str revision, str base
 *   JOIN, LEAVE, AWAY, BACK, HOST   from hub   u8 seat
 *   REVISION from hub   str revision, str base, u8 engine: a newer revision of the game for this room (engine 1: its code changed)
 *   PING     to hub     f64 clientTime (unreliable)
 *   PONG     from hub   f64 clientTime, f64 hubTime
 *   ERROR    from hub   u8 code, str message; then the hub closes the connection
 */

export const VERSION = 2;

/** System message types. 8 (WebRTC signalling) is retired. */
export const SYS = {
  HELLO: 1,
  WELCOME: 2,
  JOIN: 3,
  LEAVE: 4,
  HOST: 5,
  PING: 6,
  PONG: 7,
  ERROR: 9,
  AWAY: 10,
  BACK: 11,
  REVISION: 12,
} as const;

/** The wire type of app message type 0. */
export const APP = 32;
/** The largest app message type. */
export const MAX_TYPE = 223;

/** Destination: every other peer in the room. */
export const ALL = 0;
/** Destination: whoever is host right now. */
export const HOST = 255;
/** The seat of a game the hub runs itself (a dedicated authority). */
export const SERVER = 254;
/** The highest seat a player can have. */
export const MAX_SEAT = 253;

export const LIMITS = {
  /** stream() payloads larger than this are sent reliably instead. */
  unreliablePayload: 1000,
  /** Socket backlog above which unreliable data is dropped instead of queued: stale state is worthless. */
  highWater: 16384,
  /** Batches larger than this are split between messages, so no frame is much larger than its largest message. */
  frame: 65536,
  /** The largest message, unless the hub announces another limit in WELCOME. */
  message: 1 << 20,
} as const;

/** Codes in an ERROR message. */
export const ERR = {
  VERSION: 1,
  FULL: 2,
  BAD: 3,
  SHUTDOWN: 5,
  /** A public room: not let in (no key or ticket for it). */
  DENIED: 6,
} as const;

/** Game and room names. */
export const NAME = /^[\w.-]{1,32}$/;

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function words(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  if (n < 100) return (TENS[Math.floor(n / 10)] ?? '') + (n % 10 ? '-' + (ONES[n % 10] ?? '') : '');
  return (ONES[Math.floor(n / 100)] ?? '') + ' Hundred' + (n % 100 ? ' ' + words(n % 100) : '');
}

/** "Player Three" for seat 3, "Server" for a dedicated authority, '' otherwise. Players are counted, never named. */
export function playerName(seat: number): string {
  if (seat === SERVER) return 'Server';
  return Number.isInteger(seat) && seat > 0 && seat <= MAX_SEAT ? 'Player ' + words(seat) : '';
}

/** a is the same as or newer than b, for 16-bit sequence numbers that wrap around. */
export function seqOk(a: number, b: number): boolean {
  return ((a - b) & 0xffff) < 0x8000;
}

/** a is newer than b, for 16-bit sequence numbers that wrap around. */
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/**
 * Steps through the messages of a frame without allocating. After next() returns true, type, peer,
 * start, end and unreliable describe the current message.
 */
export class Cursor {
  buf: Uint8Array = new Uint8Array(0);
  pos = 0;
  limit = 0;
  type = 0;
  peer = 0;
  start = 0;
  end = 0;
  unreliable = false;

  reset(buf: Uint8Array, pos: number, limit: number): this {
    this.buf = buf;
    this.pos = pos;
    this.limit = limit;
    return this;
  }

  /** Moves to the next message. False at the end of the frame, or where it is cut short or malformed. */
  next(): boolean {
    const b = this.buf;
    const limit = this.limit;
    let q = this.pos;
    if (q + 3 > limit) return false;
    this.type = b[q]!;
    this.peer = b[q + 1]!;
    q += 2;
    let lenflags = 0;
    let mul = 1;
    for (let i = 0; ; i++) {
      // Six varint bytes reach 2^42, far past any message limit.
      if (q >= limit || i === 6) return false;
      const c = b[q++]!;
      lenflags += (c & 127) * mul;
      if (c < 128) break;
      mul *= 128;
    }
    const end = q + Math.floor(lenflags / 2);
    if (end > limit) return false;
    this.start = q;
    this.end = end;
    this.unreliable = lenflags % 2 === 1;
    this.pos = end;
    return true;
  }
}
