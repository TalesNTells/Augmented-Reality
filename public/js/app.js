// Visitor-facing page.
//   /            → "scan any registered artwork" (uses the combined target file)
//   /a/<slug>    → opened from a QR code: one artwork, its own target file

import { CONFIG } from './config.js';
import { ICONS, initTheme, startOrbs, el } from './ui.js';

const $ = (id) => document.getElementById(id);
const slugMatch = location.pathname.match(/^\/a\/([^/]+)\/?$/);
const SLUG = slugMatch ? decodeURIComponent(slugMatch[1]) : null;

/* ------------------------------ chrome ------------------------------ */
initTheme($('themeToggle'));
$('closeBtn').innerHTML = ICONS.x;
$('scrollCue').innerHTML = ICONS.arrowDown;
if (CONFIG.mainSite) {
  $('navMain').href = CONFIG.mainSite;
  $('navMain').hidden = false;
}
$('footerLinks').append(
  ...[
    CONFIG.mainSite && ['Main site', CONFIG.mainSite],
    CONFIG.instagram && ['Instagram', CONFIG.instagram],
    CONFIG.x && ['Twitter', CONFIG.x],
  ]
    .filter(Boolean)
    .map(([t, h]) => el('a', { href: h, target: '_blank', rel: 'noopener', text: t }))
);
let stopOrbs = startOrbs($('orbs'));

/* ------------------------------- state ------------------------------ */
let data = { mode: SLUG ? 'single' : 'all', artworks: [], combined: null };
let session = null; // the running AR session
let startToken = 0; // lets us abandon a start that the user cancelled
let muted = true;
let wakeLock = null;

/* ------------------------------ loading ----------------------------- */
async function load() {
  try {
    if (SLUG) {
      const r = await fetch(`/api/artworks?slug=${encodeURIComponent(SLUG)}`);
      const j = await r.json().catch(() => ({}));
      if (r.status === 404) return showNotFound(j.error);
      if (!r.ok) throw new Error(j.error || 'Could not load this artwork.');
      data.artworks = [j.artwork];
      showSingle(j.artwork);
    } else {
      const r = await fetch('/api/artworks');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not load the artworks.');
      data.artworks = j.artworks || [];
      data.combined = j.combined;
      showAll();
    }
  } catch (e) {
    showGateError(e.message || 'Could not load. Check your connection and refresh.');
  }
}

function showGateError(msg) {
  const g = $('gErr');
  g.textContent = msg;
  g.hidden = false;
}

function showSingle(a) {
  document.title = `${a.title} — Tales 'N' Tells AR`;
  $('gEyebrow').textContent = 'You scanned';
  $('gTitle').innerHTML = '';
  $('gTitle').append(document.createTextNode(a.title));
  $('gTitle').classList.add('display--md');
  $('gLede').textContent = 'Point your camera at this artwork to bring it to life. Hold steady and let it wake up.';
  $('gTargetImg').src = a.imageUrl;
  $('gTargetImg').alt = a.title;
  $('gTarget').hidden = false;
  $('gLogo').hidden = true;
  $('gTarget').style.position = 'relative';
  $('startBtn').disabled = false;
  const more = el('a', { class: 'nav-link', href: '/', text: 'See all registered artworks', style: 'margin-top:22px' });
  $('gateBody').append(more);
}

function showAll() {
  const live = data.artworks.filter((a) => Number.isInteger(a.targetIndex));
  if (!live.length || !data.combined) {
    $('gLede').textContent = 'No artwork has been brought to life yet. Check back soon — the first ones are on their way.';
    $('startBtn').textContent = 'Nothing to scan yet';
    return;
  }
  $('startBtn').disabled = false;
  // gallery
  const grid = $('galleryGrid');
  grid.replaceChildren(
    ...live.map((a) =>
      el(
        'a',
        { class: 'panel tile', href: `/a/${encodeURIComponent(a.slug)}`, title: a.title },
        el('img', { src: a.imageUrl, alt: a.title, loading: 'lazy' }),
        el('div', { class: 'tile__cap', text: a.title })
      )
    )
  );
  $('gallery').hidden = false;
  $('navGallery').hidden = false;
  $('scrollCue').hidden = false;
}

function showNotFound(msg) {
  document.title = "Not registered — Tales 'N' Tells AR";
  $('gEyebrow').textContent = 'Hmm.';
  $('gTitle').innerHTML = 'Not <span class="accent">registered.</span>';
  $('gLede').textContent = msg || 'This artwork is not registered for AR (or it has been switched off).';
  document.querySelector('.steps').hidden = true;
  const b = $('startBtn');
  b.textContent = 'Back to scanner';
  b.disabled = false;
  b.onclick = () => (location.href = '/');
  b.dataset.nav = '1';
}

/* ------------------------------ AR stage ---------------------------- */
function friendlyError(e) {
  const name = e && e.name;
  const msg = (e && e.message) || String(e);
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || /permission|denied/i.test(msg))
    return 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || /no camera|device not found/i.test(msg))
    return 'We couldn’t find a camera on this device.';
  if (name === 'NotReadableError') return 'Your camera is busy in another app. Close it and try again.';
  if (/dynamically imported|Failed to fetch|module|importmap/i.test(msg))
    return 'The AR engine couldn’t load. Check your connection and try again.';
  if (e && e.userMessage) return e.userMessage;
  return msg || 'Something went wrong starting the camera.';
}

function setChip(state, text) {
  $('chip').dataset.state = state;
  $('chipText').textContent = text;
}

function updateSoundBtn() {
  $('soundBtn').innerHTML = muted ? ICONS.volumeOff : ICONS.volumeOn;
  $('soundBtn').setAttribute('aria-label', muted ? 'Turn sound on' : 'Turn sound off');
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* not critical */
  }
}

function applyFit(tex, vw, vh, aspect) {
  // "cover" fit: fill the artwork frame, crop the overflow evenly
  const planeR = 1 / aspect; // width / height of the artwork
  const vr = vw / vh;
  tex.repeat.set(1, 1);
  tex.offset.set(0, 0);
  if (vr > planeR + 0.001) {
    tex.repeat.x = planeR / vr;
    tex.offset.x = (1 - tex.repeat.x) / 2;
  } else if (vr < planeR - 0.001) {
    tex.repeat.y = vr / planeR;
    tex.offset.y = (1 - tex.repeat.y) / 2;
  }
}

async function startAR() {
  const token = ++startToken;
  $('stage').hidden = false;
  $('stageError').hidden = true;
  $('loading').dataset.done = 'false';
  $('loadText').textContent = 'Waking the art…';
  $('reticle').dataset.hidden = 'true';
  $('hint').dataset.hidden = 'true';
  setChip('scanning', 'Looking for the art…');
  updateSoundBtn();
  document.body.style.overflow = 'hidden';
  stopOrbs();

  try {
    if (!window.isSecureContext)
      throw Object.assign(new Error('insecure'), { userMessage: 'The camera only works on a secure (https) page.' });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw Object.assign(new Error('no getUserMedia'), {
        userMessage: 'This browser can’t open the camera. Try Safari (iPhone) or Chrome (Android).',
      });

    const live = data.artworks.filter((a) => (data.mode === 'single' ? true : Number.isInteger(a.targetIndex)));
    if (!live.length) throw Object.assign(new Error('none'), { userMessage: 'Nothing to scan yet.' });
    const targetSrc = data.mode === 'single' ? live[0].mindUrl : data.combined.url;

    const [THREE, mod] = await Promise.all([import('three'), import('mindar-image-three')]);
    if (token !== startToken) return;
    const { MindARThree } = mod;

    const mindar = new MindARThree({
      container: $('stageView'),
      imageTargetSrc: targetSrc,
      maxTrack: CONFIG.maxTrack,
      missTolerance: CONFIG.missTolerance,
      warmupTolerance: CONFIG.warmupTolerance,
      uiLoading: 'no',
      uiScanning: 'no',
      uiError: 'no',
    });
    const { renderer, scene, camera } = mindar;

    // One shared <video> plays whichever artwork is currently recognised.
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.style.cssText = 'position:absolute;width:2px;height:2px;opacity:0;pointer-events:none;left:0;top:0';
    $('stage').append(video);

    const s = { mindar, renderer, video, items: [], current: null, THREE };
    session = s; // registered immediately so a failed start still releases the camera
    const wantIndex = (a) => (data.mode === 'single' ? 0 : a.targetIndex);

    for (const artwork of live) {
      const tex = new THREE.VideoTexture(video);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      const geo = new THREE.PlaneGeometry(1, artwork.aspect);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = 0.002;
      mesh.visible = false;
      const anchor = mindar.addAnchor(wantIndex(artwork));
      anchor.group.add(mesh);
      const item = { artwork, tex, geo, mat, mesh, on: false };
      anchor.onTargetFound = () => onFound(s, item);
      anchor.onTargetLost = () => onLost(s, item);
      s.items.push(item);
    }

    video.addEventListener('error', () => {
      if (s.current) setChip('found', 'Couldn’t load the animation');
    });
    video.addEventListener('loadedmetadata', () => {
      if (s.current && video.videoWidth) applyFit(s.current.tex, video.videoWidth, video.videoHeight, s.current.artwork.aspect);
    });

    await mindar.start(); // asks for the camera + loads the target file
    if (token !== startToken) return stopAR();

    renderer.setAnimationLoop(() => {
      for (const it of s.items) {
        const target = it.on ? 1 : 0;
        it.mat.opacity += (target - it.mat.opacity) * 0.18;
        if (!it.on && it.mat.opacity < 0.02) it.mat.opacity = 0;
        it.mesh.visible = it.mat.opacity > 0.01;
      }
      renderer.render(scene, camera);
    });

    requestWakeLock();
    $('loading').dataset.done = 'true';
    $('reticle').dataset.hidden = 'false';
    $('hint').dataset.hidden = 'false';
  } catch (e) {
    if (token !== startToken) return;
    console.error(e);
    await stopAR(true);
    $('stage').hidden = false;
    $('loading').dataset.done = 'true';
    $('stageErrorText').textContent = friendlyError(e);
    $('stageError').hidden = false;
  }
}

function onFound(s, item) {
  if (session !== s) return;
  s.current = item;
  item.on = true;
  const v = s.video;
  const a = item.artwork;
  setChip('found', a.title);
  $('reticle').dataset.hidden = 'true';
  $('hint').dataset.hidden = 'true';

  if (v.dataset.id !== a.id) {
    v.dataset.id = a.id;
    v.src = a.videoUrl;
    v.load();
  } else if (v.videoWidth) {
    applyFit(item.tex, v.videoWidth, v.videoHeight, a.aspect);
  }
  playCurrent(s);
}

function playCurrent(s) {
  const v = s.video;
  v.muted = muted;
  const p = v.play();
  if (p && p.catch) {
    p.catch(() => {
      // autoplay with sound refused → fall back to muted playback
      if (!v.muted) {
        muted = true;
        v.muted = true;
        updateSoundBtn();
        v.play().catch(() => setChip('found', 'Tap the screen to play'));
      } else {
        setChip('found', 'Tap the screen to play');
      }
    });
  }
}

function onLost(s, item) {
  if (session !== s) return;
  item.on = false;
  if (s.current === item) {
    s.current = null;
    s.video.pause(); // resumes from the same frame when the art is found again
  }
  if (!s.items.some((i) => i.on)) {
    setChip('scanning', 'Lost it — point back at the art');
    $('reticle').dataset.hidden = 'false';
    $('hint').dataset.hidden = 'false';
  }
}

async function stopAR(keepStageOpen = false) {
  startToken++;
  const s = session;
  session = null;
  if (s) {
    try { s.renderer.setAnimationLoop(null); } catch { /* ignore */ }
    try {
      const stream = s.mindar.video && s.mindar.video.srcObject;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    } catch { /* ignore */ }
    try { s.mindar.stop(); } catch { /* ignore */ }
    try { s.renderer.dispose(); } catch { /* ignore */ }
    try {
      s.video.pause();
      s.video.removeAttribute('src');
      s.video.load();
      s.video.remove();
    } catch { /* ignore */ }
    for (const it of s.items) {
      try { it.tex.dispose(); it.mat.dispose(); it.geo.dispose(); } catch { /* ignore */ }
    }
  }
  $('stageView').replaceChildren();
  try { if (wakeLock) await wakeLock.release(); } catch { /* ignore */ }
  wakeLock = null;
  if (!keepStageOpen) {
    $('stage').hidden = true;
    document.body.style.overflow = '';
    stopOrbs = startOrbs($('orbs'));
  }
}

/* ------------------------------ events ------------------------------ */
$('startBtn').addEventListener('click', () => {
  if ($('startBtn').dataset.nav) return;
  startAR();
});
$('closeBtn').addEventListener('click', () => stopAR());
$('errCloseBtn').addEventListener('click', () => stopAR());
$('retryBtn').addEventListener('click', () => startAR());
$('soundBtn').addEventListener('click', () => {
  muted = !muted;
  updateSoundBtn();
  if (session) {
    session.video.muted = muted;
    if (session.current && session.video.paused) playCurrent(session);
  }
});
// tap anywhere to resume if the browser blocked autoplay
$('stage').addEventListener('pointerup', (e) => {
  if (!session || !session.current || e.target.closest('button')) return;
  if (session.video.paused) playCurrent(session);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('stage').hidden) stopAR();
});

// Keep it on track when the phone is locked / the tab is backgrounded.
document.addEventListener('visibilitychange', async () => {
  if (!session) return;
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    const stream = session.mindar.video && session.mindar.video.srcObject;
    const alive = stream && stream.getTracks().some((t) => t.readyState === 'live');
    if (!alive) {
      // the OS killed the camera while we were away → restart cleanly
      await stopAR(true);
      startAR();
    } else if (session.current) {
      playCurrent(session);
    }
  } else {
    session.video.pause();
  }
});

load();
