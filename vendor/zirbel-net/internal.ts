/** For the hub and tests: the wire protocol's building blocks. Games use the main entry point. */
export { Emitter } from './emitter.ts';
export { toBytes, utf8len, utf8read, utf8write } from './codec.ts';
export { clock, report, setErrorHandler } from './env.ts';
export { APP, Cursor, ERR, NAME, SYS } from './protocol.ts';
export { LocalNet, type Outbox } from './local-net.ts';
export { readHello, readWelcome, replaceWelcomeToken, systemTypes, writeHello, type Hello, type Welcome } from './bridge.ts';
