import type { Role } from './role.ts';
import { MSG } from './protocol.ts';

interface RoleDependencies {
  current(): Role;
  set(role: Role): void;
  replicaUi(on: boolean): void;
  clock(): void;
  hostStart(takeover: boolean): void;
  hostStop(): void;
  hostLost(): void;
  replicaStart(): void;
  replicaStop(): void;
  toMenu(): void;
}
/** Order matters: stop the previous role, publish the new role, then initialize its state. */
export function createRoleTransitions(deps: RoleDependencies) {
  function decide(isHost: boolean): void {
    const next = isHost ? 'host' : 'replica',
      previous = deps.current();
    if (next === previous) return;
    if (previous === 'host') deps.hostStop();
    else if (previous === 'replica') deps.replicaStop();
    deps.set(next);
    deps.replicaUi(next === 'replica');
    if (next === 'host') deps.hostStart(previous === 'replica');
    else deps.replicaStart();
    deps.clock();
  }
  function disconnected(): void {
    const previous = deps.current();
    deps.set('offline');
    deps.replicaUi(false);
    if (previous === 'host') deps.hostLost();
    else if (previous === 'replica') {
      deps.replicaStop();
      deps.toMenu();
    }
    deps.clock();
  }
  return { decide, disconnected };
}
interface MessageHandlers<T> {
  hostControls(from: number, message: T): void;
  hostAsk(from: number, message: T): void;
  replicaMessage(type: number, message: T): void;
}
/** A replica accepts state only from the authority. Offline screens consume no room messages. */
export function routeRoomMessage<T>(
  role: Role,
  from: number,
  host: number,
  type: number,
  message: T,
  handlers: MessageHandlers<T>,
): void {
  if (role === 'host') {
    if (type === MSG.ctrl) handlers.hostControls(from, message);
    else if (type === MSG.ask) handlers.hostAsk(from, message);
  } else if (role === 'replica' && from === host) handlers.replicaMessage(type, message);
}
/** Old connection callbacks must not change a replacement session. */
export function whenActive<A extends unknown[]>(
  active: () => boolean,
  handler: (...args: A) => void,
): (...args: A) => void {
  return (...args) => {
    if (active()) handler(...args);
  };
}
