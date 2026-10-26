// The play adapter, fed the messages a real host sent (recorded by test/live/play-live.ts): what it
// sees, what it sends back, and how fast it is allowed to do things. Its controls are decoded with
// src/net's own readControls, and every recorded effect batch must read to its last byte.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Reader, Writer } from '../vendor/zirbel-net/codec.ts';
import { MSG, PROTOCOL, asObject } from '../src/net/protocol.ts';
import { readControls } from '../src/net/snapshot.ts';
import { readEffects } from '../src/agent/fx.ts';
import adapter, { PlaySession, type Blocks } from '../src/agent/play.ts';
import mechanicRules from '../data/mechanic.json' with { type: 'json' };
import {
  BODY_PANELS,
  bodyworkDetail,
  createBodyworkState,
  panelRepairId,
  type BodyPanel,
} from '../src/gameplay/body-damage.ts';

const FIX = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/messages.json'), 'utf8')) as {
  seat: number;
  messages: { t: number; from: number; type: number; reliable: boolean; b64: string }[];
};
const bytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const HOST_SEAT = FIX.messages[0]!.from;

/** Just enough of a zirbel-net seat: listeners, a clock, and a log of what is sent. */
class FakeNet {
  id = FIX.seat;
  hostId = HOST_SEAT;
  name = 'Player';
  local = false;
  connected = true;
  rtt = 0;
  jitter = 0;
  peers = new Map<number, string>([[HOST_SEAT, 'Player One']]);
  clock = 0;
  sent: { to: number; type: number; bytes: Uint8Array; unreliable: boolean }[] = [];
  private fns = new Map<string, Set<(...a: unknown[]) => void>>();
  private w = new Writer(256);
  isHost(): boolean {
    return this.hostId === this.id;
  }
  now(): number {
    return this.clock;
  }
  begin(): Writer {
    return this.w.reset();
  }
  send(to: number, type: number, data: Writer | string): void {
    this.out(to, type, data, false);
  }
  stream(to: number, type: number, data: Writer | string): void {
    this.out(to, type, data, true);
  }
  private out(to: number, type: number, data: Writer | string, unreliable: boolean): void {
    this.sent.push({
      to,
      type,
      unreliable,
      bytes: typeof data === 'string' ? new TextEncoder().encode(data) : data.view().slice(),
    });
  }
  on(name: string, fn: (...a: unknown[]) => void): this {
    (this.fns.get(name) ?? this.fns.set(name, new Set()).get(name)!).add(fn);
    return this;
  }
  off(name: string, fn: (...a: unknown[]) => void): this {
    this.fns.get(name)?.delete(fn);
    return this;
  }
  deliver(from: number, type: number, b: Uint8Array): void {
    for (const fn of this.fns.get('message') ?? []) fn(from, type, new Reader().set(b, 0, b.length), true);
  }
  asks(): Record<string, unknown>[] {
    return this.sent
      .filter((m) => m.type === MSG.ask)
      .map((m) => JSON.parse(new TextDecoder().decode(m.bytes)));
  }
}

/** Plays the recording into a session: each snapshot's own hub time becomes the clock. */
function replay(net: FakeNet, upTo = Infinity): void {
  for (const m of FIX.messages) {
    if (m.t > upTo) break;
    const b = bytes(m.b64);
    if (m.type === MSG.snap) net.clock = new DataView(b.buffer, b.byteOffset + 1, 8).getFloat64(0, true);
    net.deliver(m.from, m.type, b);
  }
}

// a clock the test moves, for the adapter's own pacing; every session is stopped after its test
let now = 0;
const real = performance.now.bind(performance);
const running: { stop(): void }[] = [];
const session = (net: FakeNet, data?: Partial<Blocks>): PlaySession => {
  const s = new PlaySession(net as never, data);
  running.push(s);
  return s;
};
beforeEach(() => {
  now = 1e6;
  (performance as { now: () => number }).now = () => now;
});
afterEach(() => {
  (performance as { now: () => number }).now = real;
  for (const s of running.splice(0)) s.stop();
});
const tick = (s: PlaySession, ms: number): void => {
  for (let t = 0; t < ms; t += 33) {
    now += 33;
    (s as unknown as { tick(): void }).tick();
  }
};

test('the recording has a whole round in it', () => {
  const types = new Set(FIX.messages.map((m) => m.type));
  for (const t of [MSG.hello, MSG.round, MSG.crew, MSG.flow, MSG.detail, MSG.fx, MSG.snap])
    assert.ok(types.has(t), `message ${t}`);
});

test('every effect batch the host sent reads to its last byte', () => {
  let batches = 0,
    effects = 0;
  for (const m of FIX.messages.filter((x) => x.type === MSG.fx)) {
    const b = bytes(m.b64),
      r = new Reader().set(b, 0, b.length);
    effects += readEffects(r, 4096).length;
    assert.equal(r.overrun, false);
    assert.equal(
      r.left(),
      0,
      `a batch of ${b.length} bytes was not read to its end: src/agent/fx.ts and src/net/codecs.ts disagree`,
    );
    batches++;
  }
  assert.ok(batches > 0 && effects > 0, `${batches} batches, ${effects} effects worth keeping`);
});

test('it sees its seat, every car, the score and its own car', () => {
  const net = new FakeNet(),
    s = session(net);
  replay(net);
  const o = s.observe() as any;
  assert.ok(['countdown', 'playing', 'over'].includes(o.state), o.state);
  assert.equal(typeof o.you.car, 'number');
  assert.ok(['driver', 'hood', 'trunk', 'mechanic'].includes(o.you.seat));
  assert.ok(o.cars.length >= 2 && o.cars.length <= 8);
  for (const c of o.cars) {
    assert.ok(
      Math.abs(c.x) <= 400 &&
        Math.abs(c.z) <= 400 &&
        c.heading >= 0 &&
        c.heading < 360 &&
        c.hp >= 0 &&
        c.hp <= 100,
      JSON.stringify(c),
    );
    assert.equal(c.guns.length, 2);
    assert.equal(c.crew.length, 4);
  }
  assert.ok(o.cars.filter((c: any) => c.crew.includes('you')).length === 1, 'you sit in one car');
  assert.ok(Object.keys(o.score).length === o.cars.length);
  assert.equal(typeof o.car.fuel, 'number');
  assert.ok(JSON.stringify(o).length < 6000, 'compact');
});

test('events say what happened, and are given once', () => {
  const net = new FakeNet(),
    s = session(net);
  replay(net);
  const ev = s.takeEvents() as any[];
  assert.ok(ev.some((e) => e.type === 'round'));
  assert.ok(ev.some((e) => e.type === 'seat'));
  assert.equal((s.takeEvents() as unknown[]).length, 0);
});

test("a driver's action becomes the controls the host reads", () => {
  const net = new FakeNet(),
    s = session(net);
  replay(net);
  const seat = (s.observe() as any).you.seat;
  if (seat !== 'driver') return; // the recording sat it elsewhere
  assert.deepEqual(s.act({ throttle: 1, steer: -0.5, boost: true }), { ok: true });
  net.sent = [];
  tick(s, 100);
  const frames = net.sent.filter((m) => m.type === MSG.ctrl);
  assert.ok(frames.length >= 2 && frames.every((m) => m.unreliable && m.to === 255));
  const r = new Reader().set(frames[0]!.bytes, 0, frames[0]!.bytes.length),
    list = readControls(r)!;
  assert.equal(list.length, 1);
  assert.equal(list[0]![0], 0);
  assert.equal(list[0]![1].throttle, 1);
  assert.ok(Math.abs(list[0]![1].steer + 0.5) < 0.01);
  assert.equal(list[0]![1].boost, true);
  // for_ms lets go
  s.act({ throttle: 1, for_ms: 200 });
  tick(s, 300);
  const last = net.sent.filter((m) => m.type === MSG.ctrl).at(-1)!;
  assert.equal(readControls(new Reader().set(last.bytes, 0, last.bytes.length))![0]![1].throttle, 0);
});

test("actions that don't fit the seat are refused with a reason", () => {
  const net = new FakeNet(),
    s = session(net);
  replay(net);
  const seat = (s.observe() as any).you.seat;
  assert.match((s.act({ jump: true }) as any).error, /no such field/);
  assert.match((s.act({ throttle: 'fast' }) as any).error, /numbers/);
  assert.match((s.act({ seat: 'roof' }) as any).error, /driver, hood, trunk or mechanic/);
  if (seat === 'driver') assert.match((s.act({ fire: true }) as any).error, /gunners/);
  else assert.match((s.act({ throttle: 1 }) as any).error, /driver/);
});

test("a mechanic's job takes as long as a skilled person needs, and the host is asked once", () => {
  const net = new FakeNet(),
    s = session(net);
  replay(net);
  const me = (s.observe() as any).you.car as number;
  // in the mechanic's seat, with a flat front-left tyre and a spare on board
  const crew = (s as any).crew as unknown[][];
  crew[me]![3] = { p: net.id, i: 0 };
  crew[me]![0] = 'bot';
  (s as any).mine = { car: me, seat: 3 };
  const d = structuredClone((s as any).details.get(me));
  d.sys.tires[0] = 0;
  d.stock.tyres = 1;
  net.deliver(HOST_SEAT, MSG.detail, new TextEncoder().encode(JSON.stringify(d)));
  const jobs = (s.observe() as any).jobs as { id: string; what: string }[];
  assert.ok(
    jobs.some((j) => j.id === 'tire0' && /flat tyre front-left/.test(j.what)),
    JSON.stringify(jobs),
  );
  assert.deepEqual(s.act({ job: 'tire0' }), { ok: true });
  net.sent = [];
  tick(s, 2400);
  assert.equal(
    net.asks().filter((a) => a['a'] === 'fix').length,
    0,
    'not yet: a skilled person needs about 2.6 s',
  );
  tick(s, 600);
  assert.deepEqual(
    net.asks().filter((a) => a['a'] === 'fix'),
    [{ i: 0, a: 'fix', task: 'tire0' }],
  );
  tick(s, 5000);
  assert.equal(
    net.asks().filter((ask) => ask['a'] === 'fix').length,
    1,
    'Non-panel jobs retain their once-only completion',
  );
  // a job with no spare to do it with is refused
  d.sys.tires[1] = 0;
  d.stock.tyres = 0;
  net.deliver(HOST_SEAT, MSG.detail, new TextEncoder().encode(JSON.stringify(d)));
  assert.match((s.act({ job: 'tire1' }) as any).error, /spare tyre/);
});

test("fuel is poured at the can's rate, never faster", () => {
  const net = new FakeNet(),
    s = session(net);
  replay(net);
  const me = (s.observe() as any).you.car as number;
  (s as any).mine = { car: me, seat: 3 };
  const d = structuredClone((s as any).details.get(me));
  d.sys.fuel = 30;
  d.stock.fuel = 1;
  net.deliver(HOST_SEAT, MSG.detail, new TextEncoder().encode(JSON.stringify(d)));
  assert.deepEqual(s.act({ job: 'fuel' }), { ok: true });
  net.sent = [];
  tick(s, 1000);
  const pours = net.asks().filter((a) => a['a'] === 'pour');
  const total = pours.reduce((n, a) => n + Number(a['d']), 0);
  assert.ok(total <= 38 + 0.01, `${total} % in a second: the can pours 38 % a second`);
  assert.ok(pours.every((a) => a['spill'] === false));
});

test('a jam takes the time its directions take to press', () => {
  const net = new FakeNet(),
    s = session(net);
  replay(net);
  const me = (s.observe() as any).you.car as number;
  (s as any).mine = { car: me, seat: 1 };
  const snap = (s as any).snap;
  snap.cars[me].guns[0].jam = true;
  (s as any).snapAt = now;
  assert.deepEqual(s.act({ unjam: true }), { ok: true });
  net.sent = [];
  tick(s, 1000);
  assert.equal(net.asks().filter((a) => a['a'] === 'unjam').length, 0);
  tick(s, 600);
  assert.equal(net.asks().filter((a) => a['a'] === 'unjam').length, 1);
});

test('changing seat asks the host, never quicker than it takes them', () => {
  const net = new FakeNet(),
    s = session(net);
  replay(net);
  const o = s.observe() as any,
    target = o.you.seat === 'mechanic' ? 'driver' : 'mechanic';
  net.sent = [];
  assert.deepEqual(s.act({ seat: target }), { ok: true });
  tick(s, 2000);
  const times: number[] = [];
  let t = 0;
  for (const m of net.sent) {
    if (m.type === MSG.ask && JSON.parse(new TextDecoder().decode(m.bytes))['a'] === 'switch') times.push(t);
    if (m.type === MSG.ctrl) t += 33;
  }
  assert.ok(times.length >= 1 && times.length <= 3);
  for (let i = 1; i < times.length; i++)
    assert.ok(times[i]! - times[i - 1]! >= 600, `${times[i]! - times[i - 1]!} ms apart`);
});

test('a host of another version, and messages too big, are ignored', () => {
  // the same round from a host one version on: its hello says so, and nothing after it is read
  const net = new FakeNet(),
    s = session(net);
  for (const m of FIX.messages) {
    let b = bytes(m.b64);
    if (m.type === MSG.hello)
      b = new TextEncoder().encode(
        JSON.stringify({ ...JSON.parse(new TextDecoder().decode(b)), protocol: PROTOCOL + 1 }),
      );
    net.deliver(m.from, m.type, b);
  }
  assert.equal((s.observe() as any).state, 'unavailable');
  assert.match((s.observe() as any).note, /another version/);
  assert.equal((s.observe() as any).cars, undefined, 'nothing of its round is shown');
  const t = new FakeNet(),
    u = session(t);
  t.deliver(HOST_SEAT, MSG.crew, new Uint8Array(5000));
  assert.equal((u.observe() as any).state, 'connecting');
});

test('the adapter describes itself as the contract asks', () => {
  assert.ok(adapter.about.split(/\s+/).length <= 150);
  assert.equal((adapter.action as any).type, 'object');
  assert.equal((adapter.observation as any).type, 'object');
  const net = new FakeNet(),
    play = adapter.start(net as never, { name: 'test' });
  running.push(play);
  replay(net);
  assert.equal(typeof play.observe(), 'object');
  assert.ok(Array.isArray(play.events()));
});

/** Give the public adapter a real recorded car, then use the same crew/detail messages a host sends. */
function panelMechanic(rules = mechanicRules) {
  const net = new FakeNet();
  const s = session(net, { mechanic: rules });
  replay(net);
  const observed = s.observe();
  const car = asObject(observed['you'])['car'];
  assert.equal(typeof car, 'number');
  assert.ok(typeof car === 'number');
  const cars = observed['cars'];
  assert.ok(Array.isArray(cars));
  const crew = cars.map((): unknown[] => ['bot', 'bot', 'bot', 'bot']);
  const row = crew[car];
  assert.ok(row);
  row[3] = { p: net.id, i: 0 };
  net.deliver(HOST_SEAT, MSG.crew, new TextEncoder().encode(JSON.stringify(crew)));
  let detail: Record<string, unknown> | undefined;
  for (const message of FIX.messages) {
    if (message.type !== MSG.detail) continue;
    const candidate = asObject(JSON.parse(new TextDecoder().decode(bytes(message.b64))) as unknown);
    if (candidate['i'] === car) detail = candidate;
  }
  assert.ok(detail);
  const current = detail;
  const state = createBodyworkState();
  function deliver(bodywork: unknown = bodyworkDetail(state), parts: unknown = 0x3f): void {
    current['bodywork'] = bodywork;
    current['parts'] = parts;
    net.deliver(HOST_SEAT, MSG.detail, new TextEncoder().encode(JSON.stringify(current)));
  }
  function loosen(name: BodyPanel, generation = 1): string {
    state[name] = { wear: 9, looseSince: 10, generation };
    return panelRepairId({ name, generation });
  }
  function jobs(): Record<string, unknown>[] {
    const result = s.observe()['jobs'];
    assert.ok(Array.isArray(result));
    return result
      .map(asObject)
      .filter((job) => typeof job['id'] === 'string' && job['id'].startsWith('panel:'));
  }
  return { net, s, state, deliver, loosen, jobs };
}

test('mechanic agents discover only attached loose panels with bounded generation-specific IDs', () => {
  const f = panelMechanic();
  for (const name of BODY_PANELS) f.loosen(name, 4);
  // Existing detail-mask order: hood bit0, trunk bit1, left front door bit2.
  f.deliver(undefined, (1 << 0) | (1 << 2));
  assert.deepEqual(
    f.jobs().map((job) => job['id']),
    ['panel:car_hood:4', 'panel:L_Door_Front:4'],
  );
  assert.match(String(f.jobs()[1]?.['what']), /Left front door/);
  for (const id of [
    'panel:constructor:4',
    'panel:__proto__:4',
    'panel:car_hood:3',
    'panel:car_hood:4.0',
    'panel:car_hood:Infinity',
  ])
    assert.equal(asObject(f.s.act({ job: id }))['ok'], false, id);
  for (const mask of [null, -1, 3.5, '63', 64, 1e9]) {
    f.deliver(undefined, mask);
    assert.deepEqual(f.jobs(), [], `Malformed mask ${String(mask)} cannot invent attached panels`);
  }
});

test('panel quick repairs wait for their duration and host confirmation before reporting success', () => {
  const f = panelMechanic();
  const id = f.loosen('car_hood');
  f.deliver();
  assert.deepEqual(f.s.act({ job: id }), { ok: true });
  f.net.sent = [];
  tick(f.s, 1400);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [],
  );
  tick(f.s, 200);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [{ i: 0, a: 'fix', task: id }],
  );
  const pending = f.s.observe();
  assert.equal(asObject(pending['working'])['pending'], true);
  assert.ok(!f.s.takeEvents().some((event) => event['type'] === 'job' && event['done'] === true));
  tick(f.s, 1200);
  assert.equal(
    f.net.asks().filter((ask) => ask['a'] === 'fix').length,
    1,
    'No duplicate before the existing request gap',
  );
  // A mild hit after the host repair may add wear before its next detail, without loosening again.
  f.state.car_hood = { wear: 2, looseSince: null, generation: 1 };
  f.deliver();
  tick(f.s, 33);
  const confirmed = f.s.observe();
  assert.equal(confirmed['working'], null);
  assert.ok(f.s.takeEvents().some((event) => event['job'] === id && event['done'] === true));
  tick(f.s, 5000);
  assert.equal(f.net.asks().filter((ask) => ask['a'] === 'fix').length, 1, 'Confirmation ends retries');
});

test('a room’s longer panel repair minimum overrides the default quick-action duration', () => {
  const rules = structuredClone(mechanicRules);
  rules.games.nuts.panelTime = 3;
  const f = panelMechanic(rules);
  const id = f.loosen('trunk');
  f.deliver();
  f.s.act({ job: id });
  f.net.sent = [];
  tick(f.s, 2900);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [],
  );
  tick(f.s, 200);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [{ i: 0, a: 'fix', task: id }],
  );
});

test('panel quick-repair timing also includes all direction and tightening actions', () => {
  const rules = structuredClone(mechanicRules);
  rules.games.nuts.panelTime = 0.5;
  rules.games.nuts.panelNuts = 4;
  rules.games.nuts.panelTaps = 3;
  const f = panelMechanic(rules);
  const id = f.loosen('trunk');
  f.deliver();
  assert.deepEqual(f.s.act({ job: id }), { ok: true });
  f.net.sent = [];
  tick(f.s, 2000);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [],
    'Picking plus four nuts and three taps needs at least 2.1 s',
  );
  tick(f.s, 200);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [{ i: 0, a: 'fix', task: id }],
  );
});

test('a detached or already repaired panel cancels an in-flight agent job without a fix request', () => {
  for (const detached of [false, true]) {
    const f = panelMechanic();
    const id = f.loosen('L_Door_Front');
    f.deliver();
    assert.deepEqual(f.s.act({ job: id }), { ok: true });
    if (detached) f.deliver(undefined, 0x3f & ~(1 << 2));
    else {
      f.state.L_Door_Front = { wear: 0, looseSince: null, generation: 1 };
      f.deliver();
    }
    f.net.sent = [];
    tick(f.s, 2000);
    assert.deepEqual(
      f.net.asks().filter((ask) => ask['a'] === 'fix'),
      [],
    );
    assert.equal(f.s.observe()['working'], null);
    assert.equal(asObject(f.s.act({ job: id }))['ok'], false);
  }
});

test('an old agent job cannot repair a newly loosened generation of the same attached panel', () => {
  const f = panelMechanic();
  const old = f.loosen('R_Door_Back', 1);
  f.deliver();
  f.s.act({ job: old });
  tick(f.s, 700);
  const current = f.loosen('R_Door_Back', 2);
  f.deliver();
  f.net.sent = [];
  tick(f.s, 1000);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [],
  );
  assert.equal(f.s.observe()['working'], null);
  assert.equal(asObject(f.s.act({ job: old }))['ok'], false);
  assert.deepEqual(f.s.act({ job: current }), { ok: true });
  tick(f.s, 1400);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [],
  );
  tick(f.s, 200);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [{ i: 0, a: 'fix', task: current }],
  );
});

test('optional or malformed bodywork never creates agent jobs, while valid prior generation survives bad updates', () => {
  const f = panelMechanic();
  assert.deepEqual(f.jobs(), [], 'Older host details omit bodywork');
  const malformed: unknown[] = [
    null,
    {},
    { constructor: { looseSince: 0, generation: 1 } },
    { wear: [9], looseSince: [0], generation: [1] },
    { wear: Array(6).fill(9), looseSince: Array(6).fill(0), generation: Array(6).fill(-1) },
    { wear: Array(6).fill(9), looseSince: Array(6).fill(0), generation: Array(6).fill('1') },
  ];
  for (const value of malformed) {
    f.deliver(value);
    assert.deepEqual(f.jobs(), []);
  }
  const id = f.loosen('car_hood', 7);
  f.deliver();
  f.deliver({ wear: Array(6).fill(9), looseSince: Array(6).fill(0), generation: [] });
  assert.deepEqual(
    f.jobs().map((job) => job['id']),
    [id],
    'Bad detail preserves the last valid authoritative state',
  );
  replay(f.net);
  assert.deepEqual(f.jobs(), [], 'A fresh round does not carry old panel generations');
});

test('a panel fix rejected by timing jitter retries the same job only while host detail still needs it', () => {
  const f = panelMechanic();
  const id = f.loosen('L_Door_Front');
  f.deliver();
  f.s.act({ job: id });
  f.net.sent = [];
  tick(f.s, 1600);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [{ i: 0, a: 'fix', task: id }],
  );
  tick(f.s, 1600);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [
      { i: 0, a: 'fix', task: id },
      { i: 0, a: 'fix', task: id },
    ],
  );
  assert.equal(asObject(f.s.observe()['working'])['pending'], true);
  f.state.L_Door_Front = { wear: 0, looseSince: null, generation: 1 };
  f.deliver();
  tick(f.s, 5000);
  assert.equal(f.net.asks().filter((ask) => ask['a'] === 'fix').length, 2);
  assert.equal(f.s.observe()['working'], null);
});

test('pending panel retries expire within eight seconds without claiming a repair', () => {
  const f = panelMechanic();
  const id = f.loosen('trunk');
  f.deliver();
  f.s.act({ job: id });
  f.net.sent = [];
  tick(f.s, 1600);
  tick(f.s, 12000);
  const attempts = f.net.asks().filter((ask) => ask['a'] === 'fix');
  assert.ok(
    attempts.length >= 2 && attempts.length <= 6,
    'Retries stay bounded by the existing gap and eight-second pending window',
  );
  assert.ok(attempts.every((ask) => ask['task'] === id));
  const observed = f.s.observe();
  assert.equal(observed['working'], null);
  const events = f.s.takeEvents();
  assert.ok(!events.some((event) => event['job'] === id && event['done'] === true));
  assert.ok(
    events.some((event) => event['job'] === id && event['why'] === 'the host did not confirm the repair'),
  );
  tick(f.s, 10000);
  assert.equal(f.net.asks().filter((ask) => ask['a'] === 'fix').length, attempts.length);
});

test('detachment and new generations cancel pending retries without crediting stale work', () => {
  for (const detached of [false, true]) {
    const f = panelMechanic();
    const id = f.loosen('car_hood', 1);
    f.deliver();
    f.s.act({ job: id });
    tick(f.s, 1600);
    if (detached) f.deliver(undefined, 0x3e);
    else {
      f.loosen('car_hood', 2);
      f.deliver();
    }
    f.net.sent = [];
    tick(f.s, 7000);
    assert.deepEqual(
      f.net.asks().filter((ask) => ask['a'] === 'fix'),
      [],
    );
    const observed = f.s.observe();
    assert.equal(observed['working'], null);
    assert.ok(!f.s.takeEvents().some((event) => event['job'] === id && event['done'] === true));
  }
});

test('stopping an agent cancels its pending panel acknowledgement and any queued retry tick', () => {
  const f = panelMechanic();
  const id = f.loosen('car_hood');
  f.deliver();
  f.s.act({ job: id });
  tick(f.s, 1600);
  f.s.stop();
  f.net.sent = [];
  tick(f.s, 10000);
  assert.deepEqual(f.net.asks(), []);
  assert.equal(f.s.observe()['working'], null);
});

test('a new round cancels a pending panel acknowledgement without retrying the old round’s task', () => {
  const f = panelMechanic();
  const id = f.loosen('car_hood');
  f.deliver();
  f.s.act({ job: id });
  tick(f.s, 1600);
  replay(f.net);
  f.net.sent = [];
  tick(f.s, 10000);
  assert.deepEqual(
    f.net.asks().filter((ask) => ask['a'] === 'fix'),
    [],
  );
  assert.equal(f.s.observe()['working'], null);
});
