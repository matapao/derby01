import { Reader, Writer, toBytes, utf8len, utf8write, type Payload } from './codec.ts';
import { Emitter } from './emitter.ts';
import { report } from './env.ts';
import { DATA_FILE, type GameEvents, type GameNet, type Revision } from './game.ts';
import { APP, LIMITS, MAX_TYPE, SERVER, SYS, playerName } from './protocol.ts';

/** Where a headless authority's messages go: straight into the hub, or out of its worker. */
export interface Outbox {
  send(wireType: number, to: number, bytes: Uint8Array, unreliable: boolean): void;
  /** Reads a game's data file by its path on the host (/derby01/@r8/data/town.json), for data(). */
  load?(path: string): Promise<unknown>;
}

/**
 * The connection a headless authority gets: the hub's own seat (254, "Server"), with the same
 * methods and events as a player's connection, and no network in between.
 */
export class LocalNet extends Emitter<GameEvents> implements GameNet {
  readonly id = SERVER;
  readonly name = 'Server';
  readonly local = true;
  readonly rtt = 0;
  readonly jitter = 0;
  connected = true;
  hostId: number;
  revision: Revision | null;
  readonly peers = new Map<number, string>();
  /** The game's id, for the paths data() reads. */
  readonly game: string;

  private readonly outbox: Outbox;
  private readonly clock: () => number;
  /** The installed version's folder on the host: /stars/@1.0.0/. */
  private readonly base: string;
  private readonly user = new Writer(512);
  private readonly scratch = new Writer(256);
  private readonly reader = new Reader();

  constructor(outbox: Outbox, clock: () => number, hostId: number, peers: Iterable<number>, o: { readonly game?: string; readonly revision?: Revision | null; readonly base?: string } = {}) {
    super();
    this.outbox = outbox;
    this.clock = clock;
    this.hostId = hostId;
    this.game = o.game ?? 'game';
    this.revision = o.revision ?? null;
    this.base = o.base ?? '/' + this.game + '/';
    for (const id of peers) if (id !== SERVER) this.peers.set(id, playerName(id));
  }

  isHost(): boolean {
    return this.hostId === this.id;
  }

  now(): number {
    return this.clock();
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

  private app(to: number, type: number, data: Payload | undefined, unreliable: boolean): void {
    if (!Number.isInteger(type) || type < 0 || type > MAX_TYPE) throw new RangeError('zirbel-net: message type must be 0 to ' + MAX_TYPE);
    if (!Number.isInteger(to) || to < 0 || to > 255) throw new RangeError('zirbel-net: to must be ALL, HOST or a seat');
    if (!this.connected) return;
    let b: Uint8Array;
    if (typeof data === 'string') {
      const w = this.scratch.reset();
      w.ensure(utf8len(data));
      w.pos = utf8write(data, w.buf, 0);
      b = w.view();
    } else b = toBytes(data);
    this.outbox.send(type + APP, to, b, unreliable && b.length <= LIMITS.unreliablePayload);
  }

  data(file: string, rev?: string): Promise<unknown> {
    if (!DATA_FILE.test(file)) return Promise.reject(new RangeError('zirbel-net: data() takes a file in data/, like town.json'));
    const id = rev ?? this.revision?.id ?? '';
    const load = this.outbox.load;
    if (!load) return Promise.reject(new Error('zirbel-net: this host gives its authorities no data'));
    return load((id ? '/' + this.game + '/@' + id + '/' : this.base) + 'data/' + file);
  }

  /** From the hub: the room moved to another revision. */
  changeRevision(rev: Revision): void {
    if (!this.connected) return;
    this.revision = rev;
    this.emit('revision', rev);
  }

  /** From the hub: an app message for the authority. */
  deliver(from: number, type: number, b: Uint8Array, start: number, end: number, reliable: boolean): void {
    if (!this.connected) return;
    for (const fn of this.listeners('message')) {
      this.reader.set(b, start, end);
      try {
        fn(from, type, this.reader, reliable);
      } catch (error) {
        report(error);
      }
    }
  }

  /** From the hub: someone joined, left, went away or came back, or the host changed. */
  system(type: number, seat: number): void {
    if (!this.connected) return;
    switch (type) {
      case SYS.JOIN: {
        const label = playerName(seat);
        this.peers.set(seat, label);
        this.emit('peer', seat, label);
        break;
      }
      case SYS.LEAVE:
        this.peers.delete(seat);
        this.emit('leave', seat);
        break;
      case SYS.AWAY:
        this.emit('away', seat);
        break;
      case SYS.BACK:
        this.emit('back', seat);
        break;
      case SYS.HOST:
        this.hostId = seat;
        this.emit('host', seat);
        break;
      default:
        break;
    }
  }

  /** Seated: the first event, as for a player. */
  open(): void {
    if (this.connected) this.emit('open', { id: this.id, hostId: this.hostId, peers: this.peers });
  }

  /** The room emptied or the hub stopped. */
  end(code: number, message: string): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('close', code, message);
  }
}
