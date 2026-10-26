/**
 * Builds derby01: the game's modules bundled into main.js, next to index.html and the assets.
 *
 *   node tools/build.ts            dist/web: the game as a folder, for any static server (minified)
 *   node tools/build.ts --zirbel   dist/zirbel/derby01: the folder zirbel hosts serve, with zirbel.json, the
 *                                  blocks (data/), the build manifest (zirbel.build.json) and the agents'
 *                                  modules (agent/look.js, check.js, play.js)
 *   node tools/build.ts --serve    dist/web unminified with source maps, served at http://localhost:8411
 *                                  (or $PORT) while you work
 *
 * Every path in the game is relative: a zirbel host serves it under /derby01/@<version>/.
 * /zirbel-net.js stays outside the bundle: the host serves it, and without one the game plays locally.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createDevServer } from './server.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));

// index.html in the repo is also the source page: it says how to build the game if someone opens it
// as it is. That note is left out of the built page.
const SOURCE_ONLY = /\s*<!-- source page only -->[\s\S]*?<!-- \/source page only -->/g;

export async function buildGame(out: string, { zirbel = false, dev = false } = {}): Promise<void> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(ROOT, 'src', 'main.ts')],
    outfile: join(out, 'main.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: !dev,
    sourcemap: dev ? 'linked' : false,
    legalComments: 'linked', // three.js's licence, in main.js.LEGAL.txt
    external: ['/zirbel-net.js'],
    define: { __ZIRBEL__: String(zirbel) }, // only the zirbel build looks for a hub (src/net/session.ts)
    logLevel: 'warning',
  });
  writeFileSync(
    join(out, 'index.html'),
    readFileSync(join(ROOT, 'index.html'), 'utf8').replace(SOURCE_ONLY, ''),
  );
  cpSync(join(ROOT, 'assets'), join(out, 'assets'), { recursive: true });
  cpSync(join(ROOT, 'LICENSE'), join(out, 'LICENSE.txt'));
  cpSync(join(ROOT, 'node_modules', 'three', 'LICENSE'), join(out, 'assets', 'three-LICENSE.txt'));
  if (zirbel) {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'zirbel.json'), 'utf8')) as { version: string };
    manifest.version = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
    ).version;
    writeFileSync(join(out, 'zirbel.json'), JSON.stringify(manifest, null, 2) + '\n');
    await buildAgents(out);
  }
  let bytes = 0,
    files = 0;
  for (const f of walk(out)) {
    bytes += statSync(f).size;
    files++;
  }
  console.log(
    `built ${relative(process.cwd(), out) || '.'}: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`,
  );
}

/**
 * What a zirbel host needs for agents: the blocks and their schemas (data/, which net.data() reads),
 * the build manifest, and the agents' modules: each one ES module with its JSON inside and no imports
 * but '/zirbel-net.js' (types only), so it runs in a host's worker as it is. (A host that builds the
 * game itself makes the same files from zirbel.build.json.)
 */
async function buildAgents(out: string): Promise<void> {
  mkdirSync(join(out, 'data'), { recursive: true });
  for (const f of readdirSync(join(ROOT, 'data')))
    if (f.endsWith('.json')) cpSync(join(ROOT, 'data', f), join(out, 'data', f));
  cpSync(join(ROOT, 'zirbel.build.json'), join(out, 'zirbel.build.json'));
  for (const name of ['look', 'check', 'play']) {
    await build({
      entryPoints: [join(ROOT, 'src', 'agent', `${name}.ts`)],
      outfile: join(out, 'agent', `${name}.js`),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      minify: true,
      legalComments: 'none',
      external: ['/zirbel-net.js'],
      logLevel: 'warning',
    });
  }
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

if (import.meta.main) {
  const zirbel = args.has('--zirbel'),
    dev = args.has('--serve');
  const out = zirbel ? join(ROOT, 'dist', 'zirbel', 'derby01') : join(ROOT, 'dist', 'web');
  await buildGame(out, { zirbel, dev });
  if (dev) {
    const port = Number(process.env['PORT'] ?? 8411);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('PORT must be an integer from 1 to 65535');
    createDevServer(out).listen(port, '127.0.0.1', () => console.log(`derby01 at http://localhost:${port}/`));
  }
}
