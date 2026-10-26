/**
 * A player's connection to the host's hub. One WebSocket carries everything; sends made during one
 * task leave as one frame. A dropped link reconnects by itself and resumes the same seat.
 */
import { Reader, Writer, toBytes, utf8len, utf8write, type Payload } from './codec.ts';
import { Emitter } from './emitter.ts';
import { clock, env, randomHex, report, sessionStore, type StorageLike, type WebSocketConstructor, type WebSocketLike } from './env.ts';
import { DATA_FILE, type GameEvents, type GameNet, type Revision } from './game.ts';
import { ALL, APP, Cursor, HOST, LIMITS, MAX_TYPE, NAME, SYS, VERSION, playerName } from './protocol.ts';

export interface ConnectOptions {
  /** The hub's WebSocket address. Default: /mp on the page's own origin (wss:// on https pages). */
  readonly url?: string;
  /** Rooms are per game. Both are [A-Za-z0-9_.-], 1 to 32 characters. */
  readonly game?: string;
  readonly room?: string;
  /** A host key: whoever connects with the hub's key becomes host. */
  readonly key?: string;
  /** Also deliver your own ALL and HOST messages to yourself: handy when the host also plays. */
  readonly loopback?: boolean;
  /** false: nothing is sent until you call flush(), for example once per tick. */
  readonly autoFlush?: boolean;
  /** false: a dropped link ends the session instead of reconnecting. */
  readonly reconnect?: boolean;
  /** A WebSocket implementation where there is no global one. */
  readonly WebSocket?: WebSocketConstructor;
  /** Where the resume token is kept, so a reload keeps its seat. Default: sessionStorage. null: nowhere. */
  readonly storage?: StorageLike | null;
  /** How data() reads a game's file, given its path on the host (/derby01/@r8/data/town.json). Default: fetch from the host. */
  readonly load?: (path: string) => Promise<unknown>;
}

export type Lane = 'ws' | 'none';

export interface Stats {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  /** stream() messages dropped because the link was down or backed up. */
  dropped: number;
}

export interface ClientEvents extends GameEvents {
  /** Your link dropped. zirbel-net reconnects by itself; your seat is kept for a while. */
  disconnect: () => void;
  /** Your link came back on the same seat. A host should send full state now: messages in flight when it dropped may be lost. */
  resume: () => void;
  lane: (lane: Lane) => void;
}

/** What connect() returns. */
export interface Connection extends GameNet {
  readonly url: string;
  readonly game: string;
  readonly room: string;
  readonly lane: Lane;
  /** True once the session has ended for good. */
  readonly closed: boolean;
  /** The largest message the hub accepts. */
  readonly maxMsg: number;
  readonly stats: Readonly<Stats>;
  /** Sends what is queued now. Automatic after each task, unless autoFlush is false. */
  flush(): void;
  /** Leaves the room for good: the others see leave at once. */
  close(): void;
  on<K extends keyof ClientEvents>(name: K, fn: ClientEvents[K]): this;
  off<K extends keyof ClientEvents>(name: K, fn: ClientEvents[K]): this;
}

const OPEN = 1;
const BACKOFF = [100, 250, 500, 1000, 2000];

export function connect(options: ConnectOptions = {}): Connection {
  return new Net(options);
}

class Net extends Emitter<ClientEvents> implements Connection {
  readonly url: string;
  readonly game: string;
  readonly room: string;
  readonly local = false;
  id = 0;
  hostId = 0;
  name = '';
  peers = new Map<number, string>();
  lane: Lane = 'none';
  connected = false;
  closed = false;
  rtt = 0;
  jitter = 0;
  maxMsg: number = LIMITS.message;
  revision: Revision | null = null;
  readonly stats: Stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, dropped: 0 };

  private readonly key: string;
  private readonly loopback: boolean;
  private readonly autoFlush: boolean;
  private readonly reconnect: boolean;
  private readonly WS: WebSocketConstructor | undefined;
  private readonly nonce = randomHex(8);
  private readonly store: StorageLike | null;
  private readonly storeKey: string;
  private token: string;
  private readonly load: ((path: string) => Promise<unknown>) | undefined;

  private readonly rel = new Writer(2048);
  private readonly un = new Writer(2048);
  private lb = new Writer(256);
  private lb2 = new Writer(256);
  private readonly sys = new Writer(256);
  private readonly user = new Writer(512);
  private readonly reader = new Reader();
  private readonly sysReader = new Reader();
  private readonly cursor = new Cursor();
  private readonly lbCursor = new Cursor();
  private inLoopback = false;
  private queued = false;

  private ws: WebSocketLike | null = null;
  private offset = 0;
  private offsetSet = false;
  private readonly samples: number[] = [];
  private lastRx = 0;
  private tries = 0;
  private pingTimer: unknown = null;
  private retryTimer: unknown = null;
  private readonly flushNow = (): void => this.flush();
  private readonly wake = (): void => this.checkAlive();

  constructor(o: ConnectOptions) {
    super();
    this.url = o.url ?? defaultUrl('/mp');
    this.game = o.game ?? 'game';
    this.room = o.room ?? 'lobby';
    if (!NAME.test(this.game) || !NAME.test(this.room)) {
      throw new RangeError('zirbel-net: game and room are 1 to 32 characters of A-Z, a-z, 0-9, _ . and -');
    }
    this.key = o.key ?? '';
    this.loopback = o.loopback ?? false;
    this.autoFlush = o.autoFlush ?? true;
    this.reconnect = o.reconnect ?? true;
    this.WS = o.WebSocket ?? env.WebSocket;
    this.store = o.storage === undefined ? sessionStore() : o.storage;
    this.storeKey = 'zirbel-net:' + this.url + '|' + this.game + '|' + this.room;
    this.token = this.loadToken();
    this.load = o.load;
    env.document?.addEventListener('visibilitychange', this.wake);
    env.addEventListener?.('online', this.wake);
    env.addEventListener?.('pageshow', this.wake);
    this.open();
  }

  isHost(): boolean {
    return this.id !== 0 && this.id === this.hostId;
  }

  now(): number {
    return clock() + this.offset;
  }

  begin(): Writer {
    return shrink(this.user).reset();
  }

  send(to: number, type: number, data?: Payload): void {
    this.app(to, type, data, false);
  }

  stream(to: number, type: number, data?: Payload): void {
    this.app(to, type, data, true);
  }

  flush(): void {
    this.queued = false;
    const ws = this.ws, rel = this.rel, un = this.un;
    if (this.connected && ws && ws.readyState === OPEN) {
      if (un.pos && ws.bufferedAmount > LIMITS.highWater) {
        un.pos = 0;
        this.stats.dropped++;
      }
      const n = rel.pos + un.pos;
      if (n && n < LIMITS.frame) {
        // The usual case: everything in one frame, kind 0 first.
        const f = new Uint8Array(n + 1);
        f.set(rel.buf.subarray(0, rel.pos), 1);
        f.set(un.buf.subarray(0, un.pos), 1 + rel.pos);
        this.wsSend(f);
      } else if (n) {
        this.split(rel);
        this.split(un);
      }
      rel.pos = 0;
      un.pos = 0;
    } else un.pos = 0;
    if (this.lb.pos) this.runLoopback();
    if (!this.queued) {
      shrink(un);
      if (!rel.pos) shrink(rel);
      shrink(this.lb2);
      shrink(this.sys);
    }
  }

  data(file: string, rev?: string): Promise<unknown> {
    if (!DATA_FILE.test(file)) return Promise.reject(new RangeError('zirbel-net: data() takes a file in data/, like town.json'));
    const id = rev ?? this.revision?.id ?? '';
    const path = (id ? '/' + this.game + '/@' + id + '/' : pageBase(this.game)) + 'data/' + file;
    return this.load ? this.load(path) : fetchJson(path, this.url);
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'bye');
    } catch {
      // already closing
    }
    this.clearToken();
    this.final(1000, 'closed');
  }

  /* ---- sending ---- */

  private app(to: number, type: number, data: Payload | undefined, unreliable: boolean): void {
    if (!Number.isInteger(type) || type < 0 || type > MAX_TYPE) throw new RangeError('zirbel-net: message type must be 0 to ' + MAX_TYPE);
    if (!Number.isInteger(to) || to < 0 || to > 255) throw new RangeError('zirbel-net: to must be ALL, HOST or a seat');
    if (typeof data === 'string') {
      const w = this.sys.reset();
      w.ensure(utf8len(data));
      w.pos = utf8write(data, w.buf, 0);
      this.out(type + APP, to, w.buf, 0, w.pos, unreliable);
    } else {
      const b = toBytes(data);
      this.out(type + APP, to, b, 0, b.length, unreliable);
    }
  }

  // Queue one message. A message to yourself goes to the loopback queue only.
  private out(wt: number, to: number, b: Uint8Array, s: number, e: number, unreliable: boolean): void {
    const len = e - s;
    const self = this.id !== 0 && (to === this.id || (to === HOST && this.id === this.hostId));
    if (len > this.maxMsg && !self) throw new RangeError(`zirbel-net: a message of ${len} bytes is over the hub's limit of ${this.maxMsg}`);
    if (unreliable && len > LIMITS.unreliablePayload) unreliable = false;
    if (this.loopback && wt >= APP && (self || to === ALL)) put(this.lb, wt, this.id, b, s, len, unreliable);
    if (!self) {
      if (unreliable && !this.connected) this.stats.dropped++;
      else {
        if (!this.connected && this.rel.pos > LIMITS.message) this.rel.pos = 0; // bound what waits while offline
        put(unreliable ? this.un : this.rel, wt, to, b, s, len, unreliable);
      }
    }
    if (this.autoFlush && !this.queued) {
      this.queued = true;
      void Promise.resolve().then(this.flushNow);
    }
  }

  private wsSend(f: Uint8Array): void {
    try {
      this.ws?.send(f);
      this.stats.framesOut++;
      this.stats.bytesOut += f.length;
    } catch {
      // the close handler deals with it
    }
  }

  // A big batch goes out as several frames, cut between messages, so no frame is much larger than
  // the largest single message (the hub enforces that).
  private split(w: Writer): void {
    const c = new Cursor().reset(w.buf, 0, w.pos);
    let start = 0;
    let last = 0;
    while (c.next()) {
      if (c.pos - start + 1 > LIMITS.frame && last > start) {
        this.wsSend(frame(w.buf, start, last));
        start = last;
      }
      last = c.pos;
    }
    if (last > start) this.wsSend(frame(w.buf, start, last));
  }

  private runLoopback(): void {
    if (this.inLoopback) return; // a handler that flushes: its messages wait for the next round
    this.inLoopback = true;
    const w = this.lb;
    this.lb = this.lb2; // swap: handlers may send while this one is read
    this.lb2 = w;
    const end = w.pos;
    w.pos = 0;
    const c = this.lbCursor.reset(w.buf, 0, end);
    try {
      while (c.next()) this.dispatch(c.peer, c.type - APP, w.buf, c.start, c.end, !c.unreliable);
    } finally {
      this.inLoopback = false;
    }
  }

  /* ---- receiving ---- */

  private open(): void {
    const WS = this.WS;
    if (!WS) {
      env.setTimeout(() => this.final(0, 'this environment has no WebSocket'), 0);
      return;
    }
    let ws: WebSocketLike;
    try {
      // The room rides in the address too, so a proxy in front of several machines can route the socket to the room's.
      ws = new WS(this.url + (this.url.includes('?') ? '&' : '?') + 'r=' + encodeURIComponent(this.game + '/' + this.room));
    } catch (error) {
      // A malformed address, or ws:// from an https page: trying again would not help.
      env.setTimeout(() => this.final(0, 'cannot connect to ' + this.url + ': ' + String(error)), 0);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) this.hello();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data === 'string') return;
      this.lastRx = clock();
      this.recv(new Uint8Array(event.data as ArrayBuffer));
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
      this.lost();
    };
  }

  private hello(): void {
    const w = this.sys.reset();
    w.u8(VERSION).str(this.game).str(this.room).str(this.key).str(this.token).str(this.nonce).u8(0);
    const f = new Writer(w.pos + 8);
    f.u8(0).u8(SYS.HELLO).u8(0).varint(w.pos * 2).raw(w.view());
    this.lastRx = clock();
    this.wsSend(f.view());
  }

  private recv(u8: Uint8Array): void {
    this.stats.framesIn++;
    this.stats.bytesIn += u8.length;
    if (u8[0] !== 0) return;
    const c = this.cursor.reset(u8, 1, u8.length);
    while (c.next()) {
      if (c.type >= APP) this.dispatch(c.peer, c.type - APP, u8, c.start, c.end, !c.unreliable);
      else this.system(c.type, u8, c.start, c.end);
      if (this.closed) return;
    }
  }

  // The hot path: one Reader, rewound for each listener, nothing allocated.
  private dispatch(from: number, type: number, b: Uint8Array, s: number, e: number, reliable: boolean): void {
    const r = this.reader;
    for (const fn of this.listeners('message')) {
      r.set(b, s, e);
      try {
        fn(from, type, r, reliable);
      } catch (error) {
        report(error);
      }
    }
  }

  private system(type: number, b: Uint8Array, s: number, e: number): void {
    const r = this.sysReader.set(b, s, e);
    switch (type) {
      case SYS.WELCOME: {
        const me = r.u8(), host = r.u8(), token = r.str(), hubTime = r.f64(), resumed = r.u8();
        r.u8(); // the hub's capabilities: none are defined
        const peers = new Map<number, string>();
        const n = r.varint();
        for (let i = 0; i < n && !r.overrun; i++) {
          const id = r.u8();
          peers.set(id, playerName(id));
        }
        if (r.left() > 0) this.maxMsg = r.varint();
        const revId = r.left() > 0 ? r.str() : '', revBase = r.left() > 0 ? r.str() : '';
        this.revision = revId ? { id: revId, base: revBase, engine: false } : null;
        this.id = me;
        this.hostId = host;
        this.peers = peers;
        this.name = playerName(me);
        this.token = token;
        this.saveToken();
        if (!this.offsetSet) this.offset = hubTime - clock();
        this.connected = true;
        this.tries = 0;
        this.setLane('ws');
        this.startPing();
        if (resumed) this.emit('resume');
        else this.emit('open', { id: me, hostId: host, peers });
        // The room plays another revision than this page was opened at: it moved on meanwhile.
        const page = launchParams().rev;
        if (this.revision && page && this.revision.id !== page) this.onRevision({ ...this.revision, engine: true });
        this.flush();
        break;
      }
      case SYS.REVISION: {
        const id = r.str(), base = r.str(), engine = r.u8() === 1;
        if (r.overrun || !id) break;
        this.revision = { id, base, engine };
        this.onRevision(this.revision);
        break;
      }
      case SYS.JOIN: {
        const id = r.u8(), label = playerName(id);
        this.peers.set(id, label);
        this.emit('peer', id, label);
        break;
      }
      case SYS.LEAVE: {
        const id = r.u8();
        this.peers.delete(id);
        this.emit('leave', id);
        break;
      }
      case SYS.AWAY:
        this.emit('away', r.u8());
        break;
      case SYS.BACK:
        this.emit('back', r.u8());
        break;
      case SYS.HOST:
        this.hostId = r.u8();
        this.emit('host', this.hostId);
        break;
      case SYS.PONG:
        this.pong(r.f64(), r.f64());
        break;
      case SYS.ERROR: {
        const code = r.u8(), message = r.str();
        this.closed = true;
        const ws = this.ws;
        this.ws = null;
        try {
          ws?.close();
        } catch {
          // already closed
        }
        this.clearToken();
        this.final(code, message);
        break;
      }
      default:
        break; // unknown system messages are for newer clients
    }
  }

  // A game that listens loads the revision's data itself; one that doesn't is reloaded at the
  // revision's address, keeping its seat (the resume token survives the reload).
  private onRevision(rev: Revision): void {
    if (this.listeners('revision').length) return this.emit('revision', rev);
    const loc = env.location;
    if (loc?.assign && /^\/[\w.-]+\/@[^/]+\//.test(rev.base)) loc.assign(rev.base + (loc.search ?? ''));
  }

  /* ---- clock and liveness ---- */

  // NTP-style: of the last 8 samples, trust the one with the lowest round trip (least queueing),
  // and slew small corrections so time never jumps.
  private pong(t0: number, hubTime: number): void {
    const t = clock(), rtt = t - t0, s = this.samples;
    if (!(rtt >= 0 && rtt <= 10000)) return;
    this.rtt = this.rtt ? this.rtt + (rtt - this.rtt) * 0.125 : rtt;
    this.jitter += (Math.abs(rtt - this.rtt) - this.jitter) * 0.125;
    s.push(rtt, hubTime + rtt / 2 - t);
    if (s.length > 16) s.splice(0, 2);
    let best = 0;
    for (let i = 2; i < s.length; i += 2) if (s[i]! < s[best]!) best = i;
    const target = s[best + 1]!;
    if (!this.offsetSet || Math.abs(target - this.offset) > 25) {
      this.offset = target;
      this.offsetSet = true;
    } else this.offset += (target - this.offset) * 0.1;
  }

  private startPing(): void {
    env.clearTimeout(this.pingTimer);
    let n = 0;
    const tick = (): void => {
      if (!this.connected) return;
      if (clock() - this.lastRx > 5000) {
        this.drop(); // half-open link: nothing has come back for a while
        return;
      }
      const w = this.sys.reset().f64(clock());
      this.out(SYS.PING, 0, w.buf, 0, w.pos, true);
      this.flush();
      this.pingTimer = env.setTimeout(tick, ++n < 6 ? 100 : 1000); // quick samples first, for the clock
    };
    tick();
  }

  private checkAlive(): void {
    if (this.closed || env.document?.visibilityState === 'hidden') return;
    if (!this.connected) {
      if (this.retryTimer !== null) {
        env.clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.tries = 0;
        this.open();
      }
    } else if (clock() - this.lastRx > 3000) this.drop();
  }

  private drop(): void {
    const ws = this.ws;
    if (ws?.onclose) ws.onclose(undefined);
    else if (!ws) this.lost();
  }

  private lost(): void {
    const was = this.connected;
    this.connected = false;
    env.clearTimeout(this.pingTimer);
    this.setLane('none');
    if (this.closed) return;
    if (!this.reconnect) {
      this.final(1006, 'connection lost');
      return;
    }
    if (was) this.emit('disconnect');
    const base = BACKOFF[Math.min(this.tries++, BACKOFF.length - 1)]!;
    env.clearTimeout(this.retryTimer);
    this.retryTimer = env.setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.open();
    }, base * (0.8 + Math.random() * 0.4)); // jitter: a restarted hub isn't hit by everyone at once
  }

  private final(code: number, message: string): void {
    this.closed = true;
    this.connected = false;
    env.clearTimeout(this.pingTimer);
    env.clearTimeout(this.retryTimer);
    this.setLane('none');
    env.document?.removeEventListener('visibilitychange', this.wake);
    env.removeEventListener?.('online', this.wake);
    env.removeEventListener?.('pageshow', this.wake);
    this.emit('close', code, message);
  }

  private setLane(lane: Lane): void {
    if (this.lane !== lane) {
      this.lane = lane;
      this.emit('lane', lane);
    }
  }

  /* ---- the resume token: lets a reload keep its seat; forgotten when you leave ---- */

  private loadToken(): string {
    try {
      return this.store?.getItem(this.storeKey) ?? '';
    } catch {
      return '';
    }
  }

  private saveToken(): void {
    try {
      this.store?.setItem(this.storeKey, this.token);
    } catch {
      // storage full or blocked: resuming after a reload won't work, everything else does
    }
  }

  private clearToken(): void {
    this.token = '';
    try {
      this.store?.removeItem(this.storeKey);
    } catch {
      // blocked
    }
  }
}

function defaultUrl(path: string): string {
  const loc = env.location;
  if (loc && loc.host && (loc.protocol === 'https:' || loc.protocol === 'http:')) {
    return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + path;
  }
  return 'ws://127.0.0.1:7777' + path;
}

function put(w: Writer, wt: number, peer: number, b: Uint8Array, s: number, len: number, unreliable: boolean): void {
  w.ensure(len + 10);
  const buf = w.buf, p = w.pos;
  buf[p] = wt;
  buf[p + 1] = peer;
  w.pos = p + 2;
  w.varint(len * 2 + (unreliable ? 1 : 0));
  if (len) {
    w.buf.set(s === 0 && len === b.length ? b : b.subarray(s, s + len), w.pos);
    w.pos += len;
  }
}

function frame(b: Uint8Array, start: number, end: number): Uint8Array {
  const f = new Uint8Array(1 + end - start);
  f.set(b.subarray(start, end), 1);
  return f;
}

// A writer that grew for one big message goes back to its normal size once it is empty.
function shrink(w: Writer): Writer {
  if (w.pos === 0 && w.buf.length > 65536) w.buf = new Uint8Array(2048);
  return w;
}

/** This page's own folder on the host, /stars/@1.0.0/, from its path; else /<game>/. */
function pageBase(game: string): string {
  const m = /^\/[\w.-]+\/@[^/]+\//.exec(env.location?.pathname ?? '');
  return m ? m[0] : '/' + game + '/';
}

/** A file's JSON from the host: the page's own origin, else (a bot, a test) the hub's address. */
async function fetchJson(path: string, hubUrl: string): Promise<unknown> {
  const f = env.fetch;
  if (!f) throw new Error('zirbel-net: no fetch here to load data with');
  const url = env.location?.host ? path : hubUrl.replace(/^ws(s?):/, 'http$1:').replace(/\/[^/]*$/, '') + path;
  const res = await f(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('zirbel-net: no ' + path + ' on this host');
  return res.json();
}

export interface LaunchParams {
  /** The game's id: the first part of the page's path (/fps01/… is fps01). */
  readonly game: string;
  /** The revision the page was opened at: 'r8' for /<game>/@r8/…, else ''. */
  readonly rev: string;
  /** From ?room=; a missing or unusable room becomes a random four-letter code. */
  readonly room: string;
  /** From ?key=: the host key the lobby passes to the window that should host. */
  readonly key: string;
}

/**
 * What a game page was opened with. Hosts serve each game under /<id>/, and the lobby opens it
 * with ?room=…&key=…, so connect({ ...launchParams(), loopback: true }) is all a game needs.
 */
export function launchParams(where: { readonly pathname?: string; readonly search?: string } = env.location ?? {}): LaunchParams {
  const search = where.search ?? '';
  const get = (name: string): string => {
    const m = new RegExp('[?&]' + name + '=([^&#]*)').exec(search);
    if (!m) return '';
    try {
      return decodeURIComponent((m[1] ?? '').replace(/\+/g, ' '));
    } catch {
      return '';
    }
  };
  const room = get('room').toUpperCase().replace(/[^\w.-]/g, '').slice(0, 32);
  let game = 'game';
  const first = /^\/([^/@?#]+)/.exec(where.pathname ?? '');
  try {
    const id = first ? decodeURIComponent(first[1] ?? '') : '';
    if (NAME.test(id)) game = id;
  } catch {
    // a broken escape: keep the default
  }
  const rev = /^\/[^/]+\/@(r[\w.-]{1,40})\//.exec(where.pathname ?? '');
  return { game, room: room || randomRoom(), key: get('key'), rev: rev ? (rev[1] ?? '') : '' };
}

function randomRoom(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = env.crypto.getRandomValues(new Uint8Array(4));
  let s = '';
  for (const b of bytes) s += letters.charAt(b % letters.length);
  return s;
}
