// PUBLIC read-only endpoint used by the camera page.
//   GET /api/artworks            → every active artwork + the combined target file
//   GET /api/artworks?slug=foo   → one artwork (used by QR-code pages)

import { readManifest } from './_lib/storage.js';
import { send, queryOf } from './_lib/http.js';

function publicArtwork(a) {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    description: a.description || '',
    imageUrl: a.imageUrl,
    videoUrl: a.videoUrl,
    mindUrl: a.mindUrl,
    aspect: a.aspect,
    targetIndex: Number.isInteger(a.targetIndex) ? a.targetIndex : null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  try {
    const m = await readManifest();
    const active = m.artworks.filter((a) => a.active !== false);
    const { slug } = queryOf(req);
    const cache = { 'cache-control': 'public, max-age=0, s-maxage=5' };

    if (slug) {
      const a = active.find((x) => x.slug === slug);
      if (!a) return send(res, 404, { error: 'This artwork is not registered (or has been switched off).' }, cache);
      return send(res, 200, { artwork: publicArtwork(a) }, cache);
    }
    return send(
      res,
      200,
      {
        combined: m.combined && m.combined.url ? { url: m.combined.url, count: m.combined.count } : null,
        artworks: active.map(publicArtwork),
      },
      cache
    );
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'Server error' });
  }
}
