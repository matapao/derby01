import type { ControlReader } from './input.ts';
import type { GameStates, MechanicState } from './minigames.ts';

/** Gameplay/session fields shared by local and remote participants; no HUD or camera dependency. */
export interface ParticipantState<C> extends ControlReader {
  id: number;
  name: string;
  tag: string;
  car: C;
  dead: boolean;
  hintT?: number;
  localIndex?: number;
  devSeq?: number;
  mech?: MechanicState | null;
  jamGame?: GameStates['unjam'] | null;
  aim?: { yaw: number; pitch: number } | null;
  poured?: number;
  spilled?: boolean;
  pourT?: number;
}
export function participantState<C>(id: number, device: string, car: C, seat: number): ParticipantState<C> {
  return {
    id,
    name: `P${id + 1}`,
    tag: `P${id + 1}`,
    device,
    car,
    seat,
    dead: false,
    mech: null,
    jamGame: null,
    aim: null,
  };
}
/** Changing seats must not carry a job, jam sequence or predicted aim into the new role. */
export function resetSeatState<C>(human: ParticipantState<C>, car: C, seat: number): void {
  human.car = car;
  human.seat = seat;
  human.mech = null;
  human.jamGame = null;
  human.aim = null;
  human.mouseSteer = 0;
  human.stickDir = null;
  human.flickCd = 0;
  human.hintT = 6;
}
