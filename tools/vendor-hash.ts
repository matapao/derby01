/** Refresh the portable public SHA owner from a Zirbel installation: node tools/vendor-hash.ts PATH. */
import { createRequire } from 'node:module';
import { copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const platform = process.argv[2];
if (!platform) throw new Error('Pass the Zirbel installation directory.');
const source = createRequire(join(resolve(platform), 'package.json')).resolve('@zirbel/core/sha256');
const root = resolve(import.meta.dirname, '..');
await build({
  entryPoints: [source],
  outfile: join(root, 'vendor/zirbel-sha256.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  legalComments: 'inline',
});
copyFileSync(join(resolve(platform), 'LICENSE'), join(root, 'vendor/zirbel-sha256-LICENSE.txt'));
copyFileSync(join(resolve(platform), 'LICENSE'), join(root, 'assets/zirbel-LICENSE.txt'));
writeFileSync(
  join(root, 'vendor/zirbel-sha256.json'),
  JSON.stringify(
    {
      owner: '@zirbel/core/sha256',
      source: 'https://github.com/matapao/zirbel/blob/main/packages/core/src/sha256.ts',
      license: 'MIT',
      sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
      changes:
        'Bundled without algorithm changes using the pinned esbuild version. Refresh with node tools/vendor-hash.ts PATH_TO_ZIRBEL.',
    },
    null,
    2,
  ) + '\n',
);
