export interface PouringPlayer {
  localIndex?: number;
  poured?: number;
  spilled?: boolean;
}
export type PlayerRequest =
  | { a: 'switch'; to?: 1 | 2 | 3 }
  | { a: 'unjam' | 'sync' }
  | { a: 'fix'; task: string }
  | { a: 'pour'; d: number; spill: boolean };
export type IndexedRequest = PlayerRequest & { i: number };

/** Flush fuel before completing/cancelling its job. Each delta can be sent only once. */
export function createPlayerCommands(send: (request: IndexedRequest) => void) {
  const ask = (human: PouringPlayer, request: PlayerRequest): void =>
    send({ i: human.localIndex ?? 0, ...request });
  function pourInto(human: PouringPlayer, amount: number): void {
    if (!Number.isFinite(amount)) return;
    if (amount > 0) human.poured = (human.poured || 0) + amount;
    else if (amount < -1) human.spilled = true;
  }
  function sendPour(human: PouringPlayer): void {
    if (!human.poured && !human.spilled) return;
    ask(human, { a: 'pour', d: human.poured || 0, spill: !!human.spilled });
    human.poured = 0;
    human.spilled = false;
  }
  function askFix(human: PouringPlayer, task: { id: string }): void {
    sendPour(human);
    ask(human, { a: 'fix', task: task.id });
  }
  return { ask, pourInto, sendPour, askFix };
}
