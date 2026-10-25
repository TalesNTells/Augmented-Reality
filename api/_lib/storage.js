// Storage layer.
//   • Production: Vercel Blob (public files + a manifest.json that is the "database").
//   • Local dev (no BLOB_READ_WRITE_TOKEN, not on Vercel): plain files under ./.data
//
// The manifest is a single JSON document:
//   { version, updatedAt, combined: {url,count,builtAt}|null, artworks: [ ... ] }

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { httpError } from './http.js';

export const PREFIX = 'tnt-ar/';
const MANIFEST_PATH = `${PREFIX}manifest.json`;
const DATA_DIR = path.resolve(process.env.TNT_DATA_DIR || '.data');
const FILES_DIR = path.join(DATA_DIR, 'files');

export const storageMode = process.env.BLOB_READ_WRITE_TOKEN
  ? 'blob'
  : process.env.VERCEL
    ? 'unconfigured'
    : 'local';

function requireConfigured() {
  if (storageMode === 'unconfigured') {
    throw httpError(
      500,
      'Storage is not set up. In Vercel: Storage → Create → Blob, then connect it to this project and redeploy.'
    );
  }
}

export function emptyManifest() {
  return { version: 1, updatedAt: null, combined: null, artworks: [] };
}

function normalize(m) {
  const base = emptyManifest();
  if (!m || typeof m !== 'object') return base;
  return {
    ...base,
    ...m,
    artworks: Array.isArray(m.artworks) ? m.artworks : [],
  };
}

/* ----------------------------- manifest ----------------------------- */

export async function readManifest() {
  requireConfigured();
  if (storageMode === 'blob') {
    const { head, BlobNotFoundError } = await import('@vercel/blob');
    try {
      const info = await head(MANIFEST_PATH);
      const r = await fetch(`${info.url}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`manifest fetch failed (${r.status})`);
      return normalize(await r.json());
    } catch (e) {
      if (e instanceof BlobNotFoundError || /not.?found/i.test(String(e?.message))) return emptyManifest();
      throw e;
    }
  }
  try {
    return normalize(JSON.parse(await fs.readFile(path.join(DATA_DIR, 'manifest.json'), 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return emptyManifest();
    throw e;
  }
}

export async function writeManifest(manifest) {
  requireConfigured();
  manifest.updatedAt = new Date().toISOString();
  const body = JSON.stringify(manifest, null, 2);
  if (storageMode === 'blob') {
    const { put } = await import('@vercel/blob');
    await put(MANIFEST_PATH, body, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  } else {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, 'manifest.json'), body);
  }
  return manifest;
}

/* ------------------------------- files ------------------------------ */

/** Is this URL one of "our" stored files? (stops arbitrary URLs being saved into the manifest) */
export function isOurUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  if (u.startsWith('/files/' + PREFIX) && !u.includes('..')) return true;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname.endsWith('.public.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

export function safeLocalPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(PREFIX) || pathname.includes('..') || pathname.includes('\0')) {
    throw httpError(400, 'Invalid path');
  }
  const full = path.resolve(FILES_DIR, pathname);
  if (!full.startsWith(FILES_DIR + path.sep)) throw httpError(400, 'Invalid path');
  return full;
}

/** Local dev only: stream a request body to disk. Returns the public URL. */
export async function localPutStream(pathname, stream) {
  const full = safeLocalPath(pathname);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await pipeline(stream, createWriteStream(full));
  return `/files/${pathname}`;
}

export function localFileFromUrlPath(urlPath) {
  // urlPath like /files/tnt-ar/...
  return safeLocalPath(decodeURIComponent(urlPath.replace(/^\/files\//, '')));
}

export async function deleteFiles(urls) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return;
  if (storageMode === 'blob') {
    const { del } = await import('@vercel/blob');
    await del(list.filter(isOurUrl));
  } else if (storageMode === 'local') {
    for (const u of list) {
      try {
        if (u.startsWith('/files/')) await fs.unlink(localFileFromUrlPath(u));
      } catch {
        /* already gone */
      }
    }
  }
}
