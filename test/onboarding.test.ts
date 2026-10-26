/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOnboardingState,
  mountOnboarding,
  onboardingRoles,
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
} from '../src/onboarding.ts';

function preferences() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  return {
    values,
    writes,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
      writes.push(key);
    },
  };
}

test('four distinct seat views explain actual responsibilities, control alternatives and team scoring', () => {
  const roles = onboardingRoles({ damage: 2, wreck: 700, radarHit: 9, radar: 300, win: 400 });
  assert.deepEqual(
    roles.map((role) => role.id),
    ['driver', 'hood', 'trunk', 'mechanic'],
  );
  for (const role of roles) {
    assert.equal(role.responsibilities.length, 2);
    assert.equal(role.controls.length, 4);
    const words = [
      role.subtitle,
      ...role.responsibilities,
      ...role.controls.flatMap((control) => [control.device, control.actions]),
      role.points,
    ]
      .join(' ')
      .split(/\s+/);
    assert.ok(words.length <= 155, `${role.id} should remain a quick role overview`);
    assert.ok(role.controls.some((control) => /Gamepad/.test(control.device)));
    assert.ok(role.controls.some((control) => /Touch/.test(control.device)));
  }
  assert.match(roles[0]?.points ?? '', /700/);
  assert.match(roles[0]?.points ?? '', /400/);
  assert.match(roles[1]?.points ?? '', /300/);
  assert.match(roles[1]?.points ?? '', /9/);
  assert.match(roles[1]?.responsibilities.join(' ') ?? '', /forward-facing/);
  assert.match(roles[2]?.responsibilities.join(' ') ?? '', /rear-facing/);
  assert.match(roles[1]?.responsibilities.join(' ') ?? '', /mechanic does not clear/);
  assert.match(roles[3]?.points ?? '', /do not award team points directly/);
  assert.match(roles[3]?.points ?? '', /separate Mechanics Championship/);
});

test('walking forward and backward does not mark the tutorial seen; Finish only works on the last seat', () => {
  const storage = preferences();
  const state = createOnboardingState(storage);
  assert.equal(state.start(), true);
  assert.equal(state.finish(), false);
  state.move(-1);
  assert.equal(state.index, 0);
  state.move(1);
  state.move(1);
  state.move(-1);
  assert.equal(state.index, 1);
  assert.deepEqual(storage.writes, []);
  state.move(1);
  state.move(1);
  state.move(1);
  assert.equal(state.index, 3);
  assert.equal(state.finish(), true);
  assert.equal(state.active, false);
  assert.equal(storage.getItem(ONBOARDING_KEY), ONBOARDING_VERSION);
  assert.equal(state.start(), false);
  assert.equal(state.start(true), true);
  assert.equal(state.index, 0);
});

test('Skip remembers the current guide version; destroying an unfinished visit does not', () => {
  const storage = preferences();
  const state = createOnboardingState(storage);
  state.start();
  state.move(1);
  state.dismiss();
  assert.deepEqual(storage.writes, []);
  assert.equal(state.start(), true);
  state.skip();
  state.skip();
  assert.deepEqual(storage.writes, [ONBOARDING_KEY]);
  assert.equal(createOnboardingState(storage).start(), false);
  storage.values.set(ONBOARDING_KEY, 'older');
  assert.equal(createOnboardingState(storage).start(), true);
});

test('blocked preference storage never prevents opening, navigation, finishing or skipping', () => {
  const state = createOnboardingState({
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  });
  assert.equal(state.start(), true);
  assert.equal(state.start(), false);
  state.move(1);
  state.move(1);
  state.move(1);
  assert.equal(state.finish(), true);
  assert.equal(state.start(), true);
  assert.doesNotThrow(() => state.skip());
});

class FakeElement extends EventTarget {
  children: FakeElement[] = [];
  textContent: string | null = '';
  className = '';
  id = '';
  type = '';
  disabled = false;
  open = false;
  tabIndex = 0;
  scrollTop = 0;
  isConnected = true;
  attributes = new Map<string, string>();
  owner: FakeDocument;
  tag: string;
  constructor(owner: FakeDocument, tag: string) {
    super();
    this.owner = owner;
    this.tag = tag;
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
    if (key === 'open') this.open = true;
  }
  removeAttribute(key: string): void {
    this.attributes.delete(key);
    if (key === 'open') this.open = false;
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
  focus(): void {
    this.owner.activeElement = this;
  }
  remove(): void {
    this.isConnected = false;
  }
}
class FakeDocument {
  nodes: FakeElement[] = [];
  head = new FakeElement(this, 'head');
  body = new FakeElement(this, 'body');
  activeElement = new FakeElement(this, 'button');
  createElement(tag: string): FakeElement {
    const node = new FakeElement(this, tag);
    this.nodes.push(node);
    return node;
  }
  button(text: string): FakeElement {
    const button = this.nodes.find((node) => node.tag === 'button' && node.textContent === text);
    assert.ok(button, `Missing button ${text}`);
    return button;
  }
  dialog(): FakeElement {
    const dialog = this.nodes.find((node) => node.tag === 'dialog');
    assert.ok(dialog);
    return dialog;
  }
}
function key(name: string, shiftKey = false): KeyboardEvent {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, { key: { value: name }, shiftKey: { value: shiftKey } });
  return event as KeyboardEvent;
}

test('the modal supports keyboard navigation, focus trapping, Escape skip and focus restoration', () => {
  const doc = new FakeDocument();
  const previous = doc.activeElement;
  const storage = preferences();
  const guide = mountOnboarding(doc as unknown as Document, storage as unknown as Storage);
  guide.start();
  const dialog = doc.dialog();
  assert.equal(dialog.open, true);
  assert.equal(dialog.attributes.get('aria-modal'), 'true');
  assert.equal(doc.activeElement.tag, 'main');
  const right = key('ArrowRight');
  dialog.dispatchEvent(right);
  assert.equal(right.defaultPrevented, true);
  assert.equal(doc.nodes.find((node) => node.tag === 'h2')?.textContent, 'Hood gunner');
  dialog.dispatchEvent(key('ArrowLeft'));
  assert.equal(doc.nodes.find((node) => node.tag === 'h2')?.textContent, 'Driver');
  doc.button('Next seat').focus();
  const tab = key('Tab');
  dialog.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(doc.activeElement, doc.button('Skip guide'));
  dialog.dispatchEvent(key('Tab', true));
  assert.equal(doc.activeElement, doc.button('Next seat'));
  dialog.dispatchEvent(key('Escape'));
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, previous);
  assert.equal(storage.getItem(ONBOARDING_KEY), ONBOARDING_VERSION);
  guide.start();
  assert.equal(dialog.open, false);
  guide.start(true);
  assert.equal(dialog.open, true);
  guide.destroy();
  guide.destroy();
  assert.equal(dialog.isConnected, false);
  assert.equal(doc.activeElement, previous);
});

test('clicking through all four seats finishes once, and teardown does not persist partial progress', () => {
  const doc = new FakeDocument();
  const storage = preferences();
  const guide = mountOnboarding(doc as unknown as Document, storage as unknown as Storage);
  guide.start();
  for (let i = 0; i < 3; i++) doc.button('Next seat').dispatchEvent(new Event('click'));
  assert.deepEqual(storage.writes, []);
  doc.button('Ready to play').dispatchEvent(new Event('click'));
  assert.equal(doc.dialog().open, false);
  assert.deepEqual(storage.writes, [ONBOARDING_KEY]);
  guide.destroy();
  const fresh = preferences();
  const doc2 = new FakeDocument();
  const unfinished = mountOnboarding(doc2 as unknown as Document, fresh as unknown as Storage);
  unfinished.start();
  doc2.button('Next seat').dispatchEvent(new Event('click'));
  unfinished.destroy();
  assert.deepEqual(fresh.writes, []);
  unfinished.start(true);
  assert.equal(doc2.dialog().open, false);
});
