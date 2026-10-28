import { D } from './data.ts';

export const ONBOARDING_KEY = 'derby01.onboarding';
export const ONBOARDING_VERSION = '1';
export interface OnboardingRole {
  id: 'driver' | 'hood' | 'trunk' | 'mechanic';
  title: string;
  subtitle: string;
  responsibilities: readonly string[];
  controls: readonly { device: string; actions: string }[];
  points: string;
}
type GuidePoints = Pick<typeof D.points, 'damage' | 'wreck' | 'radarHit' | 'radar' | 'win'>;
/** Text uses the current room's scoring values, including rooms with custom tuning. */
export function onboardingRoles(points: GuidePoints): readonly OnboardingRole[] {
  const gunControls = [
    {
      device: 'Keyboard + mouse',
      actions: 'Mouse aims · left click fires · right click zooms · 1/2/3 or C switches view.',
    },
    {
      device: 'Split keyboard',
      actions: 'WASD + Space, or arrows + Enter, to aim and fire · 1/2/3 switches view.',
    },
    { device: 'Gamepad', actions: 'Right stick aims · RT fires · LT zooms · directions clear jams.' },
    { device: 'Touch', actions: 'Drag aims · hold FIRE · tap ZOOM · arrows clear jams.' },
  ];
  const gunPoints = `Team points: ${points.damage} per enemy chassis damage · +${points.radarHit} radar hit · +${points.radar} radar destroyed · +${points.wreck} credited wreck.`;
  return [
    {
      id: 'driver',
      title: 'Driver',
      subtitle: 'Choose the fight. Keep the crew moving.',
      responsibilities: [
        'Steer, ram opponents and give your gunners a clear shot. Watch fuel, tyres and fire; collect supply drops for your mechanic.',
        'Bank drifts and donuts by ending cleanly; hard crashes lose the burn. Nitro uses extra fuel.',
      ],
      controls: [
        {
          device: 'Keyboard + mouse',
          actions: 'WASD drive · Space handbrake · left Shift nitro · V camera.',
        },
        {
          device: 'Arrow keys',
          actions: 'Arrows drive · Enter handbrake · right Shift nitro · comma camera.',
        },
        {
          device: 'Gamepad',
          actions: 'Left stick steers · RT/LT pedals · A handbrake · X nitro · B camera.',
        },
        {
          device: 'Touch / mouse only',
          actions: 'Touch: steer + pedals. Mouse: move steers · left gas · right brake.',
        },
      ],
      points: `Team points: ${points.damage} per enemy chassis damage · +${points.wreck} credited wreck · clean drifts/donuts earn burn points · +${points.win} round win.`,
    },
    {
      id: 'hood',
      title: 'Hood gunner',
      subtitle: 'The forward turret. Find the roof radar.',
      responsibilities: [
        'Rear-left seat, forward-facing hood turret. Lead moving enemies; hit bodywork for damage or the roof radar for a bonus. Paint obstructs their view.',
        'Fire short bursts to manage heat. Clear your own jam with the displayed direction sequence; the mechanic does not clear markers.',
      ],
      controls: gunControls,
      points: gunPoints,
    },
    {
      id: 'trunk',
      title: 'Trunk gunner',
      subtitle: 'The rear turret. Keep pursuers off the crew.',
      responsibilities: [
        'Rear-right seat, rear-facing trunk turret. Cover pursuers while the driver lines up the next move. Target enemy bodywork and roof radars.',
        'Your own panels can block shots. Fire short bursts; clear your own jam with the displayed direction sequence.',
      ],
      controls: gunControls,
      points: gunPoints,
    },
    {
      id: 'mechanic',
      title: 'Mechanic',
      subtitle: 'Front passenger. Keep the car in the round.',
      responsibilities: [
        'Prioritize fire, fuel and leaks, then engine, tyres, axles, bumpers, glass, radar and chassis. Follow each dashboard repair game’s prompts.',
        'Some jobs use spares; ask for supply drops. Cancelling after pouring can still spend the fuel can. Gunners clear their own jams.',
      ],
      controls: [
        {
          device: 'Keyboard + mouse',
          actions: 'W/S selects · Space acts · Shift drops · follow each game’s prompts.',
        },
        {
          device: 'Arrow keys',
          actions: 'Up/down selects · Enter acts · right Shift drops · arrows for directions.',
        },
        { device: 'Gamepad', actions: 'Stick selects · A acts · B drops · stick/d-pad for directions.' },
        {
          device: 'Touch / mouse only',
          actions: 'Touch: tap job twice, work screen, DROP cancels. Mouse: wheel, left/right click.',
        },
      ],
      points: `Jobs, repairs and fuel earn separate Mechanics Championship points. Repairs do not award team points directly; keep the crew fighting for the +${points.win} round-win bonus.`,
    },
  ];
}

type GuideStorage = Pick<Storage, 'getItem' | 'setItem'>;
/** Progress stays in memory. Only an explicit Finish or Skip marks this version as seen. */
export function createOnboardingState(storage?: GuideStorage) {
  let index = 0;
  let active = false;
  function start(force = false): boolean {
    if (active) return false;
    if (!force) {
      try {
        if (storage?.getItem(ONBOARDING_KEY) === ONBOARDING_VERSION) return false;
      } catch {
        /* Unavailable storage leaves the guide usable for this visit. */
      }
    }
    index = 0;
    active = true;
    return true;
  }
  function move(direction: -1 | 1): void {
    if (active) index = Math.max(0, Math.min(3, index + direction));
  }
  function close(remember: boolean): void {
    if (!active) return;
    active = false;
    if (remember) {
      try {
        storage?.setItem(ONBOARDING_KEY, ONBOARDING_VERSION);
      } catch {
        /* A denied preference must not prevent closing the guide. */
      }
    }
  }
  function finish(): boolean {
    if (!active || index !== 3) return false;
    close(true);
    return true;
  }
  return {
    start,
    move,
    finish,
    skip: () => close(true),
    dismiss: () => close(false),
    get index() {
      return index;
    },
    get active() {
      return active;
    },
  };
}

export function mountOnboarding(
  doc: Document = document,
  storage?: Storage,
): {
  start(force?: boolean): void;
  destroy(): void;
} {
  let preferences: GuideStorage | undefined = storage;
  if (!preferences) {
    try {
      preferences = doc.defaultView?.localStorage;
    } catch {
      /* Private/device policies may deny localStorage. */
    }
  }
  const state = createOnboardingState(preferences);
  let destroyed = false;
  let previousFocus: Element | null = null;
  const dialog = doc.createElement('dialog');
  dialog.className = 'derby-guide';
  dialog.setAttribute('aria-label', 'Learn the four crew seats');
  dialog.setAttribute('aria-modal', 'true');
  const style = doc.createElement('style');
  style.textContent = `
.derby-guide{box-sizing:border-box;width:min(960px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:0;border:1px solid #536473;border-radius:14px;background:#10202b;color:#edf5f7;box-shadow:0 20px 70px #0007;font:14px/1.4 system-ui,sans-serif;z-index:10000}
.derby-guide::backdrop{background:#030b13c9}
.derby-guide *{box-sizing:border-box}.derby-guide header,.derby-guide footer{padding:12px 22px;display:flex;align-items:center;justify-content:space-between;gap:12px}.derby-guide header{border-bottom:1px solid #ffffff20}.derby-guide footer{border-top:1px solid #ffffff20;flex-wrap:wrap}.derby-guide main{padding:14px 22px;max-height:calc(100dvh - 160px);overflow:auto}.derby-guide h2{font-size:26px;line-height:1.15;margin:2px 0 6px}.derby-guide h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#a6dce9;margin:12px 0 7px}.derby-guide p{margin:6px 0;color:#c7d7df}.derby-guide ul{padding-left:18px;margin:10px 0}.derby-guide li{margin:6px 0}.derby-guide .guide-controls{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.derby-guide .guide-control,.derby-guide .guide-points{background:#ffffff08;border:1px solid #ffffff12;border-radius:8px;padding:9px}.derby-guide .guide-control strong{display:block;color:#fff;margin-bottom:4px}.derby-guide .guide-control p{font-size:13px;margin:0}.derby-guide .guide-points{border-color:#9ce6a344}.derby-guide .guide-progress{font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.12em;color:#a6dce9}.derby-guide button{font:inherit;font-weight:700;cursor:pointer;padding:8px 14px;border:1px solid #7c929d;border-radius:8px;background:#263b48;color:#fff}.derby-guide button:disabled{opacity:.35;cursor:default}.derby-guide button:focus-visible{outline:3px solid #a9edf8;outline-offset:3px}.derby-guide .guide-next{background:#c5ed7c;border-color:#c5ed7c;color:#122116}.derby-guide .guide-skip{border-color:transparent;background:transparent;color:#c7d7df}.derby-guide .guide-actions{display:flex;gap:8px}.derby-guide .guide-shared{font-size:12px;color:#9db7c5;margin-top:12px}.derby-guide [hidden]{display:none}
@media(max-width:780px){.derby-guide .guide-controls{grid-template-columns:1fr 1fr}}
@media(max-width:540px){.derby-guide header,.derby-guide footer,.derby-guide main{padding:12px}.derby-guide .guide-controls{grid-template-columns:1fr}.derby-guide h2{font-size:24px}.derby-guide main{max-height:calc(100dvh - 160px)}}`;
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const header = element('header');
  const progress = element('div');
  progress.className = 'guide-progress';
  const skip = element('button', 'Skip guide');
  skip.type = 'button';
  skip.className = 'guide-skip';
  header.append(progress, skip);
  const main = element('main');
  main.tabIndex = -1;
  const title = element('h2');
  title.id = 'derby-guide-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const subtitle = element('p');
  const responsibilities = element('ul');
  const controls = element('div');
  controls.className = 'guide-controls';
  const points = element('p');
  points.className = 'guide-points';
  const shared = element(
    'p',
    'Change seat: C / period / Y / SEAT / middle click. Bots fill spare seats. In-game pause: Esc / Start / ❚❚. Esc skips this guide.',
  );
  shared.className = 'guide-shared';
  main.append(
    title,
    subtitle,
    responsibilities,
    element('h3', 'Controls'),
    controls,
    element('h3', 'Team points'),
    points,
    shared,
  );
  const footer = element('footer');
  const note = element('span', 'Four seats. One crew.');
  const actions = element('div');
  actions.className = 'guide-actions';
  const back = element('button', 'Back');
  back.type = 'button';
  const next = element('button', 'Next seat');
  next.type = 'button';
  next.className = 'guide-next';
  actions.append(back, next);
  footer.append(note, actions);
  dialog.append(header, main, footer);
  doc.head.append(style);
  doc.body.append(dialog);
  function render(): void {
    const role = onboardingRoles(D.points)[state.index];
    if (!role) throw new Error('Missing onboarding role');
    progress.textContent = `Crew guide · ${state.index + 1} of 4`;
    title.textContent = role.title;
    subtitle.textContent = role.subtitle;
    responsibilities.replaceChildren(...role.responsibilities.map((text) => element('li', text)));
    controls.replaceChildren(
      ...role.controls.map((control) => {
        const card = element('div');
        card.className = 'guide-control';
        card.append(element('strong', control.device), element('p', control.actions));
        return card;
      }),
    );
    points.textContent = role.points;
    back.disabled = state.index === 0;
    next.textContent = state.index === 3 ? 'Ready to play' : 'Next seat';
    main.scrollTop = 0;
  }
  function restoreFocus(): void {
    if (previousFocus?.isConnected && 'focus' in previousFocus && typeof previousFocus.focus === 'function')
      previousFocus.focus();
    previousFocus = null;
  }
  function hide(): void {
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    restoreFocus();
  }
  function skipGuide(): void {
    state.skip();
    hide();
  }
  function advance(): void {
    if (state.index === 3) {
      if (state.finish()) hide();
    } else {
      state.move(1);
      render();
      main.focus();
    }
  }
  const onBack = () => {
    state.move(-1);
    render();
    main.focus();
  };
  const stop = (event: Event) => event.stopPropagation();
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      skipGuide();
    } else if (event.key === 'ArrowRight' && state.index < 3) {
      event.preventDefault();
      state.move(1);
      render();
      main.focus();
    } else if (event.key === 'ArrowLeft' && state.index > 0) {
      event.preventDefault();
      onBack();
    } else if (event.key === 'Tab') {
      const buttons = [skip, back, next].filter((button) => !button.disabled);
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && (doc.activeElement === first || doc.activeElement === main)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  const onCancel = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    skipGuide();
  };
  skip.addEventListener('click', skipGuide);
  back.addEventListener('click', onBack);
  next.addEventListener('click', advance);
  dialog.addEventListener('keydown', onKey);
  dialog.addEventListener('keyup', stop);
  dialog.addEventListener('cancel', onCancel);
  for (const name of ['pointerdown', 'pointerup', 'click', 'wheel']) dialog.addEventListener(name, stop);
  function start(force = false): void {
    if (destroyed || !state.start(force)) return;
    previousFocus = doc.activeElement;
    render();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    main.focus();
  }
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    state.dismiss();
    hide();
    skip.removeEventListener('click', skipGuide);
    back.removeEventListener('click', onBack);
    next.removeEventListener('click', advance);
    dialog.removeEventListener('keydown', onKey);
    dialog.removeEventListener('keyup', stop);
    dialog.removeEventListener('cancel', onCancel);
    for (const name of ['pointerdown', 'pointerup', 'click', 'wheel']) dialog.removeEventListener(name, stop);
    dialog.remove();
    style.remove();
  }
  return { start, destroy };
}
