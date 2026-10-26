/**
 * Checks a block (any JSON) against its JSON Schema: the draft 2020-12 subset a zirbel host
 * understands (zirbel.gg's build interface, section 1.3), so the game, its tests and the host agree on
 * what a valid block is. No dependencies, no DOM: it runs in the page, in a worker and in Node.
 *
 *   const errors = validate(schema, value, { file: 'data/kits.schema.json', load });
 *
 * Errors carry a JSON Pointer to the value that is wrong. "x-zirbel-ref" strings are collected in
 * refs, for the caller to look up in the block they name.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = boolean | { [key: string]: unknown };

export interface Problem {
  path: string;
  message: string;
}
export interface Ref {
  path: string;
  block: string;
  value: string;
}

export interface Options {
  /** The schema's own path, so relative $refs ("common.schema.json#/$defs/point") resolve. */
  file?: string;
  /** Returns the schema at a path (already parsed), or undefined. */
  load?: ((path: string) => Schema | undefined) | undefined;
}

/** The keywords the host's validator understands; anything else is refused at import (lint()). */
export const KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minProperties',
  'maxProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  '$ref',
  '$defs',
  '$id',
  '$schema',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'format',
  'x-zirbel-ref',
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const pointer = (base: string, key: string | number): string =>
  `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
const typeMatches = (want: string, v: unknown): boolean => {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
};

/** Equal as JSON: same values, objects compared key by key whatever their order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a),
      kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  }
  return false;
}

function resolvePath(from: string, rel: string): string {
  if (!rel) return from;
  const parts = from.split('/').slice(0, -1);
  for (const p of rel.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

function atPointer(root: unknown, ptr: string): unknown {
  if (!ptr || ptr === '#') return root;
  let node = root;
  for (const raw of ptr.replace(/^#?\/?/, '').split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isObject(node)) node = node[key];
    else return undefined;
  }
  return node;
}

interface Ctx {
  root: Schema;
  file: string;
  load?: ((path: string) => Schema | undefined) | undefined;
  refs: Ref[];
}

function check(schema: Schema, v: unknown, path: string, ctx: Ctx, out: Problem[]): void {
  if (schema === true) return;
  if (schema === false) {
    out.push({ path, message: 'is not allowed here' });
    return;
  }
  const s = schema;

  if (typeof s['$ref'] === 'string') {
    const [file, frag] = (s['$ref'] as string).split('#');
    let root = ctx.root,
      at = ctx.file;
    if (file) {
      at = resolvePath(ctx.file, file);
      const loaded = ctx.load?.(at);
      if (loaded === undefined) {
        out.push({ path, message: `schema ${at} is missing` });
        return;
      }
      root = loaded;
    }
    const target = atPointer(root, frag ?? '');
    if (target === undefined) {
      out.push({ path, message: `schema reference ${s['$ref'] as string} leads nowhere` });
      return;
    }
    check(target as Schema, v, path, { ...ctx, root, file: at }, out);
  }

  const t = s['type'];
  if (t !== undefined) {
    const list = Array.isArray(t) ? (t as string[]) : [t as string];
    if (!list.some((x) => typeMatches(x, v))) {
      out.push({ path, message: `should be ${list.join(' or ')}, not ${typeOf(v)}` });
      return;
    }
  }
  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).some((e) => sameJson(e, v))) {
    out.push({
      path,
      message: `should be one of ${(s['enum'] as unknown[]).map((e) => JSON.stringify(e)).join(', ')}`,
    });
  }
  if ('const' in s && !sameJson(s['const'], v))
    out.push({ path, message: `should be ${JSON.stringify(s['const'])}` });

  if (typeof v === 'number') {
    if (typeof s['minimum'] === 'number' && v < s['minimum'])
      out.push({ path, message: `should be at least ${s['minimum']}` });
    if (typeof s['maximum'] === 'number' && v > s['maximum'])
      out.push({ path, message: `should be at most ${s['maximum']}` });
    if (typeof s['exclusiveMinimum'] === 'number' && v <= s['exclusiveMinimum'])
      out.push({ path, message: `should be more than ${s['exclusiveMinimum']}` });
    if (typeof s['exclusiveMaximum'] === 'number' && v >= s['exclusiveMaximum'])
      out.push({ path, message: `should be less than ${s['exclusiveMaximum']}` });
    if (
      typeof s['multipleOf'] === 'number' &&
      Math.abs(v / s['multipleOf'] - Math.round(v / s['multipleOf'])) > 1e-9
    )
      out.push({ path, message: `should be a multiple of ${s['multipleOf']}` });
  }
  if (typeof v === 'string') {
    const n = [...v].length;
    if (typeof s['minLength'] === 'number' && n < s['minLength'])
      out.push({ path, message: `should be at least ${s['minLength']} characters` });
    if (typeof s['maxLength'] === 'number' && n > s['maxLength'])
      out.push({ path, message: `should be at most ${s['maxLength']} characters` });
    if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern'], 'u').test(v))
      out.push({ path, message: `should match ${s['pattern']}` });
    if (typeof s['x-zirbel-ref'] === 'string') ctx.refs.push({ path, block: s['x-zirbel-ref'], value: v });
  }

  if (Array.isArray(v)) {
    if (typeof s['minItems'] === 'number' && v.length < s['minItems'])
      out.push({ path, message: `should have at least ${s['minItems']} items` });
    if (typeof s['maxItems'] === 'number' && v.length > s['maxItems'])
      out.push({ path, message: `should have at most ${s['maxItems']} items` });
    const prefix = Array.isArray(s['prefixItems']) ? (s['prefixItems'] as Schema[]) : [];
    prefix.forEach((ps, i) => {
      if (i < v.length) check(ps, v[i], pointer(path, i), ctx, out);
    });
    if (s['items'] !== undefined)
      for (let i = prefix.length; i < v.length; i++)
        check(s['items'] as Schema, v[i], pointer(path, i), ctx, out);
    if (s['uniqueItems'] === true) {
      for (let i = 0; i < v.length; i++)
        for (let k = i + 1; k < v.length; k++) {
          if (sameJson(v[i], v[k])) {
            out.push({ path: pointer(path, k), message: `repeats item ${i}` });
            break;
          }
        }
    }
    if (s['contains'] !== undefined) {
      const hits = v.filter((x, i) => {
        const e: Problem[] = [];
        check(s['contains'] as Schema, x, pointer(path, i), ctx, e);
        return e.length === 0;
      }).length;
      const lo = typeof s['minContains'] === 'number' ? s['minContains'] : 1;
      if (hits < lo)
        out.push({
          path,
          message: lo === 1 ? 'is missing an item it must have' : `should have at least ${lo} such items`,
        });
      if (typeof s['maxContains'] === 'number' && hits > s['maxContains'])
        out.push({ path, message: `has more than ${s['maxContains']} such items` });
    }
  }

  if (isObject(v)) {
    const keys = Object.keys(v);
    if (typeof s['minProperties'] === 'number' && keys.length < s['minProperties'])
      out.push({ path, message: `should have at least ${s['minProperties']} entries` });
    if (typeof s['maxProperties'] === 'number' && keys.length > s['maxProperties'])
      out.push({ path, message: `should have at most ${s['maxProperties']} entries` });
    for (const r of Array.isArray(s['required']) ? (s['required'] as string[]) : [])
      if (!Object.hasOwn(v, r)) out.push({ path, message: `is missing "${r}"` });
    const dep = isObject(s['dependentRequired']) ? s['dependentRequired'] : {};
    for (const [k, need] of Object.entries(dep)) {
      if (Object.hasOwn(v, k))
        for (const r of need as string[])
          if (!Object.hasOwn(v, r)) out.push({ path, message: `has "${k}", so it needs "${r}" too` });
    }
    const props = isObject(s['properties']) ? s['properties'] : {};
    const patterns = isObject(s['patternProperties'])
      ? Object.entries(s['patternProperties']).map(([p, ps]) => [new RegExp(p, 'u'), ps] as const)
      : [];
    for (const k of keys) {
      const at = pointer(path, k);
      if (s['propertyNames'] !== undefined) check(s['propertyNames'] as Schema, k, at, ctx, out);
      let known = false;
      if (Object.hasOwn(props, k)) {
        known = true;
        check(props[k] as Schema, v[k], at, ctx, out);
      }
      for (const [re, ps] of patterns)
        if (re.test(k)) {
          known = true;
          check(ps as Schema, v[k], at, ctx, out);
        }
      if (!known && s['additionalProperties'] !== undefined) {
        if (s['additionalProperties'] === false)
          out.push({ path: at, message: `"${k}" is not a field here` });
        else check(s['additionalProperties'] as Schema, v[k], at, ctx, out);
      }
    }
  }

  if (Array.isArray(s['allOf'])) for (const sub of s['allOf'] as Schema[]) check(sub, v, path, ctx, out);
  const tryAll = (list: Schema[]): Problem[][] =>
    list.map((sub) => {
      const e: Problem[] = [];
      check(sub, v, path, { ...ctx, refs: [] }, e);
      return e;
    });
  if (Array.isArray(s['anyOf'])) {
    const results = tryAll(s['anyOf'] as Schema[]);
    if (!results.some((e) => e.length === 0)) out.push(...closest(results, path));
    else check((s['anyOf'] as Schema[])[results.findIndex((e) => e.length === 0)]!, v, path, ctx, []); // collect its refs
  }
  if (Array.isArray(s['oneOf'])) {
    const results = tryAll(s['oneOf'] as Schema[]);
    const passing = results.filter((e) => e.length === 0).length;
    if (passing === 0) out.push(...closest(results, path));
    else if (passing > 1) out.push({ path, message: 'fits more than one of its options' });
    else check((s['oneOf'] as Schema[])[results.findIndex((e) => e.length === 0)]!, v, path, ctx, []);
  }
  if (s['not'] !== undefined) {
    const e: Problem[] = [];
    check(s['not'] as Schema, v, path, { ...ctx, refs: [] }, e);
    if (e.length === 0) out.push({ path, message: 'matches what is not allowed here' });
  }
  if (s['if'] !== undefined) {
    const e: Problem[] = [];
    check(s['if'] as Schema, v, path, { ...ctx, refs: [] }, e);
    const next = e.length === 0 ? s['then'] : s['else'];
    if (next !== undefined) check(next as Schema, v, path, ctx, out);
  }
}

/** For anyOf/oneOf that nothing fits: the problems of the option that came closest. */
function closest(results: Problem[][], path: string): Problem[] {
  const best = results.reduce((a, b) => (b.length < a.length ? b : a));
  return best.length ? best : [{ path, message: 'fits none of its options' }];
}

export function validate(
  schema: Schema,
  value: unknown,
  o: Options = {},
): { problems: Problem[]; refs: Ref[] } {
  const problems: Problem[] = [],
    refs: Ref[] = [];
  check(schema, value, '', { root: schema, file: o.file ?? '', load: o.load, refs }, problems);
  return { problems, refs };
}

/**
 * What the host reports when a game is imported: keywords it doesn't understand (refused), properties
 * without a description, and numbers without both bounds.
 */
export function lint(schema: Schema, at = ''): Problem[] {
  const out: Problem[] = [];
  const walk = (s: unknown, path: string, isProperty: boolean): void => {
    if (!isObject(s)) return;
    for (const k of Object.keys(s))
      if (!KEYWORDS.has(k)) out.push({ path, message: `the host doesn't understand "${k}"` });
    if (isProperty && typeof s['description'] !== 'string') out.push({ path, message: 'has no description' });
    const types = Array.isArray(s['type']) ? (s['type'] as string[]) : [s['type']];
    if (types.some((t) => t === 'number' || t === 'integer')) {
      const lo = typeof s['minimum'] === 'number' || typeof s['exclusiveMinimum'] === 'number';
      const hi = typeof s['maximum'] === 'number' || typeof s['exclusiveMaximum'] === 'number';
      if (!lo || !hi) out.push({ path, message: 'is a number without a minimum and a maximum' });
    }
    if (isObject(s['properties']))
      for (const [k, p] of Object.entries(s['properties'])) walk(p, `${path}/properties/${k}`, true);
    if (isObject(s['patternProperties']))
      for (const [k, p] of Object.entries(s['patternProperties']))
        walk(p, `${path}/patternProperties/${k}`, true);
    if (isObject(s['$defs']))
      for (const [k, p] of Object.entries(s['$defs'])) walk(p, `${path}/$defs/${k}`, false);
    for (const k of [
      'items',
      'additionalProperties',
      'propertyNames',
      'contains',
      'not',
      'if',
      'then',
      'else',
    ])
      walk(s[k], `${path}/${k}`, false);
    for (const k of ['prefixItems', 'allOf', 'anyOf', 'oneOf'])
      if (Array.isArray(s[k])) (s[k] as unknown[]).forEach((x, i) => walk(x, `${path}/${k}/${i}`, false));
  };
  walk(schema, at, false);
  return out;
}
