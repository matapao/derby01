/**
 * Binary codec: little-endian numbers, LEB128 varints, UTF-8 strings. Writers grow as needed and
 * are meant to be reused; readers never read past their end.
 */
import { env } from './env.ts';

const EMPTY = new Uint8Array(0);

// Floats go through one shared 8-byte scratch buffer: no DataView or allocation per value.
const SCRATCH = new ArrayBuffer(8);
const F32 = new Float32Array(SCRATCH);
const F64 = new Float64Array(SCRATCH);
const FB = new Uint8Array(SCRATCH);
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** UTF-8 byte length of s. A lone surrogate counts as U+FFFD, as TextEncoder writes it. */
export function utf8len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Writes s as UTF-8 at b[p], which must have room for utf8len(s) bytes, and returns the end. */
export function utf8write(s: string, b: Uint8Array, p: number): number {
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) b[p++] = c;
    else if (c < 0x800) {
      b[p++] = 0xc0 | (c >> 6);
      b[p++] = 0x80 | (c & 63);
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      b[p++] = 0xf0 | (c >> 18);
      b[p++] = 0x80 | ((c >> 12) & 63);
      b[p++] = 0x80 | ((c >> 6) & 63);
      b[p++] = 0x80 | (c & 63);
    } else {
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
      b[p++] = 0xe0 | (c >> 12);
      b[p++] = 0x80 | ((c >> 6) & 63);
      b[p++] = 0x80 | (c & 63);
    }
  }
  return p;
}

let decoder: { decode(input: Uint8Array): string } | null = null;

/** Decodes UTF-8; invalid sequences become U+FFFD. */
export function utf8read(b: Uint8Array, start: number, end: number): string {
  if (end <= start) return '';
  if (end - start <= 32) {
    // Short ASCII (game and room names, most labels): cheaper than a decoder call.
    let s = '';
    let i = start;
    for (; i < end; i++) {
      const c = b[i]!;
      if (c >= 0x80) break;
      s += String.fromCharCode(c);
    }
    if (i === end) return s;
  }
  decoder ??= new env.TextDecoder();
  return decoder.decode(b.subarray(start, end));
}

/** A growable byte writer. Every method chains. */
export class Writer {
  buf: Uint8Array;
  pos = 0;

  constructor(size = 256) {
    this.buf = new Uint8Array(size);
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  /** Makes room for n more bytes. */
  ensure(n: number): this {
    const need = this.pos + n;
    if (need > this.buf.length) {
      let len = this.buf.length * 2 || 256;
      while (len < need) len *= 2;
      const next = new Uint8Array(len);
      next.set(this.buf.subarray(0, this.pos));
      this.buf = next;
    }
    return this;
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.pos++] = v;
    return this;
  }

  i8(v: number): this {
    return this.u8(v);
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u16(v: number): this {
    this.ensure(2);
    const b = this.buf, p = this.pos;
    b[p] = v;
    b[p + 1] = v >>> 8;
    this.pos = p + 2;
    return this;
  }

  i16(v: number): this {
    return this.u16(v);
  }

  u32(v: number): this {
    this.ensure(4);
    const b = this.buf, p = this.pos;
    b[p] = v;
    b[p + 1] = v >>> 8;
    b[p + 2] = v >>> 16;
    b[p + 3] = v >>> 24;
    this.pos = p + 4;
    return this;
  }

  i32(v: number): this {
    return this.u32(v);
  }

  f32(v: number): this {
    this.ensure(4);
    const b = this.buf, p = this.pos;
    F32[0] = v;
    if (LE) for (let i = 0; i < 4; i++) b[p + i] = FB[i]!;
    else for (let i = 0; i < 4; i++) b[p + i] = FB[3 - i]!;
    this.pos = p + 4;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    const b = this.buf, p = this.pos;
    F64[0] = v;
    if (LE) for (let i = 0; i < 8; i++) b[p + i] = FB[i]!;
    else for (let i = 0; i < 8; i++) b[p + i] = FB[7 - i]!;
    this.pos = p + 8;
    return this;
  }

  /** Unsigned LEB128 for whole numbers 0 to 2^53 - 1: one byte below 128. */
  varint(v: number): this {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('zirbel-net: varint takes a whole number from 0 to 2^53 - 1, got ' + v);
    this.ensure(8);
    const b = this.buf;
    let p = this.pos;
    while (v >= 128) {
      b[p++] = (v & 127) | 128;
      v = Math.floor(v / 128);
    }
    b[p++] = v;
    this.pos = p;
    return this;
  }

  /** Signed varint (zigzag): small negative numbers stay small. */
  svarint(v: number): this {
    return this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  /** A string: its UTF-8 byte length as a varint, then the bytes. */
  str(s: string): this {
    const n = utf8len(s);
    this.varint(n).ensure(n);
    this.pos = utf8write(s, this.buf, this.pos);
    return this;
  }

  /** Bytes as they are, no length. */
  raw(bytes: Uint8Array): this {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
    return this;
  }

  /** Bytes with their length as a varint. */
  bytes(bytes: Uint8Array): this {
    return this.varint(bytes.length).raw(bytes);
  }

  /** v in [min, max] as 16 bits: a position to about 1/65535 of the range. */
  q16(v: number, min: number, max: number): this {
    return this.u16(Math.round(unit(v, min, max) * 65535));
  }

  /** v in [min, max] as 8 bits. */
  q8(v: number, min: number, max: number): this {
    return this.u8(Math.round(unit(v, min, max) * 255));
  }

  /** What has been written so far, as a view (no copy). */
  view(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

function unit(v: number, min: number, max: number): number {
  const t = (v - min) / (max - min);
  return t > 0 ? (t < 1 ? t : 1) : 0; // NaN becomes 0
}

/**
 * Reads buf from pos up to end. Reading past the end yields zeros (and empty strings) and makes
 * overrun true, so a malformed message can't throw in the middle of a game loop: check overrun,
 * or left(), where it matters.
 */
export class Reader {
  buf: Uint8Array = EMPTY;
  pos = 0;
  end = 0;

  constructor(buf?: Uint8Array, pos = 0, end?: number) {
    if (buf) this.set(buf, pos, end);
  }

  set(buf: Uint8Array, pos = 0, end = buf.length): this {
    this.buf = buf;
    this.pos = pos;
    this.end = Math.min(end, buf.length);
    return this;
  }

  /** Bytes not yet read. */
  left(): number {
    return this.end > this.pos ? this.end - this.pos : 0;
  }

  /** True once a read went past the end: everything read from then on was zeros. */
  get overrun(): boolean {
    return this.pos > this.end;
  }

  skip(n: number): this {
    this.pos += n;
    return this;
  }

  u8(): number {
    const p = this.pos++;
    return p < this.end ? this.buf[p]! : 0;
  }

  i8(): number {
    return (this.u8() << 24) >> 24;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    const b = this.buf, p = this.pos;
    this.pos = p + 2;
    return p + 2 <= this.end ? b[p]! | (b[p + 1]! << 8) : 0;
  }

  i16(): number {
    return (this.u16() << 16) >> 16;
  }

  i32(): number {
    const b = this.buf, p = this.pos;
    this.pos = p + 4;
    return p + 4 <= this.end ? b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24) : 0;
  }

  u32(): number {
    return this.i32() >>> 0;
  }

  f32(): number {
    const b = this.buf, p = this.pos;
    this.pos = p + 4;
    if (p + 4 > this.end) return 0;
    if (LE) for (let i = 0; i < 4; i++) FB[i] = b[p + i]!;
    else for (let i = 0; i < 4; i++) FB[3 - i] = b[p + i]!;
    return F32[0]!;
  }

  f64(): number {
    const b = this.buf, p = this.pos;
    this.pos = p + 8;
    if (p + 8 > this.end) return 0;
    if (LE) for (let i = 0; i < 8; i++) FB[i] = b[p + i]!;
    else for (let i = 0; i < 8; i++) FB[7 - i] = b[p + i]!;
    return F64[0]!;
  }

  varint(): number {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const c = this.u8();
      v += (c & 127) * mul;
      if (c < 128) return v;
      mul *= 128;
    }
    return v;
  }

  svarint(): number {
    const v = this.varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  str(): string {
    const n = this.varint();
    const p = this.pos;
    this.pos = p + n;
    return utf8read(this.buf, p, Math.min(p + n, this.end));
  }

  /** n bytes as a view (no copy). Copy them if you keep them after the message handler returns. */
  raw(n: number): Uint8Array {
    const p = this.pos;
    this.pos = p + n;
    return this.buf.subarray(Math.min(p, this.end), Math.min(p + n, this.end));
  }

  bytes(): Uint8Array {
    return this.raw(this.varint());
  }

  q16(min: number, max: number): number {
    return min + (this.u16() / 65535) * (max - min);
  }

  q8(min: number, max: number): number {
    return min + (this.u8() / 255) * (max - min);
  }

  /** The bytes not yet read, as a view. */
  rest(): Uint8Array {
    return this.raw(this.left());
  }

  /** The bytes not yet read, as UTF-8 text. */
  text(): string {
    const p = this.pos;
    this.pos = Math.max(p, this.end);
    return utf8read(this.buf, p, this.end);
  }
}

/** What send() and stream() take. */
export type Payload = Writer | Uint8Array | ArrayBuffer | ArrayBufferView | string;

/** The bytes of a non-string payload, as a view (no copy). */
export function toBytes(data: Exclude<Payload, string> | null | undefined): Uint8Array {
  if (data == null) return EMPTY;
  if (data instanceof Uint8Array) return data;
  // A Writer, also one from another copy of this module (a game's authority imports its own).
  if (isWriter(data)) return data.buf.subarray(0, data.pos);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // instanceof fails for buffers from another realm (an iframe, a worker): ask for the tag instead.
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  throw new TypeError('zirbel-net: data must be a Writer, Uint8Array, ArrayBuffer, typed array or string');
}

function isWriter(data: object): data is Writer {
  if (data instanceof Writer) return true;
  const w = data as Partial<Writer>;
  return w.buf instanceof Uint8Array && typeof w.pos === 'number' && typeof w.view === 'function';
}
