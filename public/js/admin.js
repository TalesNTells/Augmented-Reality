// Admin dashboard.
//
// Adding an artwork does this, all in the browser of whoever is logged in:
//   1. shrink the artwork photo (max 1280px) and do a quick "will it track?" check
//   2. compile a MindAR target file (.mind) for that one artwork        → used by its QR page
//   3. upload photo + .mind + animation video to storage
//   4. save the artwork in the manifest
//   5. rebuild the combined .mind of ALL artworks                       → used by the main scanner

import { CONFIG } from './config.js';
import { ICONS, initTheme, el } from './ui.js';

const root = document.getElementById('root');
initTheme(document.getElementById('themeToggle'));
const logoutBtn = document.getElementById('logoutBtn');

let session = { authed: false, mode: 'local' };
let manifest = { artworks: [], combined: null };

/* ----------------------------- helpers ----------------------------- */
async function api(action, { method = 'POST', body } = {}) {
  const r = await fetch(`/api/admin?action=${action}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-tnt-admin': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && action !== 'login') {
    session.authed = false;
    renderLogin();
    throw new Error('Please log in again.');
  }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

let toastTimer;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', { class: 'toast', role: 'status', text: msg });
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

const rand = () => Math.random().toString(36).slice(2, 10);
const publicUrl = (a) => `${location.origin}/a/${a.slug}`;

// Classic <script> loader (used for the QR library). Remembers the in-flight promise so
// two callers share one load, and forgets failures so a retry really retries.
const scriptLoads = new Map();
function loadScript(src) {
  if (scriptLoads.has(src)) return scriptLoads.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => {
      s.remove();
      scriptLoads.delete(src);
      reject(new Error(`Couldn’t load a required library (${new URL(src).hostname}). Check your internet connection.`));
    };
    document.head.append(s);
  });
  scriptLoads.set(src, p);
  return p;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Couldn’t read that image.'));
    img.src = src;
  });
}

function loadVideoMeta(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight, duration: v.duration });
    v.onerror = () => reject(new Error('Couldn’t read that video. Use an MP4 (H.264).'));
    v.src = src;
  });
}

/* ------------------------- image preparation ------------------------ */
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const max = 1280;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
    return { blob, width: w, height: h, aspect: h / w, srcWidth: img.naturalWidth, srcHeight: img.naturalHeight, tracking: trackingHint(c) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Rough "is there enough detail to lock onto?" check. A hint only — the real test is pointing a phone at it. */
function trackingHint(canvas) {
  const S = 256;
  const k = S / Math.max(canvas.width, canvas.height);
  const w = Math.max(8, Math.round(canvas.width * k));
  const h = Math.max(8, Math.round(canvas.height * k));
  const t = document.createElement('canvas');
  t.width = w;
  t.height = h;
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let strong = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = g[y * w + x + 1] - g[y * w + x - 1];
      const gy = g[(y + 1) * w + x] - g[(y - 1) * w + x];
      if (Math.hypot(gx, gy) > 40) strong++;
    }
  }
  const share = strong / ((w - 2) * (h - 2));
  if (share >= 0.1) return { level: 'good', text: 'Plenty of detail — this should track well.' };
  if (share >= 0.04) return { level: 'ok', text: 'Moderate detail. Should work; test it with a phone in normal room light.' };
  return { level: 'poor', text: 'Very little fine detail or contrast (large flat areas). The camera may struggle to lock on. A busier, higher-contrast image tracks far better.' };
}

/* ----------------------------- MindAR compile ----------------------------- */
// MindAR 1.2.5 ships mindar-image.prod.js as an ES *module* (export { Controller, Compiler, UI }),
// so it must be import()ed — a plain <script> tag can't read it.
let compilerPromise = null;
function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = import(/* @vite-ignore */ CONFIG.compilerUrl)
      .then((mod) => {
        const C = mod.Compiler || (mod.default && mod.default.Compiler) || (window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.Compiler);
        if (!C) throw new Error(`MindAR loaded but no Compiler was found (it exports: ${Object.keys(mod).join(', ') || 'nothing'}).`);
        return C;
      })
      .catch((e) => {
        compilerPromise = null; // allow a clean retry
        throw new Error(`Couldn’t load the MindAR compiler. ${e.message}`);
      });
  }
  return compilerPromise;
}

async function compileTargets(images, onProgress) {
  const Compiler = await loadCompiler();
  const compiler = new Compiler();
  await compiler.compileImageTargets(images, (p) => onProgress && onProgress(p));
  const buffer = await compiler.exportData();
  return new Blob([buffer], { type: 'application/octet-stream' });
}

/* -------------------------------- upload -------------------------------- */
async function uploadFile(pathname, blob, contentType, onProgress) {
  if (session.mode === 'blob') {
    const { upload } = await import(/* @vite-ignore */ CONFIG.blobClientUrl);
    const r = await upload(pathname, blob, {
      access: 'public',
      handleUploadUrl: '/api/admin?action=upload',
      contentType,
      multipart: blob.size > 8 * 1024 * 1024,
      onUploadProgress: ({ percentage }) => onProgress && onProgress(percentage),
    });
    return r.url;
  }
  // local dev storage
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/admin?action=upload-local&path=${encodeURIComponent(pathname)}`);
    xhr.setRequestHeader('x-tnt-admin', '1');
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress((e.loaded / e.total) * 100);
    xhr.onload = () => {
      try {
        const j = JSON.parse(xhr.responseText);
        xhr.status < 300 ? resolve(j.url) : reject(new Error(j.error || 'Upload failed'));
      } catch {
        reject(new Error('Upload failed'));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed (network).'));
    xhr.send(blob);
  });
}

/* ---------------------------- progress overlay ---------------------------- */
function busy(title) {
  const bar = el('i');
  const label = el('p', { class: 'micro', style: 'margin:14px 0 0;letter-spacing:.2em', text: 'Starting…' });
  const box = el(
    'div',
    { class: 'modal__box', style: 'max-width:420px;text-align:center' },
    el('div', { class: 'spinner', style: 'margin:0 auto 20px' }),
    el('h3', { class: 'display display--md', style: 'font-size:1.6rem', text: title }),
    el('div', { class: 'progress' }, bar),
    label,
    el('p', { class: 'help', style: 'margin-top:14px', text: 'Keep this tab open until it finishes.' })
  );
  const overlay = el('div', { class: 'modal', style: 'z-index:500' }, box);
  document.body.append(overlay);
  return {
    set(text, pct) {
      label.textContent = text;
      if (pct != null) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    },
    done() {
      overlay.remove();
    },
  };
}

/* ------------------------------ pipelines ------------------------------ */
async function rebuildCombined(ui, base = 0, span = 100) {
  const arts = manifest.artworks;
  const at = (p) => base + (span * p) / 100;
  if (!arts.length) {
    ui && ui.set('Clearing scanner…', at(100));
    const r = await api('combined', { body: { url: null, order: [] } });
    manifest = r.manifest;
    return;
  }
  ui && ui.set('Loading artwork images…', at(2));
  const imgs = [];
  for (const a of arts) imgs.push(await loadImage(a.imageUrl));
  const blob = await compileTargets(imgs, (p) => ui && ui.set(`Building the all-artworks scanner… ${Math.round(p)}%`, at(5 + p * 0.75)));
  ui && ui.set('Uploading scanner file…', at(85));
  const url = await uploadFile(`tnt-ar/combined/${Date.now()}-${rand()}.mind`, blob, 'application/octet-stream', (p) => ui && ui.set('Uploading scanner file…', at(85 + p * 0.1)));
  ui && ui.set('Saving…', at(97));
  const r = await api('combined', { body: { url, order: arts.map((a) => a.id) } });
  manifest = r.manifest;
}

async function saveArtwork({ existing, title, description, active, imageFile, videoFile, prepared, videoMeta }) {
  const ui = busy(existing ? 'Saving artwork' : 'Bringing it to life');
  try {
    let imageUrl = existing && existing.imageUrl;
    let mindUrl = existing && existing.mindUrl;
    let videoUrl = existing && existing.videoUrl;
    let aspect = existing && existing.aspect;
    const folder = `tnt-ar/a/${rand()}`;

    if (imageFile) {
      ui.set('Compiling tracking data…', 3);
      const img = await loadImage(URL.createObjectURL(prepared.blob));
      const mind = await compileTargets([img], (p) => ui.set(`Compiling tracking data… ${Math.round(p)}%`, 3 + p * 0.3));
      ui.set('Uploading image…', 35);
      imageUrl = await uploadFile(`${folder}/image.jpg`, prepared.blob, 'image/jpeg', (p) => ui.set('Uploading image…', 35 + p * 0.05));
      ui.set('Uploading tracking data…', 40);
      mindUrl = await uploadFile(`${folder}/target.mind`, mind, 'application/octet-stream', (p) => ui.set('Uploading tracking data…', 40 + p * 0.05));
      aspect = prepared.aspect;
    }
    if (videoFile) {
      const ext = (videoFile.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
      ui.set('Uploading animation…', 45);
      videoUrl = await uploadFile(`${folder}/animation.${ext}`, videoFile, videoFile.type || 'video/mp4', (p) => ui.set(`Uploading animation… ${Math.round(p)}%`, 45 + p * 0.3));
    }

    ui.set('Saving artwork…', 77);
    const r = await api('save', {
      body: { artwork: { id: existing && existing.id, title, description, active, imageUrl, videoUrl, mindUrl, aspect } },
    });
    manifest = r.manifest;

    // the all-artworks scanner only needs rebuilding when the set of images changed
    if (imageFile || !existing) await rebuildCombined(ui, 78, 22);
    ui.done();
    toast(existing ? 'Saved' : 'Artwork is live');
    return true;
  } catch (e) {
    ui.done();
    console.error(e);
    alert(`Something went wrong:\n\n${e.message}`);
    // the artwork may have been saved even if the scanner rebuild failed → refresh view
    try { manifest = await api('manifest', { method: 'GET' }); } catch { /* ignore */ }
    return false;
  } finally {
    renderDashboard();
  }
}

/* --------------------------------- views --------------------------------- */
function renderLogin() {
  logoutBtn.hidden = true;
  const err = el('p', { class: 'notice notice--err', hidden: true, role: 'alert' });
  const pw = el('input', { id: 'pw', class: 'input', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' });
  const form = el(
    'form',
    {
      class: 'card login',
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        btn.disabled = true;
        try {
          await api('login', { body: { password: pw.value } });
          session.authed = true;
          await boot();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          btn.disabled = false;
          pw.select();
        }
      },
    },
    el('span', { class: 'eyebrow', text: 'Admin' }),
    el('h1', { class: 'display display--md', style: 'margin-bottom:22px' }, 'Studio ', el('span', { class: 'accent', text: 'access' })),
    err,
    el('div', { class: 'field' }, el('label', { for: 'pw', text: 'Password' }), pw)
  );
  const btn = el('button', { class: 'btn btn--accent', type: 'submit', style: 'width:100%', text: 'Enter' });
  form.append(btn);
  root.replaceChildren(form);
  pw.focus();
}

function badge(a) {
  return el('span', { class: 'art__badge', 'data-on': String(a.active !== false), text: a.active !== false ? 'Live' : 'Paused' });
}

function renderDashboard() {
  logoutBtn.hidden = false;
  const arts = manifest.artworks;
  const missing = arts.filter((a) => !Number.isInteger(a.targetIndex));

  const head = el(
    'div',
    { class: 'admin__head' },
    el('div', {}, el('span', { class: 'eyebrow', text: 'Studio' }), el('h1', { class: 'display display--md' }, 'Living ', el('span', { class: 'accent', text: 'artworks' }))),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn btn--accent', type: 'button', onclick: () => openForm(null), text: '+ New artwork' }),
      arts.length ? el('button', { class: 'btn btn--ghost', type: 'button', title: 'Recompile the main scanner from every artwork', onclick: manualRebuild, text: 'Rebuild scanner' }) : null
    )
  );

  const notices = [];
  if (session.mode === 'unconfigured')
    notices.push(el('p', { class: 'notice notice--err', text: 'Storage isn’t connected. In Vercel: Storage → Create → Blob → connect to this project, then redeploy. Uploads are disabled until then.' }));
  if (session.mode === 'local')
    notices.push(el('p', { class: 'notice notice--warn', text: 'Local test mode — files are stored on this computer in ./.data. Deploy to Vercel with a Blob store for the real thing.' }));
  if (missing.length)
    notices.push(
      el(
        'p',
        { class: 'notice notice--warn' },
        `${missing.length} artwork${missing.length > 1 ? 's are' : ' is'} not in the main scanner yet (their QR pages already work). `,
        el('button', { class: 'btn btn--sm', type: 'button', onclick: manualRebuild, text: 'Rebuild scanner', style: 'margin-left:8px' })
      )
    );

  const list = arts.length
    ? el(
        'div',
        { class: 'list' },
        ...arts.map((a) =>
          el(
            'article',
            { class: 'card art' },
            el('div', { class: 'art__img' }, el('img', { src: a.imageUrl, alt: a.title, loading: 'lazy' }), badge(a)),
            el(
              'div',
              { class: 'art__body' },
              el('h3', { class: 'art__title', text: a.title }),
              el('div', { class: 'art__url', text: `/a/${a.slug}` }),
              a.description ? el('p', { class: 'help', text: a.description }) : null,
              el(
                'div',
                { class: 'art__actions' },
                el('button', { class: 'btn btn--sm', type: 'button', onclick: () => openQr(a), text: 'QR code' }),
                el('a', { class: 'btn btn--sm btn--ghost', href: `/a/${a.slug}`, target: '_blank', rel: 'noopener', text: 'Open' }),
                el('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => openForm(a), text: 'Edit' }),
                el('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => togglePause(a), text: a.active !== false ? 'Pause' : 'Resume' }),
                el('button', { class: 'btn btn--sm btn--ghost btn--danger', type: 'button', onclick: () => remove(a), text: 'Delete' })
              )
            )
          )
        )
      )
    : el(
        'div',
        { class: 'card', style: 'padding:48px 24px;text-align:center' },
        el('h2', { class: 'display display--md', style: 'margin-bottom:12px' }, 'Nothing ', el('span', { class: 'accent', text: 'alive' }), ' yet'),
        el('p', { class: 'lede', style: 'margin:0 auto 24px', text: 'Add your first artwork: upload the art, upload its animation, and get a QR code to put beside it.' }),
        el('button', { class: 'btn btn--accent', type: 'button', onclick: () => openForm(null), text: '+ New artwork' })
      );

  root.replaceChildren(el('div', { class: 'admin' }, head, ...notices, list));
}

async function manualRebuild() {
  const ui = busy('Rebuilding scanner');
  try {
    await rebuildCombined(ui, 0, 100);
    toast('Scanner rebuilt');
  } catch (e) {
    alert(`Couldn’t rebuild:\n\n${e.message}`);
  } finally {
    ui.done();
    renderDashboard();
  }
}

async function togglePause(a) {
  try {
    const r = await api('save', {
      body: { artwork: { id: a.id, title: a.title, description: a.description, active: a.active === false, imageUrl: a.imageUrl, videoUrl: a.videoUrl, mindUrl: a.mindUrl, aspect: a.aspect } },
    });
    manifest = r.manifest;
    toast(a.active === false ? 'Resumed' : 'Paused');
    renderDashboard();
  } catch (e) {
    alert(e.message);
  }
}

async function remove(a) {
  if (!confirm(`Delete “${a.title}”?\n\nIts QR code will stop working. This can’t be undone.`)) return;
  const ui = busy('Deleting');
  try {
    ui.set('Removing…', 10);
    const r = await api('delete', { body: { id: a.id } });
    manifest = r.manifest;
    await rebuildCombined(ui, 20, 80);
    toast('Deleted');
  } catch (e) {
    alert(e.message);
  } finally {
    ui.done();
    renderDashboard();
  }
}

/* ------------------------------ modal helpers ------------------------------ */
function modal(...children) {
  const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, el('div', { class: 'modal__box' }, ...children));
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  document.body.append(overlay);
  return { close, overlay };
}

function dropZone({ accept, label, hint, previewKind, current }) {
  const input = el('input', { type: 'file', accept });
  const body = el('div', { class: 'drop__title', text: label });
  const sub = el('div', { class: 'help', text: hint });
  const box = el('label', { class: 'drop' }, input, body, sub);
  const state = { file: null };
  let preview;
  const show = (url) => {
    preview && preview.remove();
    preview = previewKind === 'video' ? el('video', { src: url, muted: true, playsinline: true, controls: true, preload: 'metadata' }) : el('img', { src: url, alt: '' });
    // keep the invisible input on top so clicking still works, but allow video controls
    if (previewKind === 'video') preview.style.position = 'relative', (preview.style.zIndex = 2);
    box.prepend(preview);
    box.dataset.has = 'true';
  };
  if (current) {
    show(current);
    body.textContent = 'Replace file';
  }
  ['dragenter', 'dragover'].forEach((ev) => box.addEventListener(ev, (e) => (e.preventDefault(), (box.dataset.drag = 'true'))));
  ['dragleave', 'drop'].forEach((ev) => box.addEventListener(ev, () => (box.dataset.drag = 'false')));
  return { box, input, state, show, setHint: (t) => (sub.textContent = t), setLabel: (t) => (body.textContent = t) };
}

/* --------------------------------- form --------------------------------- */
function openForm(existing) {
  const title = el('input', { class: 'input', id: 'f-title', required: true, maxlength: '120', placeholder: 'e.g. A God’s Tantrum', value: existing ? existing.title : '' });
  const desc = el('textarea', { class: 'textarea', id: 'f-desc', maxlength: '500', placeholder: 'Optional note for your own reference' });
  desc.value = existing ? existing.description || '' : '';
  const active = el('input', { type: 'checkbox', id: 'f-active', style: 'width:18px;height:18px;accent-color:rgb(225 29 72)' });
  active.checked = existing ? existing.active !== false : true;

  const imgDrop = dropZone({ accept: 'image/jpeg,image/png,image/webp', label: 'Drop the artwork photo', hint: 'JPG / PNG — the clearest, flattest, best-lit picture of the finished art. Tap to choose.', previewKind: 'image', current: existing && existing.imageUrl });
  const vidDrop = dropZone({ accept: 'video/mp4,video/webm,video/quicktime', label: 'Drop the animation video', hint: 'MP4 (H.264) works everywhere. Tap to choose.', previewKind: 'video', current: existing && existing.videoUrl });

  const imgNote = el('div', { hidden: true });
  const vidNote = el('div', { hidden: true });
  let prepared = null;
  let videoMeta = null;
  let aspect = existing ? existing.aspect : null;

  const note = (box, kind, text) => {
    box.className = `notice ${kind ? 'notice--' + kind : ''}`;
    box.style.marginTop = '12px';
    box.textContent = text;
    box.hidden = !text;
  };

  const checkAspect = () => {
    if (!videoMeta || !aspect) return;
    const art = 1 / aspect;
    const vid = videoMeta.w / videoMeta.h;
    const diff = Math.abs(vid - art) / art;
    if (diff > 0.08) note(vidNote, 'warn', `This video is ${videoMeta.w}×${videoMeta.h} but the artwork is ${Math.round(art * 100) / 100}:1 (width:height). It will be cropped to fill the artwork — export the video at the same shape for the best result.`);
    else note(vidNote, 'ok', `Video shape matches the artwork (${videoMeta.w}×${videoMeta.h}).`);
  };

  imgDrop.input.addEventListener('change', async () => {
    const f = imgDrop.input.files[0];
    if (!f) return;
    try {
      prepared = await prepareImage(f);
      imgDrop.state.file = f;
      aspect = prepared.aspect;
      imgDrop.show(URL.createObjectURL(prepared.blob));
      imgDrop.setLabel('Replace file');
      const small = Math.max(prepared.srcWidth, prepared.srcHeight) < 600;
      const kind = prepared.tracking.level === 'good' ? 'ok' : prepared.tracking.level === 'ok' ? '' : 'warn';
      note(imgNote, kind, `${prepared.tracking.text}${small ? ' Also: the image is quite small — use a larger photo if you have one.' : ''}`);
      checkAspect();
    } catch (e) {
      prepared = null;
      imgDrop.state.file = null;
      note(imgNote, 'err', e.message);
    }
  });

  vidDrop.input.addEventListener('change', async () => {
    const f = vidDrop.input.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      videoMeta = await loadVideoMeta(url);
      vidDrop.state.file = f;
      vidDrop.show(url);
      vidDrop.setLabel('Replace file');
      checkAspect();
      if (f.size > 60 * 1024 * 1024) note(vidNote, 'warn', `This video is ${(f.size / 1048576).toFixed(0)} MB. Big videos load slowly on mobile data — under ~20 MB is ideal.`);
      if (/webm/.test(f.type)) note(vidNote, 'warn', 'WebM doesn’t play on older iPhones. Use MP4 (H.264) to be safe.');
    } catch (e) {
      vidDrop.state.file = null;
      videoMeta = null;
      note(vidNote, 'err', e.message);
    }
  });

  const errBox = el('p', { class: 'notice notice--err', hidden: true, role: 'alert' });
  const submit = el('button', { class: 'btn btn--accent', type: 'submit', text: existing ? 'Save changes' : 'Bring it to life' });
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel' });

  const form = el(
    'form',
    {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        errBox.hidden = true;
        const fail = (m) => ((errBox.textContent = m), (errBox.hidden = false), errBox.scrollIntoView({ block: 'nearest' }));
        if (session.mode === 'unconfigured') return fail('Storage isn’t connected yet — see the banner on the dashboard.');
        if (!title.value.trim()) return fail('Give the artwork a title.');
        if (!existing && !prepared) return fail('Add the artwork photo.');
        if (!existing && !vidDrop.state.file) return fail('Add the animation video.');
        submit.disabled = true;
        m.close();
        await saveArtwork({
          existing,
          title: title.value.trim(),
          description: desc.value.trim(),
          active: active.checked,
          imageFile: prepared ? imgDrop.state.file : null,
          videoFile: vidDrop.state.file || null,
          prepared,
          videoMeta,
        });
      },
    },
    el('span', { class: 'eyebrow', text: existing ? 'Edit' : 'New' }),
    el('h2', { class: 'display display--md', style: 'margin-bottom:22px' }, existing ? 'Edit ' : 'New ', el('span', { class: 'accent', text: 'artwork' })),
    errBox,
    el('div', { class: 'field' }, el('label', { for: 'f-title', text: 'Title' }), title),
    el('div', { class: 'field' }, el('span', { class: 'label', text: '1 · The artwork' }), imgDrop.box, imgNote, el('p', { class: 'help', text: existing ? 'Only replace this if the physical artwork changed — it re-trains the tracking.' : 'This is what the camera will recognise. Use the same image that is printed/displayed.' })),
    el('div', { class: 'field' }, el('span', { class: 'label', text: '2 · The animation' }), vidDrop.box, vidNote, el('p', { class: 'help', text: 'Plays on top of the artwork, cropped to the artwork’s shape. Looping is automatic.' })),
    el('div', { class: 'field' }, el('label', { for: 'f-desc', text: 'Note (optional)' }), desc),
    el('label', { class: 'row', style: 'align-items:center;margin-bottom:22px;cursor:pointer' }, active, el('span', { class: 'label', text: 'Live (visitors can see it)' })),
    el('div', { class: 'row' }, submit, cancel)
  );
  const m = modal(form);
  cancel.addEventListener('click', m.close);
  title.focus();
}

/* ---------------------------------- QR ---------------------------------- */
async function openQr(a) {
  const url = publicUrl(a);
  const canvas = el('canvas');
  const body = el('div', { class: 'qr' }, canvas);
  const status = el('p', { class: 'help', text: '' });
  const m = modal(
    el('span', { class: 'eyebrow', text: 'QR code' }),
    el('h2', { class: 'display display--md', text: a.title }),
    body,
    el('p', { class: 'mono', style: 'font-size:12px;word-break:break-all;text-align:center;margin:0 0 6px', text: url }),
    status,
    el(
      'div',
      { class: 'row', style: 'margin-top:16px' },
      el('button', { class: 'btn btn--sm', type: 'button', text: 'Download PNG', onclick: () => download('png') }),
      el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Download SVG', onclick: () => download('svg') }),
      el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Copy link', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link:', url); } } }),
      el('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Close', onclick: () => m.close() })
    ),
    el('p', { class: 'help', style: 'margin-top:16px', text: 'Print it at least 2.5 cm (1 inch) wide and place it next to the artwork. Scanning it with the phone’s normal camera opens this artwork’s AR page.' })
  );
  try {
    await loadScript(CONFIG.qrUrl);
    await window.QRCode.toCanvas(canvas, url, { width: 520, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  } catch (e) {
    body.replaceChildren(el('p', { class: 'notice notice--err', text: e.message }));
  }
  async function download(kind) {
    try {
      await loadScript(CONFIG.qrUrl);
      let href;
      if (kind === 'png') href = await window.QRCode.toDataURL(url, { width: 1200, margin: 4, errorCorrectionLevel: 'M' });
      else {
        const svg = await window.QRCode.toString(url, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' });
        href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      }
      const link = el('a', { href, download: `qr-${a.slug}.${kind}` });
      document.body.append(link);
      link.click();
      link.remove();
    } catch (e) {
      alert(e.message);
    }
  }
}

/* --------------------------------- boot --------------------------------- */
logoutBtn.addEventListener('click', async () => {
  try { await api('logout'); } catch { /* ignore */ }
  session.authed = false;
  renderLogin();
});

async function boot() {
  try {
    const s = await (await fetch('/api/admin?action=session')).json();
    session = { ...session, ...s };
    if (!s.authed) return renderLogin();
    manifest = await api('manifest', { method: 'GET' });
    renderDashboard();
  } catch (e) {
    root.replaceChildren(el('div', { class: 'admin' }, el('p', { class: 'notice notice--err', text: e.message || 'Couldn’t reach the server.' })));
  }
}

boot();
