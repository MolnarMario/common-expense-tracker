// Minimal static file server, so `npm start` needs nothing installed.
// ES modules will not load over file://, hence this instead of double
// clicking index.html.
//
// It also forwards /api to the Worker running under `wrangler dev`,
// WebSocket upgrades included. That is not just convenience: sharing is
// designed around the page and the API sharing an origin, and testing it
// across two ports would exercise a setup that never ships.

import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const port = Number(process.env.PORT ?? 5173);
const api = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 8787) };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const isApi = (url) => url === '/api' || url.startsWith('/api/');

const server = createServer(async (req, res) => {
  if (isApi(req.url)) return proxy(req, res);

  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Keep requests inside the served folder.
  const target = join(root, normalize(pathname).replace(/^([/\\])+/, ''));
  if (!target.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found: ' + pathname);
  }
});

function proxy(req, res) {
  const upstream = httpRequest(
    { host: api.host, port: api.port, path: req.url, method: req.method, headers: req.headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'api_down', hint: 'run npm run api in another terminal' }));
  });
  req.pipe(upstream);
}

// The socket is the whole feature, so the dev server has to carry one.
server.on('upgrade', (req, socket, head) => {
  if (!isApi(req.url)) return socket.destroy();

  const upstream = httpRequest({
    host: api.host,
    port: api.port,
    path: req.url,
    method: 'GET',
    headers: req.headers,
  });

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const headers = Object.entries(upstreamRes.headers)
      .map(([key, value]) => key + ': ' + value)
      .join('\r\n');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + headers + '\r\n\r\n');
    if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
  });

  upstream.on('error', () => socket.destroy());
  if (head && head.length > 0) upstream.write(head);
  upstream.end();
});

server.listen(port, () => {
  console.log('Common Expense Tracker at http://localhost:' + port);
  console.log('  /api forwarded to http://' + api.host + ':' + api.port);
});
