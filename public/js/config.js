// Edit this file to tweak the site. Nothing here is secret.

export const CONFIG = {
  // Your main Tales 'N' Tells website. When set, a "Main site" link appears in the nav and footer.
  // Example: 'https://www.talesntells.com'
  mainSite: '',

  instagram: 'https://www.instagram.com/tales_n_tells?igsh=ems2YnNzbGU3aGdn',
  x: 'https://x.com/Tales_N_Tells',

  // AR behaviour -------------------------------------------------------------
  // How many artworks can be tracked at the same time (1 is lightest on cheap phones).
  maxTrack: 1,
  // How many lost frames to forgive before the animation pauses (higher = steadier, slower to react).
  missTolerance: 12,
  // How many consecutive frames must recognise the art before it is "found" (lower = faster, a bit less safe).
  warmupTolerance: 4,

  // Libraries (loaded from CDNs in the visitor's browser). Keep the MindAR version identical in
  // the importmap in index.html — the compiled .mind files must match the runtime version.
  compilerUrl: 'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image.prod.js',
  qrUrl: 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js',
  blobClientUrl: 'https://esm.sh/@vercel/blob@1.1.1/client',
};
