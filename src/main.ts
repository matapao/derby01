// Composition root: load the dependency graph, wire reverse calls, then boot the game.
import { bindAudio } from './audio.ts';
import { mountPictureControls } from './picture-ui.ts';
import { gameSoundtrack } from './game-soundtrack.ts';
import { mountOnboarding } from './onboarding.ts';
import { mountCompetitionPanel } from './competition-ui.ts';
import { currentCompetitionSummary, anonymousRecords, subscribeCompetition } from './competition.ts';
import { getRenderMode, setRenderMode } from './world.ts';
import './net/codecs.ts';
import * as flow from './flow.ts';
import { bindLifecycle } from './lifecycle.ts';
import { buildHud } from './views.ts';
import { bindScorePresentation } from './score.ts';
import { playScoreEvent } from './sharedfx.ts';
// how each shared effect travels

bindLifecycle({ ...flow, rebuildHud: buildHud });
bindScorePresentation(playScoreEvent);
bindAudio();
// Joining screens see the same visible front credits as the host's setup, without a back/disclosure.
const sourceCredits = document.querySelector('.cover-credits');
const waitingCard = document.querySelector('#netWait .card');
if (sourceCredits && waitingCard) {
  const copy = sourceCredits.cloneNode(true);
  if (copy instanceof HTMLElement) {
    copy.removeAttribute('aria-labelledby');
    copy.setAttribute('aria-label', 'Credits');
    for (const element of copy.querySelectorAll('[id]')) element.removeAttribute('id');
    waitingCard.insertBefore(copy, waitingCard.querySelector('.wait-cars'));
  }
}
function setPicture(value: string): void {
  const mode = value === 'performance' || value === 'sharp' ? value : 'auto';
  setRenderMode(mode);
  try {
    localStorage.setItem('derby01:picture', mode);
  } catch {
    /* optional preference */
  }
}
try {
  setPicture(localStorage.getItem('derby01:picture') ?? 'auto');
} catch {
  /* auto */
}
const pictureControls = mountPictureControls(() => flow.pauseGame(true), {
  get: getRenderMode,
  set: setPicture,
});
const onboarding = mountOnboarding();
const standings = mountCompetitionPanel({
  summary: currentCompetitionSummary,
  records: anonymousRecords,
  subscribe: subscribeCompetition,
  opening: () => flow.pauseGame(true),
});
document.getElementById('statsBtn')?.addEventListener('click', standings.open);
document.getElementById('helpBtn')?.addEventListener('click', () => {
  flow.pauseGame(true);
  onboarding.start(true);
});
document.getElementById('soundBtn')?.addEventListener('click', pictureControls.open);
window.addEventListener('pagehide', (event) => {
  void gameSoundtrack.pause().catch((error: unknown) => {
    console.warn('Soundtrack could not pause.', error);
  });
  if (!event.persisted) {
    void gameSoundtrack.destroy().catch((error: unknown) => {
      console.warn('Soundtrack could not close.', error);
    });
    pictureControls.destroy();
    onboarding.destroy();
    standings.destroy();
  }
});
flow
  .boot()
  .then(() => onboarding.start())
  .catch((err) => {
    // something broke while starting: say so instead of leaving "Loading cars…" up for ever
    console.error(err);
    const el = document.getElementById('loading');
    if (el) el.textContent = 'The game could not start. Try reloading the page, or another browser.';
  });
