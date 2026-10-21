// overlays.js: 2D data overlays on #overlay (marks) + a few DOM labels in #hud.
// Owner: overlays agent. See CONTRACT.md (v0–v6). Never implies translation.
//
// Rule: the card carries the words, the 3D carries the meaning, the overlay adds at most one
// mark and about three words per frame. Labels are flat inverse-on-surface white in the
// production sans, tabular numerals, each tied to its mark by a 1px leader; no text halos.
// "Schematic" notes and credits live in the card foot, not here.
//
// v6 (layout C only): the canvas is the inset stage. Everything is placed inside `state.safe`
// ({x0,y0,x1,y1}, 0..1 of the canvas; y1 sits above the step bar docked at the stage foot) and
// sized by a stage tier (stage short side → mark scale `u` + production type sizes), so a 2560
// stage gets proportionate marks and a 375 phone stays uncrowded. Hairlines and dots snap to the
// device-pixel grid; labels sit on whole device pixels. Continuity: each shot's alpha follows
// sceneApi.shotWeight (the camera-blend curve; 1 settled, 0 at the switch point), falling back to
// a scroll envelope off state.t when scene doesn't publish it (test page).

const BASE = new URL('./', import.meta.url);

// fallback data (used until/unless data/*.json exist)
const FALLBACK_CODAS = {
  types: [
    { name: '1+1+3', clicks: 5, icis: [0.365, 0.352, 0.183, 0.172], ec1Pct: 46.0, ec2Pct: 0 },
    { name: '5R1', clicks: 5, icis: [0.095, 0.092, 0.074, 0.070], ec1Pct: 19.4, ec2Pct: 0 },
    { name: '4R2', clicks: 4, icis: [0.333, 0.324, 0.321], ec1Pct: 3.9, ec2Pct: 3.9 },
    { name: '5R2', clicks: 5, icis: [0.2, 0.2, 0.2, 0.2], ec1Pct: 3.7, ec2Pct: 0 },
    { name: '4D', clicks: 4, icis: [0.16, 0.16, 0.3], ec1Pct: 2.8, ec2Pct: 0 },
    { name: '5R3', clicks: 5, icis: [0.288, 0.288, 0.293, 0.300], ec1Pct: 0, ec2Pct: 65.6 },
    { name: '6R', clicks: 6, icis: [0.2, 0.2, 0.2, 0.2, 0.2], ec1Pct: 0, ec2Pct: 6.7 },
  ],
  exchange: null,
};

const ctx2 = {
  canvas: null, ctx: null, hud: null, W: 0, H: 0, dpr: 1,
  colors: {}, labels: new Map(), usedLabels: new Set(), widths: new Map(),
  codas: FALLBACK_CODAS, codasReal: false,
  pinchy: null,
  annotateModel: null, listenSchedule: null,
  cur: null, fadeStart: -1e9,
  retryTimer: null, hidden: false, reduced: false,
  hdx: 0, hdy: 0, tier: null, safeSm: null, sections: new Map(),
};

// utils
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a)); return k * k * (3 - 2 * k); };
function rgba(hex, a) {
  const h = (hex || '#ffffff').replace('#', '').trim();
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function mix(h1, h2, k) {
  const p = (h) => { const s = h.replace('#', ''); const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s; const n = parseInt(f, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const a = p(h1), b = p(h2);
  return '#' + a.map((v, i) => Math.round(lerp(v, b[i], k)).toString(16).padStart(2, '0')).join('');
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => (cs.getPropertyValue(name).trim() || fb);
  // text on the dark stage = the production inverse pair; data colours are the v0 data-viz tokens
  let text = v('--ngn-v2-sys-color-inverse-on-surface', v('--text', '#eaf2f6'));
  // the stage is always the dark ocean (?theme=light only lightens the text column): never let a
  // theme token turn the stage labels dark
  if (/^#[0-9a-f]{3,6}$/i.test(text)) {
    const h = text.length === 4 ? text.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : text;
    const n = parseInt(h.slice(1), 16), lum = (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    if (lum < 0.6) text = '#ffffff';
  }
  ctx2.colors = {
    ink: v('--ink', '#07131c'), text: /^#/.test(text) ? text : '#ffffff',
    a: v('--whale-a', '#ffb547'), b: v('--whale-b', '#5ad1e6'), c: v('--whale-c', '#f2728c'),
    echo: v('--echo', '#cfd8dc'),
  };
}

// Size from the canvas's own box (whatever box layout gives it), DPR-aware up to 2x.
function resize() {
  const { canvas, hud } = ctx2;
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // 2x is crisp enough; 3x phones pay 2.25x the fill for nothing
  const r = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(canvas.clientWidth || r.width || window.innerWidth));
  const H = Math.max(1, Math.round(canvas.clientHeight || r.height || window.innerHeight));
  // marks are canvas px, labels are #hud px: carry the offset (zero when they share a box)
  const hr = hud ? hud.getBoundingClientRect() : r;
  ctx2.hdx = (r.left || 0) - (hr.left || 0); ctx2.hdy = (r.top || 0) - (hr.top || 0);
  if (W !== ctx2.W || H !== ctx2.H || dpr !== ctx2.dpr) {
    ctx2.W = W; ctx2.H = H; ctx2.dpr = dpr;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx2.annotateModel = null; ctx2.anlPick = null; ctx2.sections.clear(); // size-dependent caches
  }
}

// Stage tiers, keyed to the short side of the visible subject area. The canvas is full-viewport
// and clipped to the inset frame (main.js), so the safe zone, not the canvas, is the stage size.
// `u` scales every mark dimension (dot radii, tick lengths, offsets, chart caps); type steps
// through production FontSizeSys tokens.
const TIERS = [
  // phones, landscape phones: Label_MD 13.6 / Title_MD 15 / Headline_LG 28
  { max: 460, u: 1, label: 13.6, key: 15, big: 28 },
  // laptop stages (~1280–1440 viewports), iPads: Label_LG 15 / Headline_XXS 16 / Display_SM 34
  { max: 700, u: 1.2, label: 15, key: 16, big: 34 },
  // 1920-class stages: Headline_XXS 16 / Headline_XS 19.3 / Display_MD 40
  { max: 1000, u: 1.45, label: 16, key: 19.3, big: 40 },
  // 2560-class stages: Headline_XS 19.3 / Title_LG 21.7 / Display_LG 48
  { max: Infinity, u: 1.8, label: 19.3, key: 21.7, big: 48 },
];
function setTier() {
  const s = ctx2.safeSm || SAFE_C;
  const S = Math.min((s.x1 - s.x0) * ctx2.W, (s.y1 - s.y0) * ctx2.H);
  // hysteresis: only change tier once the size is 4% past a boundary (no flicker while easing)
  if (ctx2.tier) {
    const i = TIERS.indexOf(ctx2.tier), lo = i > 0 ? TIERS[i - 1].max : 0, hi = ctx2.tier.max;
    if (S >= lo * 0.96 && S < hi * 1.04) return;
  }
  const t = TIERS.find((x) => S < x.max);
  if (ctx2.tier === t) return;
  ctx2.tier = t;
  if (ctx2.hud) {
    ctx2.hud.style.setProperty('--ov-fs-label', t.label + 'px');
    ctx2.hud.style.setProperty('--ov-fs-key', t.key + 'px');
    ctx2.hud.style.setProperty('--ov-fs-big', t.big + 'px');
  }
  for (const el of ctx2.labels.values()) el._w = null; // re-measure at the new size
}
const U = () => (ctx2.tier ? ctx2.tier.u : 1);

// state.safe as published (main.js already eases it); invalid or missing → C's default zone.
function validSafe(s) {
  return s && [s.x0, s.y0, s.x1, s.y1].every(Number.isFinite) && s.x1 - s.x0 > 0.1 && s.y1 - s.y0 > 0.1 ? s : null;
}
function updateSafe(state) {
  const s = validSafe(state.safe);
  ctx2.safeSm = s ? { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 } : null;
  setTier();
}

// Drawing region (CSS px, canvas space): state.safe minus an inner padding, so labels and end
// ticks never kiss the zone's edge or the step bar under it. Default = CONTRACT v5's C zone.
const SAFE_C = { x0: 0.06, y0: 0.08, x1: 0.94, y1: 0.92 };
function frame() {
  const { W, H } = ctx2;
  const s = ctx2.safeSm || SAFE_C;
  const u = U(), pad = Math.round(12 * u);
  const y0 = Math.round(s.y0 * H) + pad;
  return { u, x0: Math.round(s.x0 * W) + pad, x1: Math.round(s.x1 * W) - pad, y0, y1: Math.max(y0 + 120, Math.round(s.y1 * H) - pad), W, H };
}

// Boundary envelope: 0 at a section's top and bottom boundary, 1 inside. The ramp spans ~60% of a
// viewport of scroll, measured from the section's height (falls back to 6% of t).
function envWindow(shot) {
  let w = ctx2.sections.get(shot);
  if (w == null) {
    const el = document.querySelector(`.whale-scene[data-shot="${shot}"], .whale-hero[data-shot="${shot}"]`);
    const vh = window.innerHeight || 800;
    const span = el ? el.offsetHeight - vh : 0;
    w = span > vh ? clamp((0.6 * vh) / span, 0.02, 0.12) : 0.06;
    ctx2.sections.set(shot, w);
  }
  return w;
}
function shotEnvelope(shot, t, api, reduced) {
  // reduced motion: one static frame per shot, no camera blends → each shot fully present
  if (reduced) return 1;
  if (api && Number.isFinite(api.shotWeight)) {
    const w = clamp(api.shotWeight);
    // analyze sits under water next to patterns' aerial shot: steeper, so its marks are fully out
    // well before the camera starts to surface in the blend
    return shot === 'analyze' ? smooth(0.45, 0.9, w) : w;
  }
  const w = envWindow(shot);
  const tt = clamp(Number.isFinite(t) ? t : 0.5);
  return smooth(0, w, tt) * (1 - smooth(1 - w, 1, tt));
}

// HUD labels (reused DOM nodes). Roles map onto production type tokens.
// Sizes come from the stage tier (--ov-fs-* on #hud, see TIERS); line-height 1.1 keeps boxes tight.
const NUM = 'font-variant-numeric:tabular-nums lining-nums;font-feature-settings:"tnum" 1,"lnum" 1;';
const SANS = 'var(--font-sans,Lato,Helvetica,Arial,sans-serif)';
const ROLE = {
  label: `font:400 var(--ov-fs-label,13.6px)/1.15 ${SANS};letter-spacing:.02em;${NUM}`,
  key: `font:700 var(--ov-fs-key,15px)/1.1 ${SANS};letter-spacing:.01em;${NUM}`,
  big: `font:700 var(--ov-fs-big,28px)/1 ${SANS};${NUM}`,
};
function label(key, text, x, y, opts = {}) {
  const role = opts.role || 'label';
  let el = ctx2.labels.get(key);
  if (!el) {
    el = document.createElement('div');
    el.className = 'ov-label ov-' + role;
    // no will-change: a promoted layer can rasterise text at fractional offsets (soft in WebKit)
    el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;pointer-events:none;-webkit-font-smoothing:antialiased;' + ROLE[role];
    ctx2.hud.appendChild(el);
    ctx2.labels.set(key, el);
  }
  if (el._text !== text) { el.textContent = text; el._text = text; el._w = null; }
  const color = opts.color || ctx2.colors.text;
  if (el._color !== color) { el.style.color = color; el._color = color; }
  if (el._w == null) { el._w = el.offsetWidth; el._h = el.offsetHeight; }
  const w = el._w, hgt = el._h;
  if (opts.box) {
    const b = opts.box;
    const left = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x;
    x += left < b.x0 ? b.x0 - left : left + w > b.x1 ? b.x1 - (left + w) : 0;
  }
  const d = ctx2.dpr;
  // top-left on whole device pixels: crisp glyphs in Chromium, WebKit and Firefox alike
  const L = Math.round((opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x) * d) / d;
  const T = Math.round((opts.valign === 'top' ? y : opts.valign === 'bottom' ? y - hgt : y - hgt / 2) * d) / d;
  const tr = `translate(${(L + ctx2.hdx).toFixed(3)}px,${(T + ctx2.hdy).toFixed(3)}px)`;
  if (el._tr !== tr) { el.style.transform = tr; el._tr = tr; }
  const op = String(Math.round(clamp(opts.alpha ?? 1) * 1000) / 1000);
  if (el.style.opacity !== op) el.style.opacity = op;
  ctx2.usedLabels.add(key);
  return { l: L, t: T, r: L + w, b: T + hgt };
}
function hideAllLabels() {
  for (const el of ctx2.labels.values()) if (el.style.opacity !== '0') el.style.opacity = '0';
}
// 1px white leader at 80% from a label box to its mark
function leader(box, mx, my, alpha = 1) {
  if (!box) return;
  const { ctx } = ctx2;
  const cx = clamp(mx, box.l, box.r), cy = clamp(my, box.t, box.b);
  const u = U();
  const sx = Math.abs(mx - cx) > Math.abs(my - cy) ? (mx < box.l ? box.l - 4 * u : box.r + 4 * u) : cx;
  const sy = Math.abs(mx - cx) > Math.abs(my - cy) ? (box.t + box.b) / 2 : (my < box.t ? box.t - 3 * u : box.b + 3 * u);
  const d = Math.hypot(mx - sx, my - sy);
  if (d < 6 * u) return;
  const k = (d - 5 * u) / d; // stop just short of the mark
  ctx.strokeStyle = rgba(ctx2.colors.text, 0.8 * alpha); ctx.lineWidth = devW(1);
  // vertical/horizontal leaders snap to the device grid (crisp); diagonals stay anti-aliased
  const ex = sx + (mx - sx) * k, ey = sy + (my - sy) * k;
  const vert = Math.abs(ex - sx) < 0.5, horiz = Math.abs(ey - sy) < 0.5;
  const X0 = vert ? snap(sx) : sx, X1 = vert ? snap(sx) : ex, Y0 = horiz ? snap(sy) : sy, Y1 = horiz ? snap(sy) : ey;
  ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y1); ctx.stroke(); ctx.lineCap = 'round';
}
// soft, edgeless darkening behind a label that must sit over a brighter area (≈ −30% luminance)
function vignette(x, y, rx, ry, strength = 0.32) {
  const { ctx } = ctx2;
  ctx.save();
  ctx.translate(x, y); ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, `rgba(2,8,30,${strength})`); g.addColorStop(0.55, `rgba(2,8,30,${strength * 0.6})`); g.addColorStop(1, 'rgba(2,8,30,0)');
  ctx.fillStyle = g; ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
  ctx.restore();
}

// small canvas helpers, snapped to the DEVICE pixel grid so a 1px hairline is one crisp device
// pixel row (1x) or two (2x), never a blurred pair; widths round to whole device pixels.
function devW(w) { const d = ctx2.dpr; return Math.max(1, Math.round(w * d)) / d; }
function snap(v, w = 1) {
  const d = ctx2.dpr; const odd = Math.max(1, Math.round(w * d)) % 2;
  return (odd ? Math.round(v * d - 0.5) + 0.5 : Math.round(v * d)) / d;
}
function hline(x0, x1, y, color, w = 1) {
  const { ctx } = ctx2; const yy = snap(y, w);
  ctx.strokeStyle = color; ctx.lineWidth = devW(w); ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.lineCap = 'round';
}
function vline(x, y0, y1, color, w = 1) {
  const { ctx } = ctx2; const xx = snap(x, w);
  ctx.strokeStyle = color; ctx.lineWidth = devW(w); ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(xx, y0); ctx.lineTo(xx, y1); ctx.stroke(); ctx.lineCap = 'round';
}
// dots: centre on the device grid so equal radii render identically wherever they sit
function dot(x, y, r, color) {
  const { ctx, dpr } = ctx2;
  ctx.fillStyle = color; ctx.beginPath();
  ctx.arc(Math.round(x * dpr) / dpr, Math.round(y * dpr) / dpr, r, 0, Math.PI * 2); ctx.fill();
}

// data
async function fetchJson(name) {
  try {
    const r = await fetch(new URL('data/' + name, BASE), { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function loadData() {
  const [p, c] = await Promise.all([
    ctx2.pinchy ? ctx2.pinchy : fetchJson('pinchy-clicks.json'),
    ctx2.codasReal ? ctx2.codas : fetchJson('codas.json'),
  ]);
  if (p && Array.isArray(p.clicks) && !ctx2.pinchy) { ctx2.pinchy = p; ctx2.annotateModel = null; }
  if (c && Array.isArray(c.types) && c.types.length && !ctx2.codasReal) {
    ctx2.codas = { ...c, types: c.types.filter((t) => Array.isArray(t.icis) && t.icis.length) };
    if (!ctx2.codas.types.length) ctx2.codas.types = FALLBACK_CODAS.types;
    ctx2.codasReal = true; ctx2.listenSchedule = null; analyzeCache = null;
  }
  if ((!ctx2.pinchy || !ctx2.codasReal) && !ctx2.retryTimer) {
    ctx2.retryTimer = setTimeout(() => { loadData(); }, 20000);
  }
}
function typeByName(name) {
  return ctx2.codas.types.find((t) => t.name === name) ||
    FALLBACK_CODAS.types.find((t) => t.name === name) || ctx2.codas.types[0];
}

// public API
export function initOverlays({ canvas, hud }) {
  ctx2.canvas = canvas; ctx2.hud = hud; ctx2.ctx = canvas.getContext('2d');
  readColors(); resize(); setTier();
  window.addEventListener('resize', resize);
  // production fonts arrive async: re-read tokens and re-measure label widths once loaded
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { readColors(); for (const el of ctx2.labels.values()) el._w = null; });
  }
  loadData();
  return { reload: loadData };
}

const FADE_SECONDS = 0.35;
// A cheap fingerprint of everything a frame depends on; when it matches the last drawn frame and
// nothing is animating, the canvas and hud are left as they are (no clear, no redraw).
function frameSig(state, api, env, kk) {
  const r = (v, q) => (Number.isFinite(v) ? Math.round(v / q) : 'x');
  const sf = state.safe || {};
  let sig = [state.shot, state.card && state.card.index, r(state.t, 1e-4), r(env, 1e-3), r(kk, 1e-3), ctx2.W, ctx2.H, ctx2.dpr,
    r(sf.x0, 1e-3), r(sf.y0, 1e-3), r(sf.x1, 1e-3), r(sf.y1, 1e-3), state.audio && state.audio.playing, r(state.audio && state.audio.currentTime, 0.02),
    state.reducedMotion ? 1 : 0, r(api.depth, 0.5), r(api.camera && api.camera.position && api.camera.position.y, 0.05)].join('|');
  if (api.project) {
    for (const n of ANCHORS) {
      let p = null; try { p = api.project(n); } catch { p = null; }
      sig += p && p.visible !== false ? `|${r(p.x, 0.25)},${r(p.y, 0.25)},${r(p.scale, 0.05)}` : '|-';
    }
  }
  return sig;
}
const ANCHORS = ['whaleA', 'whaleB', 'whaleC', 'whaleAHead', 'whaleBHead', 'whaleCHead', 'whale0', 'whale1', 'whale2', 'whale3', 'whale4', 'whale5', 'whale6'];

export function updateOverlays(state, dt = 0.016, sceneApi = {}) {
  if (!ctx2.ctx || !state) return;
  resize();
  const { ctx, dpr } = ctx2;

  // nothing on screen while the stage is off, or when there is no 3D behind the marks (no WebGL /
  // scene failed: main.js adds .no-webgl and passes no sceneApi): the card text carries the story
  const noScene = !sceneApi || document.documentElement.classList.contains('no-webgl');
  if (state.active === false || state.visibility === 0 || noScene) {
    if (ctx2.lastSig !== 'off') {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ctx2.canvas.width, ctx2.canvas.height);
      hideAllLabels(); ctx2.lastSig = 'off';
    }
    ctx2.cur = null;
    return;
  }
  ctx2.reduced = !!state.reducedMotion;
  // scene's fade is 1 since v6 (no fade-through-black); still honoured if it ever returns
  ctx2.fade = Number.isFinite(sceneApi && sceneApi.fade) ? clamp(sceneApi.fade) : 1;

  // Envelope = sceneApi.shotWeight (camera-blend curve, 0 at the switch point) or, without it, a
  // scroll ramp off state.t; either way the handoff is seamless and reverses on scroll-up.
  const env = shotEnvelope(state.shot, state.t, sceneApi, !!state.reducedMotion);
  const now = performance.now() / 1000;
  // Hard gate: only the current shot (state.shot) ever draws. A shot that is no longer current has
  // no code path to the canvas or the hud, whatever the frame timing. At a natural boundary its
  // weight has already reached 0; after a jump (progress rail) the new shot fades in over 0.35 s.
  if (state.shot !== ctx2.cur) {
    ctx2.cur = state.shot; ctx2.tw = {}; ctx2.anlPick = null; // per-shot tweens restart on entry
    ctx2.fadeStart = !ctx2.reduced && env > 0.02 ? now : -1e9;
  }
  updateSafe(state);
  const kk = smooth(0, 1, (now - ctx2.fadeStart) / FADE_SECONDS);

  const sig = frameSig(state, sceneApi, env, kk);
  if (!ctx2.animating && sig === ctx2.lastSig) return; // unchanged and settled: keep the last frame
  ctx2.lastSig = sig;
  ctx2.animating = kk < 1; // renderers and tweens set it while anything still moves

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx2.canvas.width, ctx2.canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2.usedLabels.clear();
  draw(state.shot, state, sceneApi, env * kk);

  for (const [key, el] of ctx2.labels) {
    if (!ctx2.usedLabels.has(key) && el.style.opacity !== '0') el.style.opacity = '0';
  }
}

// the hero and the conclusion carry themselves: nothing is drawn, nothing cross-fades into them
const NO_OVERLAY = new Set(['open', 'close']);
function draw(shot, st, api, alpha) {
  if (NO_OVERLAY.has(shot)) return;
  alpha *= ctx2.fade ?? 1;
  if (alpha <= 0.001) return;
  const r = RENDERERS[shot];
  if (!r) return;
  const { ctx } = ctx2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  try { r(st, api, alpha); } catch (e) { if (!draw._warned) { console.warn('[overlays]', shot, e); draw._warned = true; } }
  ctx.restore();
}

function getAnchor(api, name, fx, fy) {
  let p = null;
  try { p = api.project ? api.project(name) : null; } catch { p = null; }
  // clicks leave the head: prefer scene's `<name>Head` anchor when it exists
  if (/^whale[ABC]$/.test(name)) {
    let h = null;
    try { h = api.project(name + 'Head'); } catch { h = null; }
    if (h && Number.isFinite(h.x)) p = h;
  }
  if (!p || !Number.isFinite(p.x)) return { x: ctx2.W * fx, y: ctx2.H * fy, visible: true, scale: 8, fake: true };
  return p;
}

// observe: a precise instrument at the safe zone's right edge: a hairline ruler with an unlabelled
// tick every 100 m, the 700 m end labelled, and the live depth on a 2px amber index line whose
// numerals are centred on that line (tabular, so the readout never jitters as digits change).
function renderObserve(st, api, alpha) {
  const { colors, tier } = ctx2;
  const F = frame(), u = F.u;
  const depth = clamp(Number.isFinite(api.depth) ? api.depth : st.t * 700, 0, 700);
  const gx = F.x1 - Math.round(6 * u);
  const hh = F.y1 - F.y0;
  // the ruler's top sits below the bright ceiling band the camera sees early in the descent
  const gy0 = F.y0 + hh * 0.2, gy1 = F.y1 - Math.round(8 * u);
  const yOf = (m) => lerp(gy0, gy1, m / 700);
  const yd = snap(yOf(depth), 2);
  // the readout can sit high, near the bright surface: darken softly behind it (no text halo)
  if (depth < 250) vignette(gx - 64 * u, yd, 170 * u, 70 * u, 0.18 * (1 - depth / 250));
  vline(gx, yOf(0), yOf(700), rgba(colors.text, 0.42));
  for (let m = 0; m <= 700; m += 100) {
    const major = m === 0 || m === 700;
    hline(gx - Math.round((major ? 8 : 4) * u), gx, yOf(m), rgba(colors.text, major ? 0.85 : 0.45));
  }
  label('obs-700', '700 m', gx - Math.round(14 * u), yOf(700), { role: 'label', align: 'right', alpha: alpha * smooth(22 * u, 34 * u, Math.abs(yd - yOf(700))) });
  hline(gx - Math.round(12 * u), gx + Math.round(5 * u), yd, colors.a, 2);
  // unit then number, right to left from the index line, both centred on it: the numerals' cap
  // centre sits ~1/14 of the font size below the line box's centre, the unit's ~1/8 above its baseline
  const big = tier ? tier.big : 28;
  const ub = label('obs-unit', 'm', gx - Math.round(16 * u), yd + big * 0.07, { role: 'key', align: 'right', alpha });
  label('obs-depth', String(Math.round(depth)), (ub ? ub.l : gx - 30 * u) - Math.round(4 * u), yd - big * 0.04, { role: 'big', align: 'right', alpha });
}

// listen: coda rings from the two whales; widest ring = one body length
function buildListenSchedule() {
  const ev = [], codas = [];
  const ex = ctx2.codas.exchange;
  if (Array.isArray(ex) && ex.length >= 2) {
    const ids = [];
    for (const e of ex) if (!ids.includes(e.whale)) ids.push(e.whale);
    const t0 = Math.min(...ex.map((e) => e.t));
    for (const e of ex) {
      const icis = Array.isArray(e.icis) && e.icis.length ? e.icis : typeByName(e.type).icis;
      let t = e.t - t0;
      const who = ids.indexOf(e.whale) % 2 === 0 ? 'A' : 'B';
      const start = t;
      ev.push({ whale: who, t, type: e.type });
      for (const d of icis) { t += d; ev.push({ whale: who, t, type: e.type }); }
      codas.push({ whale: who, start, end: t, n: icis.length + 1 });
    }
    const end = Math.max(...ev.map((e) => e.t)) + 2.0;
    return { ev, codas, len: end, real: true };
  }
  const seq = ['1+1+3', '1+1+3', '5R1', '1+1+3', '4R2', '5R1', '1+1+3', '1+1+3'];
  let t = 0.4;
  seq.forEach((name, i) => {
    const who = i % 2 === 0 ? 'A' : 'B';
    const ty = typeByName(name);
    let c = t;
    ev.push({ whale: who, t: c, type: name });
    for (const d of ty.icis) { c += d; ev.push({ whale: who, t: c, type: name }); }
    codas.push({ whale: who, start: t, end: c, n: ty.icis.length + 1 });
    t = c + (i % 2 === 0 ? 0.55 : 1.1);
  });
  return { ev, codas, len: t + 1.5, real: false };
}

function ringsFor(anchor, clicks, now, color, life, maxR) {
  const { ctx } = ctx2; const u = U();
  for (const c of clicks) {
    const age = now - c;
    if (age < 0 || age > life) continue;
    const k = age / life;
    const r = 3 * u + (1 - Math.pow(1 - k, 2.2)) * maxR;
    ctx.strokeStyle = rgba(color, Math.pow(1 - k, 1.4) * 0.9);
    ctx.lineWidth = (1.5 * (1 - k) + 0.6) * Math.min(u, 1.5);
    ctx.beginPath(); ctx.arc(anchor.x, anchor.y, r, 0, Math.PI * 2); ctx.stroke();
  }
}


function renderListen(st, api, alpha) {
  const { ctx, colors } = ctx2;
  if (!ctx2.reduced) ctx2.animating = true; // rings + coda labels run on the clock
  const F = frame();
  const u = F.u;
  const A = getAnchor(api, 'whaleA', 0.36, 0.45);
  const B = getAnchor(api, 'whaleB', 0.66, 0.42);
  const bodyPx = (p) => clamp(11 * (p.scale || 8), 24 * u, Math.min(F.W, F.H) * 0.42);
  const life = 1.6;
  let clicksA = [], clicksB = [], now = 0;
  const playing = st.audio && st.audio.playing === 'pinchy-conversation' && ctx2.pinchy;

  if (ctx2.reduced) {
    // still end state: one body-length ring around each whale
    for (const [p, c] of [[A, colors.a], [B, colors.b]]) {
      if (p.visible === false) continue;
      ctx.strokeStyle = rgba(c, 0.7); ctx.lineWidth = devW(u > 1.3 ? 1.5 : 1);
      ctx.beginPath(); ctx.arc(p.x, p.y, bodyPx(p), 0, Math.PI * 2); ctx.stroke();
    }
  } else if (playing) {
    now = st.audio.currentTime || 0;
    const first = ctx2.pinchy.clicks[0] || {};
    for (const c of ctx2.pinchy.clicks) {
      if (c.t > now + 0.05 || c.t < now - life) continue;
      const sp = c.whale ?? c.speaker;
      // speaker unknown in the data → all rings from whaleA (no invented attribution)
      if (sp != null && String(sp) !== String(first.whale ?? first.speaker)) clicksB.push(c.t);
      else clicksA.push(c.t);
    }
  } else {
    if (!ctx2.listenSchedule) ctx2.listenSchedule = buildListenSchedule();
    const S = ctx2.listenSchedule;
    now = (st.time || 0) % S.len;
    for (const e of S.ev) {
      for (const tt of [e.t, e.t - S.len]) {
        if (now - tt >= 0 && now - tt <= life) (e.whale === 'A' ? clicksA : clicksB).push(tt);
      }
    }
  }
  if (!ctx2.reduced) {
    if (A.visible !== false) ringsFor(A, clicksA, now, colors.a, life, bodyPx(A));
    if (B.visible !== false) ringsFor(B, clicksB, now, colors.b, life, bodyPx(B));
  }
  // the coda label: appears with each real coda of the exchange (or of the recording while it
  // plays), beside the speaking whale's head, clear of every whale body
  // obstacles for listen's labels: the whale bodies AND the rings (widest ring = one body length)
  const caps = whaleCapsules(api);
  for (const P of [A, B]) if (P.visible !== false) caps.push({ ax: P.x, ay: P.y, bx: P.x, by: P.y, r: bodyPx(P) + 6 * u });
  let cur = null;
  if (playing && Array.isArray(ctx2.pinchy.codas)) {
    const d = ctx2.pinchy.codas.find((c) => Array.isArray(c) && c.length >= 3 && now >= c[0] - 0.05 && now <= c[c.length - 1] + 0.8);
    if (d) cur = { whale: 'A', n: d.length, start: d[0], end: d[d.length - 1] };
  } else if (ctx2.reduced) {
    const S = ctx2.listenSchedule || (ctx2.listenSchedule = buildListenSchedule());
    cur = S.codas[0] ? { ...S.codas[0], hold: true } : null;
  } else if (ctx2.listenSchedule) {
    cur = ctx2.listenSchedule.codas.find((c) => now >= c.start - 0.05 && now <= c.end + 0.8) || null;
  }
  if (cur) {
    const P = cur.whale === 'B' ? B : A;
    if (P.visible !== false) {
      const k = cur.hold ? 1 : smooth(cur.start - 0.05, cur.start + 0.15, now) * (1 - smooth(cur.end + 0.5, cur.end + 0.8, now));
      const lw = 112 * u, lh = (ctx2.tier ? ctx2.tier.key : 15) * 1.3;
      // outside the widest ring, tied to it by a short leader
      const bx = placeNear('lisLbl' + cur.whale, P.x, P.y, lw, lh, bodyPx(P) + 14 * u, caps, F);
      const lb = label('lis-coda', `${cur.n}-click coda`, bx.l, bx.t, { role: 'key', align: 'left', valign: 'top', alpha: alpha * k, box: F });
      if (lb) {
        const cx = (lb.l + lb.r) / 2, cy = (lb.t + lb.b) / 2, d = Math.hypot(cx - P.x, cy - P.y) || 1, r = bodyPx(P);
        leader(lb, P.x + ((cx - P.x) / d) * r, P.y + ((cy - P.y) / d) * r, alpha * k);
      }
    }
  }
  // one brief "within one body length" moment as the pair closes (scroll-keyed, then fades)
  const mom = smooth(0.6, 0.65, st.t) * (1 - smooth(0.78, 0.83, st.t));
  if (mom > 0.01 && A.visible !== false && B.visible !== false) {
    const d = Math.hypot(B.x - A.x, B.y - A.y), body = 11 * ((A.scale + B.scale) / 2 || 8);
    if (d < body * 2.2 && d > 12 * u) {
      // a measuring line between the heads, lifted off them on the side away from the bodies
      let nx = -(B.y - A.y) / d, ny = (B.x - A.x) / d;
      if (ny > 0) { nx = -nx; ny = -ny; } // prefer above
      const off = 16 * u;
      const ax = A.x + nx * off, ay = A.y + ny * off, bx2 = B.x + nx * off, by = B.y + ny * off;
      ctx.strokeStyle = rgba(colors.text, 0.85 * mom); ctx.lineWidth = devW(1); ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx2, by);
      const tk = 5 * u;
      ctx.moveTo(ax - nx * tk, ay - ny * tk); ctx.lineTo(ax + nx * tk, ay + ny * tk);
      ctx.moveTo(bx2 - nx * tk, by - ny * tk); ctx.lineTo(bx2 + nx * tk, by + ny * tk);
      ctx.stroke(); ctx.lineCap = 'round';
      const mx = (ax + bx2) / 2, my = (ay + by) / 2;
      const lw = 170 * u, lh = (ctx2.tier ? ctx2.tier.label : 13.6) * 1.3;
      // above the pair, over the top of the higher widest ring, tied to the measuring line
      const ringTop = Math.min(A.y - bodyPx(A), B.y - bodyPx(B)) - 8 * u;
      const ly = Math.max(F.y0 + lh, ringTop);
      const lb = label('lis-body', 'within one body length', mx, ly, { role: 'label', align: 'center', valign: 'bottom', alpha: alpha * mom, box: F });
      leader(lb, mx, my, alpha * mom);
    }
  }
}

// ---- shared: card keying + whale-aware placement (annotate, analyze) -------------------------

// Which story card is being read. main.js publishes state.card.index (−1 between cards: hold the
// last one); the test page has none, so derive it from t across the section's five cards.
function cardIndex(st, key) {
  const c = st.card && Number.isFinite(st.card.index) ? st.card.index : null;
  if (c != null && c >= 0) { ctx2[key] = c; return c; }
  if (c == null) return Math.min(4, Math.floor(clamp(st.t) * 5));
  return ctx2[key] ?? 0;
}

// Projected whale bodies as capsules (head → tail segment + radius), from the centre and head anchors.
function whaleCapsules(api, roster = false) {
  const out = [];
  if (roster) { // patterns: the seven top-down whales have no head anchors → a body-sized disc each
    for (let i = 0; i < 7; i++) {
      let c = null; try { c = api.project ? api.project('whale' + i) : null; } catch { c = null; }
      if (c && c.visible !== false && Number.isFinite(c.x)) { const r = Math.max(10, 4.5 * (c.scale || 3)); out.push({ ax: c.x, ay: c.y, bx: c.x, by: c.y, r }); }
    }
    return out;
  }
  for (const n of ['whaleA', 'whaleB', 'whaleC']) {
    let c = null, h = null;
    try { c = api.project ? api.project(n) : null; h = api.project ? api.project(n + 'Head') : null; } catch { c = h = null; }
    if (!c || !h || c.visible === false || !Number.isFinite(c.x) || !Number.isFinite(h.x)) continue;
    const dx = h.x - c.x, dy = h.y - c.y;
    const r = Math.max(10, 2.2 * (h.scale || c.scale || 4)); // ~2 m body radius + margin
    out.push({ ax: h.x + dx * 0.3, ay: h.y + dy * 0.3, bx: c.x - dx * 1.3, by: c.y - dy * 1.3, r });
  }
  return out;
}
function boxHits(b, caps) {
  let hits = 0;
  for (const c of caps) {
    for (let k = 0; k <= 10; k++) {
      const x = lerp(c.ax, c.bx, k / 10), y = lerp(c.ay, c.by, k / 10);
      const dx = Math.max(b.l - x, 0, x - b.r), dy = Math.max(b.t - y, 0, y - b.b);
      if (dx * dx + dy * dy < c.r * c.r) { hits++; break; }
    }
  }
  return hits;
}
// Place a w×h box near an anchor, clear of every whale body and inside F. Keeps the previous
// side while it stays clear (no flip-flopping as the whales drift).
const SIDES = ['up', 'upRight', 'upLeft', 'right', 'left', 'down', 'downRight', 'downLeft'];
function placeNear(key, ax, ay, w, h, gap, caps, F) {
  const boxFor = (side) => {
    let l, t;
    if (side === 'up') { l = ax - w / 2; t = ay - gap - h; }
    else if (side === 'down') { l = ax - w / 2; t = ay + gap; }
    else if (side === 'right') { l = ax + gap; t = ay - h / 2; }
    else if (side === 'left') { l = ax - gap - w; t = ay - h / 2; }
    else if (side === 'upRight') { l = ax + gap * 0.7; t = ay - gap * 0.7 - h; }
    else if (side === 'upLeft') { l = ax - gap * 0.7 - w; t = ay - gap * 0.7 - h; }
    else if (side === 'downRight') { l = ax + gap * 0.7; t = ay + gap * 0.7; }
    else { l = ax - gap * 0.7 - w; t = ay + gap * 0.7; }
    // keep inside the safe zone
    l = clamp(l, F.x0, Math.max(F.x0, F.x1 - w)); t = clamp(t, F.y0, Math.max(F.y0, F.y1 - h));
    return { l, t, r: l + w, b: t + h, side };
  };
  const prev = ctx2[key + 'Side'];
  if (prev) { const b = boxFor(prev); if (!boxHits(b, caps)) return b; }
  let best = null, bestScore = Infinity;
  for (const side of SIDES) {
    const b = boxFor(side);
    const d = Math.hypot((b.l + b.r) / 2 - ax, (b.t + b.b) / 2 - ay);
    const score = boxHits(b, caps) * 1e5 + d;
    if (score < bestScore) { bestScore = score; best = b; }
  }
  ctx2[key + 'Side'] = best.side;
  return best;
}
// "nothing over whale bodies": punch the projected whale bodies out of what has been drawn so
// far this frame (the diagram reads as passing behind the whales). Canvas marks only.
function eraseWhales(caps) {
  if (!caps.length) return;
  const { ctx } = ctx2;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 1;
  ctx.strokeStyle = '#000'; ctx.lineCap = 'round';
  for (const c of caps) { ctx.lineWidth = c.r * 2; ctx.beginPath(); ctx.moveTo(c.ax, c.ay); ctx.lineTo(c.bx, c.by); ctx.stroke(); }
  ctx.restore();
}
// one 1px leader from a mark box to a head anchor (stops short of both)
function tether(b, hx, hy, alpha) {
  const cx = clamp(hx, b.l, b.r), cy = clamp(hy, b.t, b.b);
  const d = Math.hypot(hx - cx, hy - cy), u = U();
  if (d < 14 * u) return;
  const k0 = (4 * u) / d, k1 = 1 - (6 * u) / d;
  const { ctx } = ctx2;
  ctx.strokeStyle = rgba(ctx2.colors.text, 0.7 * alpha); ctx.lineWidth = devW(1);
  ctx.beginPath(); ctx.moveTo(lerp(cx, hx, k0), lerp(cy, hy, k0)); ctx.lineTo(lerp(cx, hx, k1), lerp(cy, hy, k1)); ctx.stroke();
}

// time tween toward a scroll-driven target (card index), so transitions animate yet reverse on
// scroll-up; snaps under reduced motion. Reset on shot entry.
function tween(key, target, secs = 0.6) {
  const now = performance.now() / 1000;
  const tw = ctx2.tw || (ctx2.tw = {});
  const o = tw[key] || (tw[key] = { v: ctx2.reduced ? target : 0, at: now });
  if (o.v === o.tg && target !== o.tg) o.at = now; // was settled (frames may have been skipped): start now
  o.tg = target;
  const dt = Math.min(0.25, now - o.at); o.at = now;
  if (ctx2.reduced) o.v = target;
  else { const k = dt / secs; o.v = o.v < target ? Math.min(target, o.v + k) : Math.max(target, o.v - k); }
  if (o.v !== target) ctx2.animating = true;
  // same smoothstep curve and duration in both directions: fades out exactly as it faded in
  return smooth(0, 1, o.v);
}

function buildAnnotateModel(plotW) {
  const P = ctx2.pinchy;
  let peaks, clicks, codas, duration, real = false, winStart = 0, winLen, echoIllus = false;
  if (P && Array.isArray(P.peaks) && P.peaks.length && P.duration) {
    real = true;
    duration = P.duration;
    const codaList = Array.isArray(P.codas) ? P.codas.filter((c) => Array.isArray(c) && c.length >= 3) : [];
    winLen = Math.min(duration, clamp((plotW / 620) * 16, 8.5, 18));
    let best = 0;
    for (const c of codaList) {
      const s = Math.max(0, Math.min(duration - winLen, c[0] - 0.6));
      const n = codaList.filter((d) => d[0] >= s && d[d.length - 1] <= s + winLen).length;
      if (n > best) { best = n; winStart = s; }
    }
    const i0 = Math.floor((winStart / duration) * P.peaks.length);
    const i1 = Math.ceil(((winStart + winLen) / duration) * P.peaks.length);
    peaks = P.peaks.slice(i0, Math.max(i0 + 2, i1));
    codas = codaList.filter((d) => d[0] >= winStart && d[d.length - 1] <= winStart + winLen)
      .map((d) => d.map((t) => t - winStart));
    const inCoda = new Set(codas.flat().map((t) => t.toFixed(4)));
    clicks = P.clicks.filter((c) => c.t >= winStart && c.t <= winStart + winLen)
      .map((c) => ({ t: c.t - winStart, amp: c.amp ?? 0.6 }));
    for (const c of clicks) c.social = inCoda.has(c.t.toFixed(4));
    for (const d of codas) for (const t of d) if (!clicks.some((c) => Math.abs(c.t - t) < 0.002)) clicks.push({ t, amp: 0.7, social: true });
    if (!codas.length) { real = false; peaks = null; }
    else if (clicks.filter((c) => !c.social).length < 6) {
      // detector output has no echolocation here: add an illustrative regular train in the longest gaps
      const edges = [0, ...codas.flatMap((d) => [d[0], d[d.length - 1]]), winLen];
      const gaps = [];
      for (let i = 0; i < edges.length; i += 2) gaps.push([edges[i] + 0.4, edges[i + 1] - 0.4]);
      gaps.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
      for (const [a, b] of gaps.slice(0, 2)) for (let t = a; t < b; t += 0.5) clicks.push({ t, amp: 0.3, social: false, illus: true });
      echoIllus = true;
    }
  }
  if (!real) {
    winLen = 14; duration = winLen;
    const R = rng(7);
    clicks = []; codas = [];
    for (let t = 0.3; t < 3.6; t += 0.55) clicks.push({ t, amp: 0.35 + R() * 0.1, social: false });
    for (let t = 10.6; t < 13.8; t += 0.55) clicks.push({ t, amp: 0.3 + R() * 0.1, social: false });
    const seq = [['1+1+3', 4.0], ['1+1+3', 5.55], ['5R1', 7.1], ['1+1+3', 8.0], ['4R2', 9.45]];
    for (const [name, start] of seq) {
      const ty = typeByName(name); let c = start; const d = [c];
      for (const ici of ty.icis) { c += ici; d.push(c); }
      codas.push(d);
      for (const t of d) clicks.push({ t, amp: 0.75 + R() * 0.2, social: true });
    }
    const n = 700; peaks = new Array(n);
    for (let i = 0; i < n; i++) peaks[i] = 0.04 + R() * 0.06;
    for (const c of clicks) {
      const i = Math.round((c.t / winLen) * (n - 1));
      for (let k = -2; k <= 2; k++) if (peaks[i + k] != null) peaks[i + k] = Math.max(peaks[i + k], c.amp * (1 - Math.abs(k) * 0.3));
    }
  }
  // speaker assignment: illustrative, alternating codas
  codas = codas.slice(0, 12);
  const clickInfo = new Map();
  codas.forEach((d, i) => d.forEach((t) => clickInfo.set(t.toFixed(4), { coda: i, speaker: i % 2 })));
  for (const c of clicks) {
    const info = clickInfo.get(c.t.toFixed(4));
    if (info) { c.social = true; c.coda = info.coda; c.speaker = info.speaker; } else { c.social = false; }
  }
  // the ghost: an interior click of a long coda (prefer the 2nd), removed from the detections
  let gi = codas.length > 1 && codas[1].length >= 4 ? 1 : codas.findIndex((d) => d.length >= 4);
  let ghost = null;
  if (gi >= 0) {
    const d = codas[gi]; const idx = Math.min(d.length - 2, 2);
    ghost = { t: d[idx], coda: gi, speaker: gi % 2 };
    clicks = clicks.filter((c) => Math.abs(c.t - ghost.t) > 1e-4);
  }
  return { peaks, clicks, codas, ghost, winLen, real, echoIllus, plotW };
}


// ---- annotate: the real Pinchy waveform ribbon along the stage foot; clicks lift out of it --------
// card 0: the ribbon draws in · card 1 "echolocation": the regular train drops below the ribbon,
// coda clicks rise · card 2 "coda": the coda clicks group under brackets · card 3–4 "inferred
// click": a missing click as a dashed amber ghost. ≤2 labels at once; one neutral colour + amber.
function renderAnnotate(st, api, alpha) {
  const { ctx, colors } = ctx2;
  const F = frame(), u = F.u;
  const card = cardIndex(st, 'annCard');
  const x0 = F.x0, x1 = F.x1;
  const qW = Math.max(160, Math.round((x1 - x0) / 48) * 48);
  if (!ctx2.annotateModel || ctx2.annotateModel.plotW !== qW) ctx2.annotateModel = buildAnnotateModel(qW);
  const M = ctx2.annotateModel;
  const pWave = tween('aWave', 1, 1.0), pSort = tween('aSort', card >= 1 ? 1 : 0, 0.8),
    pGroup = tween('aGroup', card >= 2 ? 1 : 0, 0.6), pGhost = tween('aGhost', card >= 3 ? 1 : 0, 0.5);
  const xOf = (tt) => lerp(x0, x1, tt / M.winLen);
  // stack, bottom-up from the step bar: echolocation row · ribbon · lifted codas · brackets · labels
  const ribbonH = Math.round(14 * u);
  const echoY = F.y1 - 10 * u;
  const ribbonY = echoY - 20 * u - ribbonH;
  const codaY = ribbonY - ribbonH - 22 * u;
  const brY = codaY - 9 * u;

  // the ribbon: real peaks, receding once the clicks have lifted out
  const reveal = lerp(x0, x1, pWave);
  const n = M.peaks.length;
  const bars = Math.max(2, Math.min(n, Math.floor((x1 - x0) / (2 * Math.max(1, Math.round(u))))));
  ctx.fillStyle = rgba(colors.echo, lerp(0.8, 0.3, pSort));
  for (let i = 0; i < bars; i++) {
    const x = lerp(x0, x1, i / (bars - 1));
    if (x > reveal) break;
    const a = Math.floor((i / bars) * n), b = Math.max(a + 1, Math.floor(((i + 1) / bars) * n));
    let m = 0; for (let jj = a; jj < b && jj < n; jj++) m = Math.max(m, M.peaks[jj] || 0);
    const hh = Math.max(0.5, m * ribbonH);
    ctx.fillRect(snap(x) - 0.5 / ctx2.dpr, ribbonY - hh, devW(1), hh * 2);
  }
  if (pWave > 0 && pWave < 1 && !ctx2.reduced) vline(reveal, ribbonY - ribbonH - 4 * u, ribbonY + ribbonH + 4 * u, rgba(colors.a, 0.8));

  // clicks lift out: echolocation drops below, coda clicks rise above
  let firstEcho = null, echoRunEnd = null, firstCoda = null;
  if (pSort > 0) {
    const echo = M.clicks.filter((c) => !c.social).sort((a, b) => a.t - b.t);
    for (const c of M.clicks) {
      const x = xOf(c.t);
      const lift = smooth(0, 1, clamp(pSort * 1.5 - (c.t / M.winLen) * 0.5));
      if (c.social) {
        const y = lerp(ribbonY, codaY, lift);
        dot(x, y, 2.75 * u, rgba(colors.text, 0.92 * lift + 0.08));
      } else {
        const y = lerp(ribbonY, echoY, lift);
        dot(x, y, 2 * u, rgba(colors.echo, 0.85 * lift + 0.05));
      }
    }
    if (echo.length) {
      // the label sits in the echolocation row's widest empty stretch (incl. both ends)
      const xsE = echo.map((c) => xOf(c.t));
      const gaps = [[F.x0, xsE[0]], ...xsE.slice(1).map((x, k) => [xsE[k], x]), [xsE[xsE.length - 1], F.x1]];
      gaps.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
      firstEcho = { x: xsE[0], y: echoY };
      echoRunEnd = { gap: gaps[0] };
    }
    if (M.codas.length) firstCoda = { x: xOf(M.codas[0][0]), y: codaY };
  }
  // grouping brackets, one per coda
  if (pGroup > 0) {
    ctx.lineWidth = devW(1); ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    M.codas.forEach((d, i) => {
      const k = smooth(0, 1, clamp(pGroup * 1.6 - i * 0.08));
      if (k <= 0) return;
      const xs = snap(xOf(d[0]) - 5 * u), xe = snap(xOf(d[d.length - 1]) + 5 * u), ys = snap(brY), tk = Math.round(4 * u);
      ctx.strokeStyle = rgba(colors.text, 0.8 * k);
      ctx.beginPath(); ctx.moveTo(xs, ys + tk); ctx.lineTo(xs, ys); ctx.lineTo(lerp(xs, xe, k), ys);
      if (k > 0.98) ctx.lineTo(xe, ys + tk);
      ctx.stroke();
    });
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  }
  // the ghost: a missing click, inferred, in one coda
  let ghost = null;
  if (M.ghost && pGhost > 0) {
    ghost = { x: xOf(M.ghost.t), y: codaY };
    ctx.setLineDash([2 * u, 2 * u]);
    ctx.strokeStyle = rgba(colors.a, 0.95 * pGhost); ctx.lineWidth = devW(u > 1.3 ? 1.5 : 1);
    ctx.beginPath(); ctx.arc(ghost.x, ghost.y, (ctx2.reduced ? 4.5 : 4.5 + 4 * (1 - pGhost)) * u, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  eraseWhales(whaleCapsules(api)); // nothing drawn over a whale body
  // labels (≤2): echolocation → coda → inferred click
  const wEcho = pSort * (1 - pGroup), wCoda = pGroup * (1 - pGhost);
  if (wEcho > 0.01 && echoRunEnd) {
    const [ga, gb] = echoRunEnd.gap;
    const edgeL = ga <= F.x0 + 1, edgeR = gb >= F.x1 - 1;
    const pad = (ctx2.tier ? ctx2.tier.key : 15) * 1.2; // ≥ one label-height of clear water each side
    const x = edgeL ? gb - pad : edgeR ? ga + pad : (ga + gb) / 2;
    const lb = label('ann-echo', 'echolocation', x, echoY, { role: 'key', align: edgeL ? 'right' : edgeR ? 'left' : 'center', alpha: alpha * wEcho, box: F });
    // too tight for the word: clear the echolocation dots under it (canvas only, this frame)
    if (lb && (lb.l < ga + pad - 1 || lb.r > gb - pad + 1)) {
      ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 1; ctx.fillStyle = '#000';
      ctx.fillRect(lb.l - pad, echoY - 5 * u, lb.r - lb.l + 2 * pad, 10 * u); ctx.restore();
    }
  }
  if (wCoda > 0.01 && firstCoda) {
    label('ann-coda', 'coda', firstCoda.x - 5 * u, brY - 5 * u, { role: 'key', align: 'left', valign: 'bottom', alpha: alpha * wCoda, box: F });
  }
  if (ghost) {
    label('ann-ghost', 'inferred click', ghost.x, brY - 5 * u, { role: 'key', align: 'center', valign: 'bottom', color: colors.a, alpha: alpha * pGhost, box: F });
  }
}

// analyze: one idea — codas bunch up at the surface just before a dive
// Surface rests ~17 min to match the card (Petri: 15–20 min); dives ~45 min to ~700 m. Schematic.
const DIVE = { surf: 17, down: 45, maxDepth: 700, descent: 10, ascent: 10 };
function diveDepthAt(min) {
  const cyc = DIVE.surf + DIVE.down;
  const m = ((min % cyc) + cyc) % cyc;
  if (m < DIVE.surf) return 0;
  const d = m - DIVE.surf;
  if (d < DIVE.descent) return DIVE.maxDepth * smooth(0, 1, d / DIVE.descent);
  if (d > DIVE.down - DIVE.ascent) return DIVE.maxDepth * smooth(0, 1, (DIVE.down - d) / DIVE.ascent);
  const ci = Math.floor(min / cyc);
  return DIVE.maxDepth - 40 - 45 * Math.sin(d * 0.9 + ci * 2.1) * Math.sin(d * 0.37);
}
let analyzeCache = null;
function buildAnalyze() {
  const R = rng(42);
  const cyc = DIVE.surf + DIVE.down;
  const span = 2 * cyc + DIVE.surf; // rest · dive · rest · dive · rest
  const codas = [];
  for (let c = 0; c <= 2; c++) {
    const s0 = c * cyc;
    const n = c === 2 ? 4 : 16 + Math.floor(R() * 4);
    for (let i = 0; i < n; i++) {
      const v = 1 - Math.pow(R(), 2.6); // skew late: right before the dive
      const m = s0 + DIVE.surf * lerp(0.15, 0.99, v);
      if (m <= span) codas.push({ m });
    }
  }
  codas.sort((a, b) => a.m - b.m);
  return { span, codas, cyc };
}
// ---- analyze: a thin dive trace with coda stacks on its surface line; the amber band ------------
// card 0: the trace draws in ("surface", "700 m") · card 1: coda stacks along the surface line ·
// card 2: the amber "before a dive" band (the "700 m" word gives way: ≤2 labels) · cards 3–4: off.
// The chart's height and position are chosen clear of the projected whales.
function renderAnalyze(st, api, alpha) {
  const { ctx, colors } = ctx2;
  const F = frame(), u = F.u;
  const card = cardIndex(st, 'anlCard');
  // presence fades in AND out on one symmetric tween: leaving card 2 for the vowel cards fades
  // the chart exactly as it came in (and back again on scroll-up), never an instant clear
  const on = card <= 2;
  const gA = tween('nPres', on ? 1 : 0, 0.6);
  if (gA <= 0.001) return;
  const camY = api.camera && api.camera.position && Number.isFinite(api.camera.position.y) ? api.camera.position.y : null;
  const under = camY != null ? 1 - smooth(-2.5, -0.5, camY) : (Number.isFinite(api.depth) ? smooth(0.5, 1.5, api.depth) : 1);
  const a = alpha * gA * under;
  if (a <= 0.01) return;
  ctx.globalAlpha *= gA * under;
  if (!analyzeCache) analyzeCache = buildAnalyze();
  const A = analyzeCache;
  const pTrace = tween('nTrace', 1, 1.2), pCodas = tween('nCodas', card >= 1 ? 1 : 0, 1.0), pBand = tween('nBand', card >= 2 ? 1 : 0, 0.6);
  void card;
  const caps = whaleCapsules(api);
  const labelW = Math.round(58 * u);
  const x0 = F.x0 + labelW, x1 = F.x1;
  const xOf = (m) => lerp(x0, x1, m / A.span);
  const step = Math.round(4.5 * u * 2) / 2;
  // header = the tallest coda stack + the band label above the surface line
  if (!A.rows || A.rowsW !== x1 - x0) {
    const st2 = new Map(); let rows = 0;
    for (const c of A.codas) { const k = Math.round((xOf(c.m) - x0) / step); const r = (st2.get(k) || 0) + 1; st2.set(k, r); rows = Math.max(rows, r); }
    A.rows = rows; A.rowsW = x1 - x0;
  }
  const headerH = Math.round(6 * u + A.rows * step + (ctx2.tier ? ctx2.tier.key : 15) * 1.2 + 14 * u);
  // choose where the header sits (clear of every whale body) and how deep the trace runs; the
  // trace and band then pass behind the whales (erased under their bodies)
  const zoneH = F.y1 - F.y0;
  const cand = (top, dh) => ({ top, dh, b: { l: F.x0, r: F.x1, t: top, b: top + headerH + 6 * u } });
  let pick = null;
  const prev = ctx2.anlPick;
  if (prev) { const c = cand(prev.top, prev.dh); if (c.top >= F.y0 && c.top + headerH + c.dh <= F.y1 + 1 && !boxHits(c.b, caps)) pick = c; }
  if (!pick) {
    let best = Infinity;
    for (const df of [1, 0.75, 0.5, 0.35]) {
      const dh = Math.max(40 * u, Math.min(zoneH - headerH, 300 * u) * df);
      for (let k = 0; k <= 14; k++) {
        const top = lerp(F.y0, F.y1 - headerH - dh, k / 14);
        if (top < F.y0 - 1) continue;
        const c = cand(top, dh);
        const sc = boxHits(c.b, caps) * 1e5 + (1 - df) * 300 + (top - F.y0) * 0.3;
        if (sc < best) { best = sc; pick = c; }
      }
    }
    if (!pick) pick = cand(F.y0, Math.max(40 * u, zoneH - headerH));
    ctx2.anlPick = { top: pick.top, dh: pick.dh };
  }
  const top = pick.top;
  const surfY = top + headerH, botY = surfY + pick.dh;
  const yOf = (d) => lerp(surfY, botY, d / 700);
  // the amber band: the last minutes at the surface before the second dive
  const diveStart = A.cyc + DIVE.surf;
  const bxa = xOf(diveStart - DIVE.surf * 0.42), bxb = xOf(diveStart + 1);
  if (pBand > 0) {
    const gy0 = surfY - headerH * 0.75;
    const g = ctx.createLinearGradient(0, gy0, 0, botY);
    g.addColorStop(0, rgba(colors.a, 0)); g.addColorStop(0.3, rgba(colors.a, 0.16 * pBand)); g.addColorStop(1, rgba(colors.a, 0));
    ctx.fillStyle = g; ctx.fillRect(bxa, gy0, bxb - bxa, botY - gy0);
  }
  hline(x0, x1, surfY, rgba(colors.text, 0.4));
  ctx.save();
  ctx.beginPath(); ctx.rect(x0 - 2, 0, (x1 - x0) * pTrace + 4, F.H); ctx.clip();
  ctx.strokeStyle = rgba(colors.b, 0.9); ctx.lineWidth = 1.25 * Math.min(u, 1.5);
  ctx.beginPath();
  for (let i = 0; i <= 500; i++) { const m = (i / 500) * A.span; const X = xOf(m), Y = yOf(diveDepthAt(m)); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
  ctx.stroke();
  ctx.restore();
  label('anl-y0', 'surface', F.x0, surfY, { role: 'label', align: 'left', alpha: a * pTrace });
  label('anl-y1', '700 m', F.x0, botY, { role: 'label', align: 'left', alpha: a * pTrace * (1 - pBand) });
  eraseWhales(caps); // trace + band pass behind the whales; the header was placed clear of them
  // codas: dot stacks on the surface line at the moment each was heard
  const stacks = new Map();
  let bandTop = surfY;
  for (const c of A.codas) {
    const k = smooth(0, 1, clamp(pCodas * 1.4 - (c.m / A.span) * 0.4));
    if (k <= 0) continue;
    const bucket = Math.round((xOf(c.m) - x0) / step);
    const row = stacks.get(bucket) || 0; stacks.set(bucket, row + 1);
    const x = x0 + bucket * step, y = surfY - 6 * u - row * step;
    const inBand = x >= bxa && x <= bxb;
    if (inBand) bandTop = Math.min(bandTop, y);
    dot(x, y, 2 * u, rgba(inBand ? mix(colors.text, colors.a, pBand) : colors.text, (inBand ? 1 : 0.75) * k));
  }
  if (pBand > 0) {
    const bl = label('anl-band', 'before a dive', (bxa + bxb) / 2, Math.max(top + 16 * u, bandTop - 12 * u), { role: 'key', color: colors.a, align: 'center', valign: 'bottom', alpha: a * pBand, box: { x0, x1 } });
    leader(bl, (bxa + bxb) / 2, bandTop - 5 * u, a * pBand);
  }
}

// patterns: who is close to whom — straight, even edges; one amber node
let patternEdges = null;
function buildEdges() {
  const R = rng(1234);
  const e = [];
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) {
    let w = R();
    if (i === 2 || j === 2) w = 0.45 + w * 0.55;
    e.push({ i, j, w });
  }
  e.sort((a, b) => b.w - a.w);
  return e.filter((x, k) => k < 12);
}
function renderPatterns(st, api, alpha) {
  const { ctx, colors } = ctx2;
  if (!ctx2.reduced) ctx2.animating = true; // the lead node's pulse runs on the clock
  const F = frame();
  if (!patternEdges) patternEdges = buildEdges();
  const t = st.t;
  const cx = (F.x0 + F.x1) / 2 / F.W, cy = 0.5;
  const nodes = [];
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + 0.3;
    const p = getAnchor(api, 'whale' + i, cx + Math.cos(ang) * 0.14, cy + Math.sin(ang) * 0.16);
    const ok = p.visible !== false && Number.isFinite(p.x) && Number.isFinite(p.y);
    const edge = ok ? Math.min(p.x, F.W - p.x, p.y, F.H - p.y) : -1;
    p.a = ok ? clamp(edge / (40 * F.u)) : 0; // fade out near the stage edge
    if (p.a <= 0) p.visible = false;
    nodes.push(p);
  }
  const prog = smooth(0.05, 0.6, t) * patternEdges.length;
  // phone stages get relatively heavier nodes/edges so the network reads at 375–430px
  const u = F.u;
  const nodeR = u === 1 ? 5.5 : 4.5 * u, leadR = nodeR + 1.25 * u;
  ctx.lineWidth = u === 1 ? 1.5 : Math.min(2, 1.1 * u);
  patternEdges.forEach((e, k) => {
    const g = clamp(prog - k * 0.85);
    if (g <= 0) return;
    const a = nodes[e.i], b = nodes[e.j];
    if (a.visible === false || b.visible === false) return;
    ctx.strokeStyle = rgba(colors.text, 0.6 * Math.min(a.a, b.a));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(lerp(a.x, b.x, g), lerp(a.y, b.y, g)); ctx.stroke();
  });
  const pLead = smooth(0.55, 0.72, t);
  nodes.forEach((p, i) => {
    if (p.visible === false) return;
    const lead = i === 2 && pLead > 0;
    dot(p.x, p.y, lead ? lerp(nodeR, leadR, pLead) : nodeR, rgba(lead ? mix(colors.text, colors.a, pLead) : colors.text, p.a));
  });
  const L = nodes[2];
  if (pLead > 0 && L.visible !== false) {
    // a small question beside the amber node (it stays a question: nobody knows yet)
    const lw = 84 * u, lh = (ctx2.tier ? ctx2.tier.label : 13.6) * 1.3;
    const pb = placeNear('patLead', L.x, L.y, lw, lh, leadR + 22 * u, whaleCapsules(api, true), F);
    label('pat-lead', 'who leads?', (pb.l + pb.r) / 2, (pb.t + pb.b) / 2, { role: 'label', align: 'center', alpha: alpha * pLead * L.a, box: F });
    if (ctx2.reduced) {
      ctx.strokeStyle = rgba(colors.a, 0.8 * pLead * L.a);
      ctx.lineWidth = 1.5 * Math.min(u, 1.5);
      ctx.beginPath(); ctx.arc(L.x, L.y, leadR + 8 * u, 0, Math.PI * 2); ctx.stroke();
    } else {
      const ph = ((st.time || 0) * 0.6) % 1;
      ctx.strokeStyle = rgba(colors.a, (1 - ph) * 0.9 * pLead * L.a); ctx.lineWidth = 1.5 * Math.min(u, 1.5);
      ctx.beginPath(); ctx.arc(L.x, L.y, leadR + 3 * u + ph * 22 * u, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

const RENDERERS = {
  open: () => {},
  observe: renderObserve,
  listen: renderListen,
  annotate: renderAnnotate,
  analyze: renderAnalyze,
  patterns: renderPatterns,
  close: () => {},
};
