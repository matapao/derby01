/**
 * The game's data: the numbers, lists and the town that people and agents change, in the blocks under
 * data/ (zirbel.build.json lists them). They are built into the game, so it plays as it is anywhere;
 * a zirbel host can give a room a newer revision of them. Then the host's round message names that
 * revision, every screen loads it before it builds the round, and the round is played with it.
 *
 * Modules read D (D.points.wreck, D.physics.engine.top). A new revision is put in place inside the
 * same objects, so a module may keep a reference to any part of D; what is worked out from the data
 * (tables keyed by id, the car's inertia) is redone by the functions registered with onData().
 */
import { validate, type Schema } from './blocks/validate.ts';
import common from '../data/common.schema.json' with { type: 'json' };
import bots from '../data/bots.json' with { type: 'json' };
import botsSchema from '../data/bots.schema.json' with { type: 'json' };
import car from '../data/car.json' with { type: 'json' };
import carSchema from '../data/car.schema.json' with { type: 'json' };
import controls from '../data/controls.json' with { type: 'json' };
import controlsSchema from '../data/controls.schema.json' with { type: 'json' };
import damage from '../data/damage.json' with { type: 'json' };
import damageSchema from '../data/damage.schema.json' with { type: 'json' };
import drops from '../data/drops.json' with { type: 'json' };
import dropsSchema from '../data/drops.schema.json' with { type: 'json' };
import generator from '../data/generator.json' with { type: 'json' };
import generatorSchema from '../data/generator.schema.json' with { type: 'json' };
import guns from '../data/guns.json' with { type: 'json' };
import gunsSchema from '../data/guns.schema.json' with { type: 'json' };
import kits from '../data/kits.json' with { type: 'json' };
import kitsSchema from '../data/kits.schema.json' with { type: 'json' };
import layoutSchema from '../data/layout.schema.json' with { type: 'json' };
import mechanic from '../data/mechanic.json' with { type: 'json' };
import mechanicSchema from '../data/mechanic.schema.json' with { type: 'json' };
import physics from '../data/physics.json' with { type: 'json' };
import physicsSchema from '../data/physics.schema.json' with { type: 'json' };
import pieces from '../data/pieces.json' with { type: 'json' };
import piecesSchema from '../data/pieces.schema.json' with { type: 'json' };
import points from '../data/points.json' with { type: 'json' };
import pointsSchema from '../data/points.schema.json' with { type: 'json' };
import prefabs from '../data/prefabs.json' with { type: 'json' };
import prefabsSchema from '../data/prefabs.schema.json' with { type: 'json' };
import rounds from '../data/rounds.json' with { type: 'json' };
import roundsSchema from '../data/rounds.schema.json' with { type: 'json' };
import teams from '../data/teams.json' with { type: 'json' };
import teamsSchema from '../data/teams.schema.json' with { type: 'json' };
import town from '../data/town.json' with { type: 'json' };
import type { Layout, Piece, Prefab } from './town/types.ts';

const BUNDLED = {
  bots,
  car,
  controls,
  damage,
  drops,
  generator,
  guns,
  kits,
  mechanic,
  physics,
  points,
  rounds,
  teams,
  pieces: pieces as unknown as { pieces: Piece[] },
  prefabs: prefabs as unknown as { prefabs: Prefab[] },
  town: town as unknown as Layout,
};
export type Blocks = typeof BUNDLED;
export type BlockId = keyof Blocks;
export const BLOCKS = Object.keys(BUNDLED) as BlockId[];

const SCHEMAS: Record<string, unknown> = {
  'common.schema.json': common,
  'bots.schema.json': botsSchema,
  'car.schema.json': carSchema,
  'controls.schema.json': controlsSchema,
  'damage.schema.json': damageSchema,
  'drops.schema.json': dropsSchema,
  'generator.schema.json': generatorSchema,
  'guns.schema.json': gunsSchema,
  'kits.schema.json': kitsSchema,
  'layout.schema.json': layoutSchema,
  'mechanic.schema.json': mechanicSchema,
  'physics.schema.json': physicsSchema,
  'pieces.schema.json': piecesSchema,
  'points.schema.json': pointsSchema,
  'prefabs.schema.json': prefabsSchema,
  'rounds.schema.json': roundsSchema,
  'teams.schema.json': teamsSchema,
};
const schemaOf = (id: BlockId): string => (id === 'town' ? 'layout.schema.json' : `${id}.schema.json`);

/** The data the game plays with now. */
export const D: Blocks = structuredClone(BUNDLED);
let current = '';
/** The revision D came from: '' for the data the game was built with. */
export const dataRevision = (): string => current;

const derived: (() => void)[] = [];
/** Work something out from the data: now, and again whenever the data changes. */
export function onData(fn: () => void): void {
  derived.push(fn);
  fn();
}

/** What is wrong with a block, if anything. */
export function checkBlock(id: BlockId, value: unknown): string[] {
  const file = schemaOf(id);
  const { problems } = validate(SCHEMAS[file] as Schema, value, {
    file,
    load: (p) => SCHEMAS[p.replace(/^.*\//, '')] as Schema | undefined,
  });
  return problems.map((p) => `${id}${p.path}: ${p.message}`);
}

// Copies value into target, keeping target's objects (and any reference a module holds to them).
function refill(target: Record<string, unknown> | unknown[], value: unknown): void {
  if (Array.isArray(target)) {
    target.length = 0;
    for (const v of value as unknown[]) target.push(structuredClone(v));
    return;
  }
  const from = value as Record<string, unknown>;
  for (const k of Object.keys(target)) if (!Object.hasOwn(from, k)) delete target[k];
  for (const [k, v] of Object.entries(from)) {
    const t = target[k];
    if (v && typeof v === 'object' && t && typeof t === 'object' && Array.isArray(v) === Array.isArray(t))
      refill(t as Record<string, unknown>, v);
    else target[k] = structuredClone(v);
  }
}

/**
 * Puts a revision's blocks in place. Each is checked against its schema first; one that fails keeps
 * what it was (the host checks every revision before a room gets it, so this is a second look).
 * Blocks not given go back to the built-in ones. Returns what was wrong.
 */
export function useData(next: Partial<Record<BlockId, unknown>>, rev: string): string[] {
  const problems: string[] = [];
  for (const id of BLOCKS) {
    const value = next[id] ?? BUNDLED[id];
    const wrong = next[id] === undefined ? [] : checkBlock(id, value);
    if (wrong.length) {
      problems.push(...wrong);
      continue;
    }
    refill(D[id] as unknown as Record<string, unknown>, value);
  }
  current = rev;
  for (const fn of derived) fn();
  if (problems.length)
    console.warn(
      `derby01: revision ${rev} has blocks that don't fit, kept the ones before:\n${problems.slice(0, 12).join('\n')}`,
    );
  return problems;
}

/** What a zirbel-net connection offers for data, where it does (zirbel-net from the revisions on). */
export interface DataNet {
  readonly revision?: { readonly id: string; readonly base: string; readonly engine: boolean } | null;
  data?(file: string, rev?: string): Promise<unknown>;
}

/**
 * A revision's blocks, read through zirbel-net; null when there is nothing to read them with. A block
 * that can't be read is left out (and so stays as built).
 */
export async function fetchData(
  net: DataNet,
  rev: string,
): Promise<Partial<Record<BlockId, unknown>> | null> {
  if (!rev || typeof net.data !== 'function') return null;
  const list = await Promise.all(
    BLOCKS.map((id) =>
      net.data!(`${id}.json`, rev).catch((error: unknown) => {
        console.warn(`derby01: no ${id}.json in revision ${rev}:`, error);
        return undefined;
      }),
    ),
  );
  return Object.fromEntries(BLOCKS.map((id, i) => [id, list[i]]).filter(([, v]) => v !== undefined));
}

// revisions read so far (the last few), and those being read
const loaded = new Map<string, Partial<Record<BlockId, unknown>>>();
const loading = new Map<string, Promise<boolean>>();

/** Starts reading a revision's blocks, so they are at hand when a round needs them. True once they are. */
export function prefetchRevision(net: DataNet, rev: string): Promise<boolean> {
  if (!rev || loaded.has(rev)) return Promise.resolve(true);
  let p = loading.get(rev);
  if (!p) {
    p = fetchData(net, rev)
      .then(
        (blocks) => {
          if (!blocks) return false;
          loaded.set(rev, blocks);
          while (loaded.size > 4) loaded.delete(loaded.keys().next().value!);
          return true;
        },
        (error: unknown) => {
          console.warn(`derby01: couldn't load revision ${rev}:`, error);
          return false;
        },
      )
      .finally(() => loading.delete(rev));
    loading.set(rev, p);
  }
  return p;
}

/** Puts a revision in place now, if it is read already ('' is the data the game was built with). */
export function useLoaded(rev: string): boolean {
  if (rev === current) return true;
  if (!rev) {
    useData({}, '');
    return true;
  }
  const blocks = loaded.get(rev);
  if (!blocks) return false;
  useData(blocks, rev);
  return true;
}

/** Reads (if need be) and puts in place the revision a room plays. True when it is in place. */
export async function useRevision(net: DataNet, rev: string): Promise<boolean> {
  if (useLoaded(rev)) return true;
  await prefetchRevision(net, rev);
  return useLoaded(rev);
}
