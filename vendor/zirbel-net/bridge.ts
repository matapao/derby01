/**
 * For whoever carries a client's frames to the hub without being the client: the game's shell in
 * the browser, and the host's runtime for agents' seats. They read and rewrite the two messages that
 * hold credentials, HELLO on the way in and WELCOME on the way back, so the code that runs the client
 * (a game in a sandboxed frame, a play adapter) never holds a key or a resume token.
 */
import { Reader, Writer } from './codec.ts';
import { Cursor, SYS } from './protocol.ts';

export interface Hello {
  readonly version: number;
  readonly game: string;
  readonly room: string;
  readonly key: string;
  readonly token: string;
  readonly nonce: string;
  readonly caps: number;
}

export interface Welcome {
  readonly id: number;
  readonly hostId: number;
  readonly token: string;
  readonly resumed: boolean;
}

/** The HELLO a client's first frame carries, or null when it isn't one. */
export function readHello(frame: Uint8Array): Hello | null {
  if (frame[0] !== 0) return null;
  const c = new Cursor().reset(frame, 1, frame.length);
  if (!c.next() || c.type !== SYS.HELLO) return null;
  const r = new Reader().set(frame, c.start, c.end);
  const version = r.u8(), game = r.str(), room = r.str(), key = r.str(), token = r.str(), nonce = r.str(), caps = r.u8();
  return r.overrun ? null : { version, game, room, key, token, nonce, caps };
}

/** A frame holding just this HELLO, as a client sends it. */
export function writeHello(h: Hello): Uint8Array {
  const w = new Writer(64 + h.key.length + h.token.length);
  w.u8(h.version).str(h.game).str(h.room).str(h.key).str(h.token).str(h.nonce).u8(h.caps);
  const f = new Writer(w.pos + 8);
  f.u8(0).u8(SYS.HELLO).u8(0).varint(w.pos * 2).raw(w.view());
  return f.view().slice();
}

/** The WELCOME in a frame from the hub, if there is one. */
export function readWelcome(frame: Uint8Array): Welcome | null {
  const at = findWelcome(frame);
  if (!at) return null;
  const r = new Reader().set(frame, at.start, at.end);
  const id = r.u8(), hostId = r.u8(), token = r.str();
  r.f64();
  const resumed = r.u8() === 1;
  return r.overrun ? null : { id, hostId, token, resumed };
}

/** The same frame with the WELCOME's token replaced (by '' for a client that mustn't keep it); null when it has no WELCOME. */
export function replaceWelcomeToken(frame: Uint8Array, token: string): Uint8Array | null {
  const at = findWelcome(frame);
  if (!at) return null;
  const r = new Reader().set(frame, at.start, at.end);
  const id = r.u8(), hostId = r.u8();
  r.str();
  const rest = r.rest(); // hub time, resumed, caps, the peers, maxMsg, and whatever newer hubs add
  const body = new Writer(rest.length + token.length + 8);
  body.u8(id).u8(hostId).str(token).raw(rest);
  const out = new Writer(frame.length + token.length + 8);
  out.raw(frame.subarray(0, at.head));
  out.u8(SYS.WELCOME).u8(0).varint(body.pos * 2).raw(body.view());
  out.raw(frame.subarray(at.end));
  return out.view().slice();
}

/** Where the WELCOME is in a frame: its message's first byte, and its payload. */
function findWelcome(frame: Uint8Array): { head: number; start: number; end: number } | null {
  if (frame[0] !== 0) return null;
  const c = new Cursor().reset(frame, 1, frame.length);
  let head = c.pos;
  while (c.next()) {
    if (c.type === SYS.WELCOME) return { head, start: c.start, end: c.end };
    head = c.pos;
  }
  return null;
}

/** The system messages in a frame from the hub (JOIN, LEAVE, HOST, ERROR…), with their first byte: for counting and watching without a client. */
export function systemTypes(frame: Uint8Array): number[] {
  if (frame[0] !== 0) return [];
  const out: number[] = [];
  const c = new Cursor().reset(frame, 1, frame.length);
  while (c.next()) if (c.type < 32) out.push(c.type);
  return out;
}
