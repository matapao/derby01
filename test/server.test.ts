import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { createDevServer } from '../tools/server.ts';

test('local server confines requests to its root and serves browser assets safely', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'derby-server-'));
  const root = join(temp, 'public');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<h1>Derby</h1>');
  writeFileSync(join(root, 'sound.mp3'), 'audio');
  writeFileSync(join(temp, 'private.txt'), 'private');
  symlinkSync(join(temp, 'private.txt'), join(root, 'escape.txt'));
  const server = createDevServer(root);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    const get = (path: string, method = 'GET', host = 'localhost') =>
      new Promise<{ status: number; body: string; type: string; nosniff: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: host } }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              body,
              type: String(res.headers['content-type']),
              nosniff: String(res.headers['x-content-type-options']),
            }),
          );
        });
        req.on('error', reject);
        req.end();
      });
    assert.equal((await get('/')).body, '<h1>Derby</h1>');
    assert.equal((await get('/', 'HEAD')).body, '');
    assert.equal((await get('/', 'POST')).status, 405);
    assert.equal((await get('/', 'GET', 'attacker.example')).status, 403);
    assert.equal((await get('/%')).status, 400);
    assert.equal((await get('/escape.txt')).status, 403);
    assert.equal((await get('/..%2fprivate.txt')).status, 403);
    assert.equal((await get('/missing')).status, 404);
    const audio = await get('/sound.mp3');
    assert.equal(audio.type, 'audio/mpeg');
    assert.equal(audio.nosniff, 'nosniff');
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(temp, { recursive: true, force: true });
  }
});
