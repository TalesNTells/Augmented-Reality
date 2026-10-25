// Shared UI bits: theme toggle + the drifting light-orb background used on the gate.
// (Both ported from the main Tales 'N' Tells site.)

export const ICONS = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  volumeOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  volumeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m23 9-6 6M17 9l6 6"/></svg>',
  arrowDown: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
};

export function initTheme(btn) {
  if (!btn) return;
  btn.innerHTML = ICONS.sun.replace('<svg', '<svg class="i-sun"') + ICONS.moon.replace('<svg', '<svg class="i-moon"');
  const root = document.documentElement;
  const sync = () => {
    const light = root.getAttribute('data-theme') === 'light';
    btn.setAttribute('aria-pressed', String(light));
    btn.setAttribute('aria-label', light ? 'Switch to night mode' : 'Switch to day mode');
  };
  sync();
  btn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch { /* private mode */ }
    sync();
  });
}

/** Soft light orbs that drift and swell near the pointer. Returns a stop() function. */
export function startOrbs(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, raf = 0;
  const mouse = { x: -1000, y: -1000 };
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    w = canvas.width = Math.max(1, Math.round(r.width));
    h = canvas.height = Math.max(1, Math.round(r.height));
  };
  resize();
  addEventListener('resize', resize);
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;
  };
  addEventListener('pointermove', onMove);

  const orbs = Array.from({ length: 8 }, () => {
    const base = Math.random() * 150 + 100;
    const o = Math.random() * 0.15 + 0.05;
    return {
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5,
      base, r: base,
      color: Math.random() > 0.5 ? `rgba(255,255,255,${o})` : `rgba(0,255,255,${o})`,
    };
  });

  const light = () => document.documentElement.getAttribute('data-theme') === 'light';
  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = light() ? 'source-over' : 'screen';
    for (const o of orbs) {
      o.vx += (Math.random() - 0.5) * 0.02; o.vy += (Math.random() - 0.5) * 0.02;
      o.vx *= 0.99; o.vy *= 0.99;
      const dx = mouse.x - o.x, dy = mouse.y - o.y, d = Math.hypot(dx, dy);
      if (d < 400) {
        const f = (400 - d) / 400;
        o.vx += dx * f * 0.005; o.vy += dy * f * 0.005;
        o.r = o.base * (1 + f * 0.3);
      } else o.r += (o.base - o.r) * 0.05;
      o.x += o.vx; o.y += o.vy;
      if (o.x < -o.r) o.x = w + o.r;
      if (o.x > w + o.r) o.x = -o.r;
      if (o.y < -o.r) o.y = h + o.r;
      if (o.y > h + o.r) o.y = -o.r;
      const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
      // in day mode the white orbs would vanish, so tint them crimson instead
      g.addColorStop(0, light() ? o.color.replace(/255,255,255|0,255,255/, '225,29,72') : o.color);
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill();
    }
    if (!reduce) raf = requestAnimationFrame(draw);
  };
  draw();
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener('resize', resize);
    removeEventListener('pointermove', onMove);
  };
}

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}
