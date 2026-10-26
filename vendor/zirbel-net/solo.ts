/**
 * zirbel-net with nobody else: the room, and the game's headless authority if it has one, run in this
 * page. zirbel.app serves this build as /zirbel-net.js beside the games it has, so a game opened there
 * plays alone at once, with no host and no network: the same API, and the game's own code.
 *
 * You are seat 1, Player One. A game with an authority module gets it running here as seat 254,
 * exactly as on a host; a game without one runs its authority in the page, as the host it is.
 */
import type { ClientEvents, ConnectOptions, Connection, Lane, Stats } from './client.ts';
import { launchParams } from './client.ts';
import { Reader, Writer, toBytes, utf8len, utf8write, type Payload } from './codec.ts';
import { Emitter } from './emitter.ts';
import { clock, env, report } from './env.ts';
import { DATA_FILE, type Authority } from './game.ts';
import { LocalNet } from './local-net.ts';
import { ALL, APP, HOST, LIMITS, MAX_TYPE, SERVER, SYS, playerName } from './protocol.ts';

export * from './index.ts';

/** You, alone in the room. */
const ME = 1;

interface Letter {
  readonly from: number;
  readonly type: number;
  readonly bytes: Uint8Array;
  readonly reliable: boolean;
}

class Solo extends Emitter<ClientEvents> implements Connection {
  readonly url = 'solo:';
  readonly game: string;
  readonly room: string;
  readonly lane: Lane = 'none';
  readonly local = false;
  readonly maxMsg = LIMITS.message;
  readonly stats: Stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, dropped: 0 };
  readonly name = playerName(ME);
  readonly peers = new Map<number, string>();
  readonly rtt = 0;
  readonly jitter = 0;
  id = 0;
  hostId = 0;
  connected = false;
  closed = false;
  readonly revision = null;

  private authority: LocalNet | null = null;
  private readonly loopback: boolean;
  private readonly user = new Writer(512);
  private readonly scratch = new Writer(256);
  private readonly reader = new Reader();
  // Letters go out after the sender's code has returned, as over a network: neither side's code
  // ever runs inside the other's.
  private toMe: Letter[] = [];
  private toAuthority: Letter[] = [];
  private posted = false;

  constructor(o: ConnectOptions) {
    super();
    const p = launchParams();
    this.game = o.game ?? p.game;
    this.room = o.room ?? p.room;
    this.loopback = o.loopback ?? false;
  }

  /** The room opens: the authority first (as the hub's seat 254), then you take seat 1. */
  start(authority: Authority | null): void {
    if (this.closed) return;
    if (authority) {
      const net = new LocalNet({
        send: (wt, to, b, unreliable) => this.fromAuthority(wt, to, b, unreliable),
        load: (path) => this.data(path.replace(/^.*\/data\//, '')),
      }, clock, SERVER, [], { game: this.game, base: gameBase() });
      this.authority = net;
      try {
        authority(net, { game: this.game, room: this.room });
      } catch (error) {
        report(error);
      }
      net.open();
      this.peers.set(SERVER, 'Server');
    }
    this.id = ME;
    this.hostId = authority ? SERVER : ME;
    this.connected = true;
    this.emit('open', { id: ME, hostId: this.hostId, peers: this.peers });
    this.authority?.system(SYS.JOIN, ME);
  }

  fail(error: unknown): void {
    report(error);
    this.finish(1011, 'this game could not start here');
  }

  isHost(): boolean {
    return this.id !== 0 && this.id === this.hostId;
  }

  now(): number {
    return clock();
  }

  begin(): Writer {
    if (this.user.buf.length > 65536) this.user.buf = new Uint8Array(2048);
    return this.user.reset();
  }

  send(to: number, type: number, data?: Payload): void {
    this.app(to, type, data, false);
  }

  stream(to: number, type: number, data?: Payload): void {
    this.app(to, type, data, true);
  }

  flush(): void {
    // Nothing waits: letters leave as soon as the sender's code returns.
  }

  /** The game's data files, beside the page: solo plays the version it was opened at. */
  async data(file: string): Promise<unknown> {
    if (!DATA_FILE.test(file)) throw new RangeError('zirbel-net: data() takes a file in data/, like town.json');
    if (!env.fetch) throw new Error('zirbel-net: no fetch here to load data with');
    const res = await env.fetch(gameBase() + 'data/' + file, { cache: 'no-cache' });
    if (!res.ok) throw new Error('zirbel-net: no data/' + file + ' beside this game');
    return res.json();
  }

  close(): void {
    this.finish(1000, 'you left');
  }

  private app(to: number, type: number, data: Payload | undefined, unreliable: boolean): void {
    if (!Number.isInteger(type) || type < 0 || type > MAX_TYPE) throw new RangeError('zirbel-net: message type must be 0 to ' + MAX_TYPE);
    if (!Number.isInteger(to) || to < 0 || to > 255) throw new RangeError('zirbel-net: to must be ALL, HOST or a seat');
    if (!this.connected) return;
    let b: Uint8Array;
    if (typeof data === 'string') {
      const w = this.scratch.reset();
      w.ensure(utf8len(data));
      w.pos = utf8write(data, w.buf, 0);
      b = w.view().slice();
    } else b = toBytes(data).slice();
    if (b.length > this.maxMsg) throw new RangeError('zirbel-net: message too large');
    const letter: Letter = { from: ME, type, bytes: b, reliable: !unreliable };
    this.stats.framesOut++;
    this.stats.bytesOut += b.length;
    const self = to === ME || (to === HOST && this.hostId === ME);
    if (this.authority && (to === ALL || to === HOST || to === SERVER)) this.post(this.toAuthority, letter);
    if (this.loopback && (self || to === ALL)) this.post(this.toMe, letter);
  }

  private fromAuthority(wireType: number, to: number, b: Uint8Array, unreliable: boolean): void {
    if (to !== ALL && to !== ME) return; // the authority to itself: there is no one else
    this.post(this.toMe, { from: SERVER, type: wireType - APP, bytes: b.slice(), reliable: !unreliable });
  }

  private post(box: Letter[], letter: Letter): void {
    box.push(letter);
    if (this.posted) return;
    this.posted = true;
    void Promise.resolve().then(() => this.deliver());
  }

  private deliver(): void {
    this.posted = false;
    const toAuthority = this.toAuthority, toMe = this.toMe;
    this.toAuthority = [];
    this.toMe = [];
    for (const l of toAuthority) this.authority?.deliver(l.from, l.type, l.bytes, 0, l.bytes.length, l.reliable);
    for (const l of toMe) {
      if (!this.connected) return;
      this.stats.framesIn++;
      this.stats.bytesIn += l.bytes.length;
      for (const fn of this.listeners('message')) {
        this.reader.set(l.bytes, 0, l.bytes.length);
        try {
          fn(l.from, l.type, this.reader, l.reliable);
        } catch (error) {
          report(error);
        }
      }
    }
  }

  private finish(code: number, message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.authority?.end(code, message);
    this.authority = null;
    this.emit('close', code, message);
  }
}

/** Where the game's files are: /<id>/@<version>/ on a host or on zirbel.app, else the page's folder. */
function gameBase(): string {
  const path = env.location?.pathname ?? '/';
  const m = /^\/[a-z0-9][a-z0-9-]{1,31}\/@[^/]+\//.exec(path);
  return m ? m[0] : path.replace(/[^/]*$/, '');
}

/** The game's authority module, named in its zirbel.json beside the page; null if it has none. */
async function loadAuthority(): Promise<Authority | null> {
  const base = gameBase();
  if (!env.fetch) return null;
  const res = await env.fetch(base + 'zirbel.json', { cache: 'no-cache' });
  if (!res.ok) return null;
  const manifest = (await res.json()) as { authority?: unknown };
  const path = manifest.authority;
  if (typeof path !== 'string') return null;
  // Only a module inside the game's own folder.
  if (path.startsWith('/') || path.split('/').some((s) => s === '' || s.startsWith('.'))) throw new Error('zirbel-net: zirbel.json names an authority outside the game');
  const mod = (await import(base + path)) as { default?: unknown };
  if (typeof mod.default !== 'function') throw new Error('zirbel-net: the authority module has no default export');
  return mod.default as Authority;
}

/** A room for you alone, here in the page. */
export function connect(options: ConnectOptions = {}): Connection {
  const solo = new Solo(options);
  loadAuthority().then(
    (authority) => solo.start(authority),
    (error: unknown) => solo.fail(error),
  );
  return solo;
}

/** The same, with the authority given: for tests, and for pages that bring their own. */
export function soloWith(authority: Authority | null, options: ConnectOptions = {}): Connection {
  const solo = new Solo(options);
  solo.start(authority);
  return solo;
}
