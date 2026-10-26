/**
 * derby01's messages over zirbel-net (ids are part of the wire format: append only).
 *
 *   host → everyone  hello, setup, round, crew, flow, detail (reliable, JSON); fx (reliable, binary);
 *                    snap (unreliable, binary, 30 a second)
 *   player → host    ctrl (unreliable, binary, 30 a second); ask (reliable, JSON)
 */
export const MSG = {
  hello: 1,
  setup: 2,
  round: 3,
  crew: 4,
  flow: 5,
  detail: 6,
  fx: 7,
  snap: 8,
  radio: 9,
  ctrl: 20,
  ask: 21,
} as const;

/** Bumped when screens of different versions can't play together; hello carries it. */
export const PROTOCOL = 2;

export const SNAPS_PER_SECOND = 30;
export const CONTROLS_PER_SECOND = 30;
/** How far behind the host other screens draw the cars, to have two snapshots to blend between. */
export const DRAW_DELAY_MS = 90;

/** Who sits in a seat: a bot, nobody, or a player (their seat in the room, and which of that screen's players). */
export type SeatTaker = 'bot' | 'empty' | { p: number; i: number };

// The hub counts in words ("Player Twenty-One"), read back here for the short form.
const WORDS =
  'Zero One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen Fifteen Sixteen Seventeen Eighteen Nineteen'.split(
    ' ',
  );
const COUNT = new Map<string, number>([
  ...WORDS.map((w, n): [string, number] => [w, n]),
  ...'Twenty Thirty Forty Fifty Sixty Seventy Eighty Ninety'
    .split(' ')
    .map((w, n): [string, number] => [w, 20 + 10 * n]),
]);

/**
 * A player's name on every screen: what the hub calls their screen's seat ("Player Three", "Bot One"),
 * with a letter after it for that screen's second player and on ("Player Three B").
 */
export function playerName(seatName: string, i: number): string {
  return i > 0 ? `${seatName} ${String.fromCharCode(65 + i)}` : seatName;
}

/** Its short form, for the tags over the cars and the kill feed: "P3", "B1", "P3b". A name the hub didn't count stays whole. */
export function playerTag(seatName: string, i: number): string {
  const m = /^(Player|Bot) (.+)$/.exec(seatName);
  let n = 0;
  const label = m?.[2];
  const kind = m?.[1];
  for (const w of label?.split(/[ -]/) ?? []) {
    const v = w === 'Hundred' ? -1 : /^\d+$/.test(w) ? Number(w) : COUNT.get(w);
    if (v === undefined) {
      n = 0;
      break;
    }
    n = v < 0 ? n * 100 : n + v;
  }
  return (kind && n > 0 ? kind.charAt(0) + n : seatName) + (i > 0 ? String.fromCharCode(97 + i) : '');
}

/** Offline, the players on this screen are Player One, Player Two… in the order they sit. */
export const localName = (i: number): string => `Player ${WORDS[i + 1] ?? i + 1}`;

/** In the host's setup, a seat taken by a player on another screen: "peer:3". */
export const PEER_SLOT = 'peer:';
/** That player's seat in the room, or 0 when the slot isn't one of theirs. */
export const peerOfSlot = (slot: string): number =>
  slot.startsWith(PEER_SLOT) ? Number(slot.slice(PEER_SLOT.length)) | 0 : 0;

/** JSON from another screen, or null. Never throws. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
export const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const asNumber = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
export const asInt = (v: unknown, lo: number, hi: number, dflt: number): number =>
  Math.round(asNumber(v, lo, hi, dflt));

/** A seat taker read from another screen. */
export function asSeatTaker(v: unknown): SeatTaker {
  if (v === 'bot' || v === 'empty') return v;
  const o = asObject(v);
  const p = asInt(o['p'], 0, 255, 0),
    i = asInt(o['i'], 0, 3, 0);
  return p > 0 ? { p, i } : 'empty';
}
