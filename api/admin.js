// ADMIN endpoint. One function, many actions  →  /api/admin?action=...
//
//   GET  session        who am I / which storage mode is active   (public)
//   POST login          { password }                              (public)
//   POST logout
//   GET  manifest       full manifest, always fresh
//   POST upload         Vercel Blob client-upload handshake       (auth checked inside)
//   PUT  upload-local   local-dev raw file upload  ?path=tnt-ar/...
//   POST save           create / update one artwork
//   POST delete         { id }
//   POST combined       { url, order:[ids] }  register the rebuilt all-artworks target file

import crypto from 'node:crypto';
import { readJson, send, queryOf, httpError } from './_lib/http.js';
import { isAuthed, checkPassword, setSession, clearSession, adminPassword } from './_lib/auth.js';
import {
  storageMode,
  PREFIX,
  readManifest,
  writeManifest,
  deleteFiles,
  isOurUrl,
  localPutStream,
} from './_lib/storage.js';

const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/octet-stream',
];
const MAX_UPLOAD = 250 * 1024 * 1024; // 250 MB

function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'artwork'
  );
}

function uniqueSlug(base, artworks, selfId) {
  let slug = base;
  let n = 2;
  while (artworks.some((a) => a.slug === slug && a.id !== selfId)) slug = `${base}-${n++}`;
  return slug;
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function requireAuth(req) {
  if (!isAuthed(req)) throw httpError(401, 'Please log in.');
  if (req.method !== 'GET' && req.headers['x-tnt-admin'] !== '1') throw httpError(403, 'Bad request origin.');
}

export default async function handler(req, res) {
  try {
    const { action } = queryOf(req);

    /* ---------- public actions ---------- */
    if (action === 'session' && req.method === 'GET') {
      return send(res, 200, {
        authed: isAuthed(req),
        mode: storageMode,
        passwordConfigured: !!adminPassword(),
      });
    }

    if (action === 'login' && req.method === 'POST') {
      const { password } = await readJson(req);
      if (!adminPassword()) {
        throw httpError(500, 'ADMIN_PASSWORD is not set. Add it in Vercel → Settings → Environment Variables and redeploy.');
      }
      if (!checkPassword(password)) {
        await new Promise((r) => setTimeout(r, 600)); // slow down guessing
        throw httpError(401, 'Wrong password.');
      }
      setSession(req, res);
      return send(res, 200, { ok: true });
    }

    if (action === 'logout' && req.method === 'POST') {
      clearSession(req, res);
      return send(res, 200, { ok: true });
    }

    /* ---------- Vercel Blob client-upload handshake ----------
       Vercel's servers call this route back without our cookie ("upload completed"),
       so authentication happens inside onBeforeGenerateToken instead. */
    if (action === 'upload' && req.method === 'POST') {
      if (storageMode !== 'blob') throw httpError(400, 'Blob storage is not active.');
      const body = await readJson(req);
      const { handleUpload } = await import('@vercel/blob/client');
      const out = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          if (!isAuthed(req)) throw new Error('Please log in.');
          if (!pathname.startsWith(PREFIX) || pathname.includes('..')) throw new Error('Bad upload path.');
          return {
            allowedContentTypes: ALLOWED_TYPES,
            maximumSizeInBytes: MAX_UPLOAD,
            addRandomSuffix: false,
            allowOverwrite: false,
          };
        },
        onUploadCompleted: async () => {},
      });
      return send(res, 200, out);
    }

    /* ---------- everything below needs a login ---------- */
    requireAuth(req);

    if (action === 'upload-local' && req.method === 'PUT') {
      if (storageMode !== 'local') throw httpError(400, 'Local storage is not active.');
      const { path: p } = queryOf(req);
      const url = await localPutStream(p, req);
      return send(res, 200, { url });
    }

    if (action === 'manifest' && req.method === 'GET') {
      return send(res, 200, await readManifest());
    }

    if (action === 'save' && req.method === 'POST') {
      const { artwork: input } = await readJson(req);
      if (!input || typeof input !== 'object') throw httpError(400, 'Missing artwork.');
      const title = str(input.title, 120);
      if (!title) throw httpError(400, 'Give the artwork a title.');
      for (const k of ['imageUrl', 'videoUrl', 'mindUrl']) {
        if (!isOurUrl(input[k])) throw httpError(400, `Invalid ${k}.`);
      }
      const aspect = Number(input.aspect);
      if (!(aspect > 0.05 && aspect < 20)) throw httpError(400, 'Invalid aspect ratio.');

      const m = await readManifest();
      const existing = input.id ? m.artworks.find((a) => a.id === input.id) : null;
      const stale = [];

      if (existing) {
        for (const k of ['imageUrl', 'videoUrl', 'mindUrl']) {
          if (existing[k] && existing[k] !== input[k]) stale.push(existing[k]);
        }
        Object.assign(existing, {
          title,
          description: str(input.description, 500),
          imageUrl: input.imageUrl,
          videoUrl: input.videoUrl,
          mindUrl: input.mindUrl,
          aspect,
          active: input.active !== false,
          updatedAt: new Date().toISOString(),
        });
      } else {
        m.artworks.push({
          id: crypto.randomBytes(5).toString('hex'),
          slug: uniqueSlug(slugify(title), m.artworks),
          title,
          description: str(input.description, 500),
          imageUrl: input.imageUrl,
          videoUrl: input.videoUrl,
          mindUrl: input.mindUrl,
          aspect,
          active: input.active !== false,
          targetIndex: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      await writeManifest(m);
      await deleteFiles(stale);
      const saved = existing || m.artworks[m.artworks.length - 1];
      return send(res, 200, { artwork: saved, manifest: m });
    }

    if (action === 'delete' && req.method === 'POST') {
      const { id } = await readJson(req);
      const m = await readManifest();
      const i = m.artworks.findIndex((a) => a.id === id);
      if (i < 0) throw httpError(404, 'Artwork not found.');
      const [gone] = m.artworks.splice(i, 1);
      await writeManifest(m);
      await deleteFiles([gone.imageUrl, gone.videoUrl, gone.mindUrl]);
      return send(res, 200, { manifest: m });
    }

    if (action === 'combined' && req.method === 'POST') {
      const { url, order } = await readJson(req);
      if (!Array.isArray(order)) throw httpError(400, 'Missing order.');
      const m = await readManifest();
      const oldUrl = m.combined && m.combined.url;
      if (order.length === 0) {
        m.combined = null;
      } else {
        if (!isOurUrl(url)) throw httpError(400, 'Invalid combined file URL.');
        m.combined = { url, count: order.length, builtAt: new Date().toISOString() };
      }
      for (const a of m.artworks) {
        const idx = order.indexOf(a.id);
        a.targetIndex = idx >= 0 ? idx : null;
      }
      await writeManifest(m);
      if (oldUrl && oldUrl !== (m.combined && m.combined.url)) await deleteFiles([oldUrl]);
      return send(res, 200, { manifest: m });
    }

    throw httpError(404, 'Unknown action.');
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'Server error' });
  }
}
