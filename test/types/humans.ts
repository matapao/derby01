import type { LocalHuman, RemoteHuman } from '../../src/human-types.ts';
import type { HumanHud } from '../../src/hud-types.ts';
import type { ActiveGame, GameStates } from '../../src/gameplay/minigames.ts';

export function humanContracts(
  local: LocalHuman,
  remote: RemoteHuman,
  hud: HumanHud,
  game: ActiveGame,
  jam: GameStates['unjam'],
): void {
  // @ts-expect-error remote participants cannot own local HUDs
  remote.hud = hud;
  // @ts-expect-error local participants require a real camera
  local.cam = 'camera';
  // @ts-expect-error HUD selectors have explicit names
  hud.pointz = hud.pts;
  // @ts-expect-error HUD values cannot be silently widened
  hud.last.hp = 10;
  // @ts-expect-error minigame fields cannot become a bag of arbitrary values
  jam.i = 'done';
  if (game.type === 'pour') {
    game.can -= 1;
    // @ts-expect-error fuel games never have a direction sequence
    game.seq = ['up'];
  }
  if (game.type === 'nuts') {
    game.i++;
    // @ts-expect-error fitting a tyre cannot mutate a fuel-can state
    game.can = 0;
  }
}
