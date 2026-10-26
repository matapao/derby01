import { readFileSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.fbx': 'application/octet-stream',
  '.json': 'application/json',
};
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Serves a folder to this machine only: nothing outside the folder (symlinks are followed before the check),
 * and no other host name in the request, so a web page can't reach it by DNS rebinding.
 */
export function createDevServer(dir: string): Server {
  const root = realpathSync(dir);
  return createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL.has(host)) return void res.writeHead(403).end();
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return void res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return void res.writeHead(400).end();
    }
    let file: string;
    try {
      file = realpathSync(join(root, path.endsWith('/') ? path + 'index.html' : path));
    } catch {
      return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
    if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
