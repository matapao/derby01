import { D, onData } from './data.ts';

export const STOCK_MAX = D.mechanic.spares.max; // (data/mechanic.json)
/** How much of the tank one jerry can fills. */
export let CAN_FUEL = 55;
onData(() => {
  CAN_FUEL = D.mechanic.spares.canFuel;
});
