import type { ControlFrame } from './input.ts';
import { clamp } from './numbers.ts';
import {
  advanceMiniGame,
  startMiniGame,
  type MechanicState,
  type MechanicTask,
  type MiniCar,
  type MiniGameKind,
  type MiniGames,
} from './minigames.ts';
import type { ParticipantState } from './participants.ts';
import { precisionAction, precisionResult } from './minigame-precision.ts';

export const newMechanicState = (): MechanicState => ({
  sel: null,
  game: null,
  pending: null,
  flash: 0,
  msg: '',
  msgBad: false,
  tasks: [],
});
interface MechanicDependencies<C extends MiniCar, H extends ParticipantState<C>> {
  games: MiniGames<C>;
  tasks(car: C): MechanicTask[];
  gameType(task: MechanicTask): MiniGameKind;
  canFuel(): number;
  fix(human: H, task: MechanicTask): void | 'pending';
  fixStatus?(human: H, task: MechanicTask): 'waiting' | 'done' | 'cancelled';
  poured(human: H, amount: number): void;
  sound(kind: 'click' | 'ok' | 'fail'): void;
  precision?(human: H, correct: number, attempts: number): void;
}
/** Selection, cancellation and consumption are shared rules; authority and presentation are adapters. */
export function createMechanicController<C extends MiniCar, H extends ParticipantState<C>>(
  deps: MechanicDependencies<C, H>,
) {
  function confirmJob(mechanic: MechanicState): void {
    mechanic.pending = null;
    mechanic.flash = 1.2;
    mechanic.msg = 'FIXED!';
    mechanic.msgBad = false;
    deps.sound('ok');
  }
  function failPending(mechanic: MechanicState, message: string): void {
    mechanic.pending = null;
    mechanic.flash = 1.4;
    mechanic.msg = message;
    mechanic.msgBad = true;
    deps.sound('fail');
  }
  function dropJob(human: H): void {
    const mechanic = human.mech;
    if (!mechanic) return;
    mechanic.pending = null;
    const game = mechanic.game;
    if (!game) return;
    if (game.type === 'pour' && game.can < deps.canFuel()) deps.fix(human, game.task);
    mechanic.game = null;
  }
  function updateHumanMechanic(human: H, input: ControlFrame, dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const car = human.car,
      mechanic = (human.mech ||= newMechanicState());
    const tasks = deps.tasks(car);
    mechanic.tasks = tasks;
    mechanic.flash = Math.max(0, mechanic.flash - dt);
    const pending = mechanic.pending;
    if (pending) {
      if (input.bP) {
        dropJob(human);
        mechanic.msg = '';
        deps.sound('click');
        return;
      }
      if (!deps.fixStatus) throw new Error('Pending mechanic repairs require a fixStatus adapter');
      const status = deps.fixStatus(human, pending.task);
      switch (status) {
        case 'done':
          confirmJob(mechanic);
          return;
        case 'cancelled':
          failPending(mechanic, 'Panel lost — repair cancelled');
          return;
        case 'waiting':
          break;
        default: {
          const exhaustive: never = status;
          throw new Error(`Unknown mechanic repair status: ${exhaustive}`);
        }
      }
      pending.elapsed += dt;
      pending.retry += dt;
      if (pending.elapsed >= 8) {
        failPending(mechanic, 'Could not confirm — try again');
      } else if (pending.retry >= 0.5) {
        // Never burst missed retries after a stalled frame, and always retain the original task token.
        pending.retry = 0;
        deps.fix(human, pending.task);
      }
      return;
    }
    const game = mechanic.game;
    if (game) {
      const task = tasks.find((item) => item.id === game.taskId) ?? (game.type === 'pour' ? game.task : null);
      if (!task || input.bP) {
        dropJob(human);
        if (input.bP) deps.sound('click');
        return;
      }
      const fuel = car.sys.fuel;
      const action = precisionAction(game, input, dt);
      const done = advanceMiniGame(deps.games, game, input, dt, car);
      if (action) deps.precision?.(human, precisionResult(action, game), 1);
      if (car.sys.fuel !== fuel) deps.poured(human, car.sys.fuel - fuel);
      if (done) {
        const result = deps.fix(human, task);
        mechanic.game = null;
        if (result === 'pending') {
          if (!deps.fixStatus) throw new Error('Pending mechanic repairs require a fixStatus adapter');
          mechanic.pending = { task, elapsed: 0, retry: 0 };
          mechanic.msg = 'Waiting for repair…';
          mechanic.msgBad = false;
        } else confirmJob(mechanic);
      }
      return;
    }
    const picked = input.pick ? tasks.findIndex((task) => task.id === input.pick) : -1;
    if (input.pick && picked < 0) return;
    let index =
      picked >= 0
        ? picked
        : Math.max(
            0,
            tasks.findIndex((task) => task.id === mechanic.sel),
          );
    if (input.tap === 'up' || input.wheel < 0) index--;
    if (input.tap === 'down' || input.wheel > 0) index++;
    index = clamp(index, 0, Math.max(0, tasks.length - 1));
    const task = tasks[index];
    mechanic.sel = task?.id ?? null;
    if (!input.aP || !task) return;
    if (task.need) {
      mechanic.flash = 1.4;
      mechanic.msg = `NO ${task.need.toUpperCase()}!`;
      mechanic.msgBad = true;
      deps.sound('fail');
      return;
    }
    mechanic.game = startMiniGame(deps.games, deps.gameType(task), task, car);
    deps.sound('click');
  }
  return { dropJob, updateHumanMechanic };
}
