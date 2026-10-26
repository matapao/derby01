import { createPlayerCommands } from '../gameplay/player-commands.ts';
import { getSession } from './context.ts';
import { MSG } from './protocol.ts';
const commands = createPlayerCommands((request) => {
  getSession()?.net.send(255, MSG.ask, JSON.stringify(request));
});
export const { ask, pourInto, sendPour, askFix } = commands;
