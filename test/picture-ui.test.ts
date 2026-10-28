import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPictureControls } from '../src/picture-ui.ts';
import type { RenderMode } from '../src/render-quality.ts';

// Only the DOM boundary is doubled; no audio, renderer or application global is needed.
class Element extends EventTarget {
  readonly children: Element[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  className = '';
  textContent: string | null = '';
  id = '';
  type = '';
  value = '';
  open = false;
  removed = false;
  readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  append(...nodes: Element[]): void {
    this.children.push(...nodes);
  }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    this.open = false;
  }
  remove(): void {
    this.removed = true;
  }
}
function fixture() {
  const nodes: Element[] = [];
  const body = new Element('body');
  const doc = {
    body,
    createElement(tag: string) {
      const element = new Element(tag);
      nodes.push(element);
      return element;
    },
  };
  let mode: RenderMode = 'performance';
  let openings = 0;
  const writes: RenderMode[] = [];
  const controls = mountPictureControls(
    () => openings++,
    {
      get: () => mode,
      set(value) {
        writes.push(value);
        mode = value;
      },
    },
    doc as unknown as Document,
  );
  const get = (tag: string) => {
    const node = nodes.find((element) => element.tag === tag);
    assert.ok(node, `Expected ${tag}`);
    return node;
  };
  return {
    controls,
    nodes,
    body,
    get,
    writes,
    openings: () => openings,
    externalMode: (value: RenderMode) => {
      mode = value;
    },
  };
}

test('picture controls expose only the three existing render options and stay inert until opened', () => {
  const f = fixture();
  assert.equal(f.openings(), 0);
  assert.deepEqual(f.writes, []);
  assert.equal(f.nodes.filter((node) => node.tag === 'select').length, 1);
  assert.equal(f.nodes.filter((node) => node.tag === 'button').length, 1);
  assert.equal(f.get('button').textContent, 'Close');
  assert.equal(
    f.nodes.some((node) => ['input', 'audio', 'output'].includes(node.tag)),
    false,
  );
  assert.deepEqual(
    f.get('select').children.map((node) => node.value),
    ['auto', 'performance', 'sharp'],
  );
  assert.equal(f.get('select').value, 'performance');
  assert.equal(f.get('h2').textContent, 'Picture');
  assert.equal(f.get('dialog').attributes.get('aria-labelledby'), f.get('h2').id);
  f.externalMode('sharp');
  f.controls.open();
  assert.equal(f.get('select').value, 'sharp');
  assert.equal(f.get('dialog').open, true);
  assert.equal(f.openings(), 1);
  f.controls.open();
  assert.equal(f.openings(), 1);
  f.controls.destroy();
});

test('render selection validates changed DOM values before updating the renderer', () => {
  const f = fixture();
  const select = f.get('select');
  for (const mode of ['auto', 'sharp', 'performance']) {
    select.value = mode;
    select.dispatchEvent(new Event('change'));
  }
  assert.deepEqual(f.writes, ['auto', 'sharp', 'performance']);
  select.value = 'unexpected';
  select.dispatchEvent(new Event('change'));
  assert.deepEqual(f.writes, ['auto', 'sharp', 'performance']);
  assert.equal(select.value, 'performance');
  f.controls.destroy();
});

test('closing and repeated disposal stop retained controls from changing settings or reopening', () => {
  const f = fixture();
  f.controls.open();
  f.get('button').dispatchEvent(new Event('click'));
  assert.equal(f.get('dialog').open, false);
  f.controls.open();
  f.controls.destroy();
  f.controls.destroy();
  assert.equal(f.get('dialog').open, false);
  assert.equal(f.get('dialog').removed, true);
  f.get('select').value = 'sharp';
  f.get('select').dispatchEvent(new Event('change'));
  f.controls.open();
  assert.deepEqual(f.writes, []);
  assert.equal(f.get('dialog').open, false);
  assert.equal(f.openings(), 2);
});
