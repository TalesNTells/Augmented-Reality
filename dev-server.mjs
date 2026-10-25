// Local development server. Mimics what Vercel does:
//   • serves /public
//   • applies the same rewrites as vercel.json
//   • runs /api/* handlers
//   • serves uploaded files from ./.data/files at /files/*  (only used when no Blob token is set)
//
//   npm run dev     →  http://localhost:3000   (admin password: "admin" unless ADMIN_PASSWORD is set)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

// load .env / .env.local if present (tiny parser, no dependency)
for (const f of ['.env', '.env.local']) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] !== '' && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no file */
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mind': 'application/octet-stream',
};

function serveFile(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error();
  } catch {
    res.statusCode = 404;
    return res.end('Not found');
  }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  res.setHeader('content-type', type);
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-cache');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : stat.size - 1;
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('content-length', end - start + 1);
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.setHeader('content-length', stat.size);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let p = decodeURIComponent(url.pathname);

  try {
    if (p.startsWith('/api/')) {
      const name = p.slice(5).replace(/[^a-zA-Z0-9_-]/g, '');
      const file = path.join(ROOT, 'api', `${name}.js`);
      if (!name || !fs.existsSync(file)) {
        res.statusCode = 404;
        return res.end('Not found');
      }
      req.query = Object.fromEntries(url.searchParams);
      const mod = await import(pathToFileURL(file).href);
      return await mod.default(req, res);
    }

    if (p.startsWith('/files/')) {
      const { localFileFromUrlPath } = await import('./api/_lib/storage.js');
      return serveFile(req, res, localFileFromUrlPath(p));
    }

    // vercel.json rewrites
    if (/^\/a\/[^/]+\/?$/.test(p)) p = '/index.html';
    if (p === '/admin' || p === '/admin/') p = '/admin.html';
    if (p === '/') p = '/index.html';

    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }
    serveFile(req, res, file);
  } catch (e) {
    res.statusCode = e.status || 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  const mode = process.env.BLOB_READ_WRITE_TOKEN ? 'Vercel Blob' : 'local disk (./.data)';
  console.log(`\n  Tales 'N' Tells AR → http://localhost:${PORT}`);
  console.log(`  Admin              → http://localhost:${PORT}/admin  (password: ${process.env.ADMIN_PASSWORD ? '$ADMIN_PASSWORD' : 'admin'})`);
  console.log(`  Storage            → ${mode}`);
  console.log('  Note: phones need HTTPS for the camera. Use a tunnel (e.g. `npx localtunnel --port 3000`) or deploy to test on a phone.\n');
});
