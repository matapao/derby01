import { G } from '../state.ts';
import { getSession, mySeat, peerSeats } from './context.ts';
import { MSG, type SeatTaker } from './protocol.ts';
const ALL = 0;
const RUNNING = new Set(['countdown', 'playing', 'over']);

export function crew(): SeatTaker[][] {
  return G.cars.map((car) =>
    car.occ.map((o): SeatTaker => {
      if (!o) return 'empty';
      if (o.kind !== 'human' || !o.h) return 'bot';
      return o.h.remote === true
        ? { p: o.h.peer, i: o.h.peerIndex }
        : { p: mySeat(), i: Math.max(0, G.humans.indexOf(o.h)) };
    }),
  );
}

let lastCrew = '';
/** Who sits where changed: everyone hears. Or just one screen, which asked, whether or not it changed. */
export function sendCrew(to = ALL): void {
  const s = getSession();
  if (!s || !peerSeats().length || !RUNNING.has(G.state)) return;
  const json = JSON.stringify(crew());
  if (to === ALL) {
    if (json === lastCrew) return;
    lastCrew = json;
  }
  s.net.send(to, MSG.crew, json);
}

export function resetCrew(json = ''): void {
  lastCrew = json;
}
