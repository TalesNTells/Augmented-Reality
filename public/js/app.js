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
// focus = the artwork whose QR code was scanned (if any). The camera still recognises ANY registered artwork.
let data = { artworks: [], combined: null, focus: null };
let session = null; // the running AR session
let startToken = 0; // lets us abandon a start that the user cancelled
let muted = true;
let wakeLock = null;
let lastErrorWasEngine = false;
const RETRY_KEY = 'tnt-retry-camera';

/* ------------------------------ loading ----------------------------- */
async function load() {
  try {
    const r = await fetch('/api/artworks');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not load the artworks.');
    data.artworks = j.artworks || [];
    data.combined = j.combined;
    if (SLUG) {
      data.focus = data.artworks.find((a) => a.slug === SLUG) || null;
      if (!data.focus) return showNotFound('This artwork is not registered (or it has been switched off). You can still scan any other registered artwork.');
      showFocus(data.focus);
    }
    showGallery();
    const plan = scanPlan();
    if (plan) {
      $('startBtn').disabled = false;
      let retry = false;
      try {
        retry = sessionStorage.getItem(RETRY_KEY) === '1';
        sessionStorage.removeItem(RETRY_KEY);
      } catch { /* ignore */ }
      if (retry) startAR();
      else scheduleWarmUp();
    }
    else if (!SLUG) {
      $('gLede').textContent = 'No artwork has been brought to life yet. Check back soon — the first ones are on their way.';
      $('startBtn').textContent = 'Nothing to scan yet';
    }
  } catch (e) {
    showGateError(e.message || 'Could not load. Check your connection and refresh.');
  }
}

/** What the camera will look for.
 *  Normally: every registered artwork (the combined target file).
 *  Fallback: if the combined file doesn't yet include the QR'd artwork, use that artwork's own file. */
function scanPlan() {
  const inCombined = data.artworks.filter((a) => Number.isInteger(a.targetIndex));
  const focusReady = !data.focus || Number.isInteger(data.focus.targetIndex);
  if (data.combined && inCombined.length && focusReady) {
    return { src: data.combined.url, list: inCombined, indexOf: (a) => a.targetIndex };
  }
  if (data.focus) return { src: data.focus.mindUrl, list: [data.focus], indexOf: () => 0 };
  return null;
}

function showGateError(msg) {
  const g = $('gErr');
  g.textContent = msg;
  g.hidden = false;
}

function showFocus(a) {
  document.title = `${a.title} — Tales 'N' Tells AR`;
  $('gEyebrow').textContent = 'You scanned';
  $('gTitle').innerHTML = '';
  $('gTitle').append(document.createTextNode(a.title));
  $('gTitle').classList.add('display--md');
  $('gLede').textContent = 'Open the camera and point it at this artwork to bring it to life. You can scan any other registered artwork too.';
  $('gTargetImg').src = a.imageUrl;
  $('gTargetImg').alt = a.title;
  $('gTarget').hidden = false;
  $('gLogo').hidden = true;
  $('gTarget').style.position = 'relative';
}

function showGallery() {
  const live = data.artworks.filter((a) => Number.isInteger(a.targetIndex));
  if (!live.length) return;
  $('galleryGrid').replaceChildren(
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

/* --------------------------- warm-up (page load) --------------------------- */
// Download + compile the AR engine and the target file while the visitor is still on the
// landing screen, so tapping "Open camera" only has to wait for the camera itself.
let warmPromise = null;
function warmUp() {
  if (!warmPromise) {
    warmPromise = (async () => {
      const [THREE, mod] = await Promise.all([import('three'), import('mindar-image-three')]);
      try {
        const tf = window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.tf;
        if (tf && tf.ready) await tf.ready(); // initialise the GPU backend now, not on tap
      } catch {
        /* MindAR will initialise it itself */
      }
      return { THREE, mod };
    })();
    warmPromise.catch(() => {
      warmPromise = null; // a later tap retries cleanly
    });
  }
  return warmPromise;
}

function prefetchTarget() {
  const plan = scanPlan();
  if (plan) fetch(plan.src).catch(() => {}); // fills the browser cache; MindAR then loads it instantly
}

function scheduleWarmUp() {
  const conn = navigator.connection;
  if (conn && conn.saveData) return; // respect Data Saver
  const go = () => {
    warmUp().catch(() => {});
    prefetchTarget();
  };
  setTimeout(go, 50);
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
  let earlyObserver = null;

  try {
    if (!window.isSecureContext)
      throw Object.assign(new Error('insecure'), { userMessage: 'The camera only works on a secure (https) page.' });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw Object.assign(new Error('no getUserMedia'), {
        userMessage: 'This browser can’t open the camera. Try Safari (iPhone) or Chrome (Android).',
      });

    const plan = scanPlan();
    if (!plan) throw Object.assign(new Error('none'), { userMessage: 'Nothing to scan yet.' });
    const live = plan.list;
    const targetSrc = plan.src;

    $('loadText').textContent = 'Loading AR engine…';
    const { THREE, mod } = await warmUp();
    if (token !== startToken) return;
    $('loadText').textContent = 'Starting camera…';
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); // 3x phone screens are needlessly heavy

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
    const wantIndex = plan.indexOf;

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

    // Show the live camera the moment it is playing; MindAR keeps finishing its setup behind it.
    earlyObserver = new MutationObserver(() => {
      const cam = $('stageView').querySelector('video');
      if (!cam || cam.dataset.tnt) return;
      cam.dataset.tnt = '1';
      const reveal = () => {
        if (token !== startToken) return;
        $('loading').dataset.done = 'true';
        $('reticle').dataset.hidden = 'false';
        $('hint').dataset.hidden = 'false';
        setChip('scanning', 'Getting ready…');
        setupCamera(s);
      };
      if (cam.readyState >= 3 && !cam.paused) reveal();
      else cam.addEventListener('playing', reveal, { once: true });
    });
    earlyObserver.observe($('stageView'), { childList: true, subtree: true });

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
    setupCamera(s);
    if (!s.items.some((i) => i.on)) setChip('scanning', 'Looking for the art…');
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
    $('stageErrorDetail').textContent = String((e && (e.message || e.name)) || e).slice(0, 220);
    lastErrorWasEngine = /dynamically imported|Failed to fetch|importmap|resolve module|module specifier/i.test(String((e && e.message) || e));
    $('stageError').hidden = false;
  } finally {
    if (earlyObserver) earlyObserver.disconnect();
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
  resetCamera();
  $('stageView').replaceChildren();
  try { if (wakeLock) await wakeLock.release(); } catch { /* ignore */ }
  wakeLock = null;
  if (!keepStageOpen) {
    $('stage').hidden = true;
    document.body.style.overflow = '';
    stopOrbs = startOrbs($('orbs'));
  }
}

/* ------------------------- camera zoom + focus ------------------------- */
// Real camera zoom/focus where the phone's browser allows it (most Android Chrome-family
// browsers); on the rest (e.g. iPhone Safari) zoom falls back to a smooth digital zoom.
const cam = { track: null, caps: {}, zoom: 1, min: 1, max: 3, hw: false, video: null };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function setupCamera(s) {
  const video = s.mindar.video;
  const stream = video && video.srcObject;
  const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
  if (!track || cam.track === track) return;
  cam.track = track;
  cam.video = video;
  try {
    cam.caps = track.getCapabilities ? track.getCapabilities() : {};
  } catch {
    cam.caps = {};
  }
  // Make sure autofocus keeps working (some phones default to a fixed focus).
  if (cam.caps.focusMode && cam.caps.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  const z = cam.caps.zoom;
  cam.hw = !!(z && typeof z.max === 'number' && z.max > (z.min || 1));
  cam.min = cam.hw ? z.min || 1 : 1;
  cam.max = cam.hw ? Math.min(z.max, 5) : 3;
  const range = $('zoomRange');
  range.min = cam.min;
  range.max = cam.max;
  range.step = (cam.hw && z.step) || 0.1;
  $('zoomBar').hidden = false;
  applyZoom(cam.min);
}

function applyZoom(z) {
  z = clamp(z, cam.min, cam.max);
  cam.zoom = z;
  if (cam.hw && cam.track) cam.track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
  else $('stageView').style.transform = z > 1.001 ? `scale(${z})` : '';
  $('zoomRange').value = String(z);
  $('zoomLabel').textContent = `${z.toFixed(1)}\u00d7`;
}

function resetCamera() {
  cam.track = null;
  cam.video = null;
  cam.caps = {};
  cam.zoom = 1;
  $('zoomBar').hidden = true;
  $('stageView').style.transform = '';
}

let focusTimer;
function tapFocus(x, y) {
  const ring = el('div', { class: 'focus-ring' });
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  document.querySelectorAll('.focus-ring').forEach((r) => r.remove());
  $('stage').append(ring);
  setTimeout(() => ring.remove(), 1000);

  const track = cam.track;
  if (!track) return;
  const adv = {};
  const supported = (navigator.mediaDevices.getSupportedConstraints && navigator.mediaDevices.getSupportedConstraints()) || {};
  if (supported.pointsOfInterest && cam.video) {
    const r = cam.video.getBoundingClientRect();
    adv.pointsOfInterest = [{ x: clamp((x - r.left) / r.width, 0, 1), y: clamp((y - r.top) / r.height, 0, 1) }];
  }
  const modes = cam.caps.focusMode || [];
  if (modes.includes('single-shot')) adv.focusMode = 'single-shot';
  if (!Object.keys(adv).length) return; // this phone refuses manual focus; continuous autofocus is doing its job
  track.applyConstraints({ advanced: [adv] }).catch(() => {});
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (cam.track === track && modes.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }, 2500);
}

// pinch to zoom, tap to focus
{
  const stage = $('stage');
  const pts = new Map();
  let pinch = null;
  let tap = null;
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };
  const onUi = (e) => e.target.closest('button, input, .zoombar');
  stage.addEventListener('pointerdown', (e) => {
    if (onUi(e)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      pinch = { d: dist(), z: cam.zoom };
      tap = null;
    } else if (pts.size === 1) tap = { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) applyZoom(pinch.z * (dist() / pinch.d));
    else if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (tap && e.type === 'pointerup' && Date.now() - tap.t < 450) tapFocus(tap.x, tap.y);
    tap = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  $('zoomRange').addEventListener('input', (e) => applyZoom(parseFloat(e.target.value)));
  $('zoomIn').addEventListener('click', () => applyZoom(cam.zoom + 0.5));
  $('zoomOut').addEventListener('click', () => applyZoom(cam.zoom - 0.5));
}

/* ------------------------------ events ------------------------------ */
$('startBtn').addEventListener('click', () => {
  if ($('startBtn').dataset.nav) return;
  startAR();
});
$('closeBtn').addEventListener('click', () => stopAR());
$('errCloseBtn').addEventListener('click', () => stopAR());
$('retryBtn').addEventListener('click', () => {
  if (lastErrorWasEngine) {
    // Browsers remember a failed module download until the page reloads, so reload and reopen the camera.
    try { sessionStorage.setItem(RETRY_KEY, '1'); } catch { /* ignore */ }
    location.reload();
    return;
  }
  startAR();
});
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
