/**
 * @zirbel/net: the multiplayer transport for zirbel games.
 *
 *   import { connect, launchParams, ALL, HOST } from '@zirbel/net';
 *
 *   const net = connect({ ...launchParams(), loopback: true });   // game from /<id>/, ?room=…&key=… from the lobby
 *   net.on('message', (from, type, r) => { if (type === 1) { const x = r.f32(); } });
 *   net.send(ALL, 2, 'start');                     // reliable, ordered
 *   net.stream(HOST, 1, net.begin().u16(seq).q16(x, 0, 960));   // unreliable, latest wins
 *
 * See docs/game-guide.md.
 */
export { connect, launchParams, type ClientEvents, type ConnectOptions, type Connection, type Lane, type LaunchParams, type Stats } from './client.ts';
export { Reader, Writer, type Payload } from './codec.ts';
export { clock } from './env.ts';
export type { StorageLike, WebSocketConstructor, WebSocketLike } from './env.ts';
export { DATA_FILE, players, type Authority, type GameEvents, type GameNet, type OpenInfo, type Revision, type RoomInfo } from './game.ts';
export { Interp, lerp, type Sample } from './interp.ts';
export { ALL, HOST, LIMITS, MAX_SEAT, MAX_TYPE, SERVER, VERSION, playerName, seqNewer, seqOk } from './protocol.ts';
