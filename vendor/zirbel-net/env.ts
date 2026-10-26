/**
 * The parts of the JavaScript environment zirbel-net uses, looked up at run time. The same code runs in
 * browsers, Electron, workers and Node 22+, so it depends on neither the DOM nor Node type
 * declarations: this is everything it touches.
 */

/** What zirbel-net needs from a WebSocket: the browser's, Node's, or one passed in. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface Env {
  readonly WebSocket?: WebSocketConstructor;
  readonly sessionStorage?: StorageLike;
  readonly location?: { readonly protocol: string; readonly host: string; readonly pathname?: string; readonly search?: string; assign?(url: string): void };
  readonly document?: Listenable & { readonly visibilityState?: string };
  readonly addEventListener?: Listenable['addEventListener'];
  readonly removeEventListener?: Listenable['removeEventListener'];
  readonly performance: { now(): number };
  readonly crypto: { getRandomValues<T extends Uint8Array>(array: T): T };
  readonly TextDecoder: new () => { decode(input: Uint8Array): string };
  /** For the solo room (solo.ts): the game's zirbel.json. */
  readonly fetch?: (url: string, init?: { readonly cache?: string }) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

// globalThis arrived in 2019 (Safari 12.1, Chrome 71, Firefox 65); self is there in every page and
// worker, and global in Node.
declare const self: unknown, global: unknown;
export const env = (typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : global) as unknown as Env;

/** Milliseconds from a monotonic clock. */
export function clock(): number {
  return env.performance.now();
}

let errorHandler = (error: unknown): void => {
  env.setTimeout(() => {
    throw error;
  }, 0);
};

/** Reports a listener's error. By default it is rethrown outside the current call stack: it shows in the console but can't break the caller's loop. */
export function report(error: unknown): void {
  errorHandler(error);
}

/** Where listener errors go instead: the hub's authority workers log them rather than crash. */
export function setErrorHandler(handler: (error: unknown) => void): void {
  errorHandler = handler;
}

/** n random bytes as hex. */
export function randomHex(n: number): string {
  const bytes = env.crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const b of bytes) s += (b + 256).toString(16).slice(1);
  return s;
}

/** sessionStorage if this environment has a usable one: it is missing in Node, and blocked in some private modes and sandboxed frames. */
export function sessionStore(): StorageLike | null {
  try {
    const s = env.sessionStorage;
    if (!s) return null;
    s.setItem('zirbel-net:t', '1');
    s.removeItem('zirbel-net:t');
    return s;
  } catch {
    return null;
  }
}
