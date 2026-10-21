// Scroll engine (CONTRACT v2 + v5): computes `state` once per frame, fades the fixed #stage,
// drives scene.js + overlays.js, plays the Project CETI recordings, runs the story nav
// (progress rail + global sound toggle), shows the stage full-bleed in the hero and as the
// scenes' inset frame (CONTRACT v7) and publishes the subject safe zone.
import { initScene } from './scene.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

const root = document.documentElement;
const stage = document.getElementById('stage');
const glCanvas = document.getElementById('gl');
const overlayCanvas = document.getElementById('overlay');
const hud = document.getElementById('hud');
const nav = document.querySelector('.whale-nav');

const frameEl = document.querySelector('.whale-frame');

// Immersive sections in story order: the hero (`open`) then each .whale-scene.
const sections = [...document.querySelectorAll('.whale-hero[data-shot], .whale-scene[data-shot]')];
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

// Per-section reading elements: the text the subject must stay clear of, and the steps (cards).
const sectionInfo = sections.map((el) => ({
	el,
	text: [...el.querySelectorAll('.whale-hero__hed, .whale-scene__heading, .whale-card, .whale-trivia')],
	steps: [...el.querySelectorAll('.whale-step')],
	heading: el.querySelector('.whale-scene__heading')?.textContent.trim() || '',
}));

const state = {
	shot: sections[0]?.dataset.shot || 'open',
	index: 0,
	t: 0,
	p: 0,
	time: 0,
	active: true,
	visibility: 1,
	reducedMotion: reducedMotionQuery.matches,
	audio: { playing: null, currentTime: 0, muted: false },
	layout: 'c',
	// 0 = full-bleed hero, 1 = the scenes' inset frame (v7: a switch, never an animated morph).
	inset: 0,
	// v6: the visible stage window now, 0..1 of the canvas (the canvas stays full-viewport;
	// #stage is clipped to this box).
	frame: { x0: 0, y0: 0, x1: 1, y1: 1 },
	// v5: where subjects/data may sit, 0..1 of the canvas box.
	safe: { x0: 0.06, y0: 0.08, x1: 0.94, y1: 0.92 },
	// Which card of the current section is being read (-1 = the opener), of how many.
	card: { index: -1, count: 0 },
};
reducedMotionQuery.addEventListener?.('change', (e) => { state.reducedMotion = e.matches; });

// The inset frame box (viewport px), read from the invisible .whale-frame so CSS owns the
// geometry per breakpoint. Re-read on resize; svh keeps it steady through iOS bar slides.
const frameBox = { l: 0, t: 0, r: 0, b: 0, radius: 0, stacked: true };
function measureFrame() {
	const r = frameEl ? frameEl.getBoundingClientRect() : null;
	const W = stage.clientWidth || window.innerWidth;
	const H = stage.clientHeight || window.innerHeight;
	if (!r || !r.width) {
		Object.assign(frameBox, { l: 0, t: 0, r: W, b: H * 0.52, radius: 0, stacked: true });
		return;
	}
	const radius = parseFloat(getComputedStyle(root).getPropertyValue('--frame-radius')) || 0;
	Object.assign(frameBox, { l: r.left, t: r.top, r: r.right, b: r.bottom, radius, stacked: r.left < 1 });
}
measureFrame();
window.addEventListener('resize', measureFrame, { passive: true });


const lastScene = [...document.querySelectorAll('.whale-scene')].pop() || null;
const firstScene = document.querySelector('.whale-scene');
// v7: no animated morph. In the hero the stage is the full-bleed hero image. In the scenes the
// stage element itself takes the frame box (#stage.is-framed: CSS owns the geometry per
// breakpoint), so the canvas renders only what is seen; it behaves like a sticky element,
// sliding up with the first scene until it pins and away with the last scene (a translate,
// never a resize). The one size switch happens at the hero→scene boundary, while the frame is
// still below the viewport, so it never shows.
let lastTransform = '';
let framed = false;
function applyStage(inScenes) {
	let shift = 0;
	if (inScenes !== framed) {
		framed = inScenes;
		stage.classList.toggle('is-framed', framed);
		window.dispatchEvent(new Event('resize')); // scene + overlays re-read the canvas box
	}
	if (!inScenes) {
		state.inset = 0;
		stageArrived = false;
	} else {
		const gutter = frameBox.stacked ? 0 : frameBox.t;
		const firstTop = firstScene ? firstScene.getBoundingClientRect().top : -Infinity;
		const lastBottom = lastScene ? lastScene.getBoundingClientRect().bottom : Infinity;
		if (firstTop + gutter > frameBox.t) shift = firstTop + gutter - frameBox.t;
		else if (lastBottom - gutter < frameBox.b) shift = lastBottom - gutter - frameBox.b;
		state.inset = 1;
		stageArrived = Math.abs(shift) < 1;
	}
	// The canvas is the visible stage in both modes.
	state.frame.x0 = 0; state.frame.y0 = 0; state.frame.x1 = 1; state.frame.y1 = 1;
	const tf = shift ? `translate3d(0, ${shift.toFixed(1)}px, 0)` : 'none';
	if (tf !== lastTransform) { stage.style.transform = tf; lastTransform = tf; }
	return null;
}
let stageArrived = false;

// No WebGL: skip the scene (three.js would log context errors) and show the still fallback.
function hasWebGL() {
	try {
		const c = document.createElement('canvas');
		return !!(c.getContext('webgl2') || c.getContext('webgl'));
	} catch (e) {
		return false;
	}
}

let sceneApi = null;
if (hasWebGL()) {
	try {
		sceneApi = initScene(glCanvas);
	} catch (err) {
		console.warn('[whale-scroll] scene unavailable, showing the still fallback:', err && err.message);
		root.classList.add('no-webgl');
	}
} else {
	root.classList.add('no-webgl');
}

// Overlays are optional: the page must work without overlays.js.
let overlays = null;
let overlayErrored = false;
(async () => {
	try {
		const mod = await import('./overlays.js');
		if (typeof mod.initOverlays === 'function') {
			await Promise.resolve(mod.initOverlays({ canvas: overlayCanvas, hud }));
		}
		overlays = mod;
	} catch (err) {
		console.info('[whale-scroll] overlays unavailable:', err && err.message);
	}
})();

// Audio: one shared element; buttons carry aria-pressed + data-state (idle|playing|error).
const audio = new Audio();
audio.preload = 'none';
let currentBtn = null;
const buttons = [...document.querySelectorAll('button[data-audio]')];

function setPlaying(btn) {
	buttons.forEach((b) => {
		const on = b === btn;
		b.setAttribute('aria-pressed', on ? 'true' : 'false');
		if (b.dataset.state !== 'error') b.dataset.state = on ? 'playing' : 'idle';
	});
	currentBtn = btn;
	state.audio.playing = btn ? btn.dataset.audio : null;
	if (!btn) state.audio.currentTime = 0;
}

function markUnavailable(btn) {
	const label = btn.querySelector('.whale-audio__label') || btn;
	if (!btn.dataset.origLabel) btn.dataset.origLabel = label.textContent;
	label.textContent = 'Recording unavailable';
	btn.dataset.state = 'error';
	btn.setAttribute('aria-disabled', 'true');
	setTimeout(() => {
		label.textContent = btn.dataset.origLabel;
		btn.dataset.state = 'idle';
		btn.removeAttribute('aria-disabled');
	}, 3000);
}

audio.addEventListener('ended', () => setPlaying(null));
audio.addEventListener('error', () => {
	if (currentBtn) markUnavailable(currentBtn);
	setPlaying(null);
});

// Global sound toggle: mutes/unmutes every clip; remembered for this tab (sessionStorage).
const soundBtn = document.querySelector('.whale-sound');
const MUTE_KEY = 'whale-scroll:muted';
function readMuted() {
	try { return sessionStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
}
function setMuted(m) {
	state.audio.muted = m;
	audio.muted = m;
	try { sessionStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch (e) { /* private mode: not remembered */ }
	root.classList.toggle('is-muted', m);
	if (soundBtn) {
		soundBtn.dataset.muted = String(m);
		const label = soundBtn.querySelector('.whale-sound__label');
		// The control names its action.
		if (label) label.textContent = m ? 'Unmute' : 'Mute';
		soundBtn.setAttribute('aria-label', m ? 'Unmute story recordings' : 'Mute story recordings');
	}
}
setMuted(readMuted());
soundBtn?.addEventListener('click', () => setMuted(!state.audio.muted));

buttons.forEach((btn) => {
	btn.dataset.state = 'idle';
	btn.addEventListener('click', () => {
		if (btn.dataset.state === 'error') return;
		const slug = btn.dataset.audio;
		if (state.audio.playing === slug && !audio.paused) {
			audio.pause();
			setPlaying(null);
			return;
		}
		// Pressing play is an explicit request to hear it: lift a global mute.
		if (state.audio.muted) setMuted(false);
		audio.pause();
		audio.src = `assets/audio/${slug}.m4a`;
		audio.currentTime = 0;
		setPlaying(btn);
		const pr = audio.play();
		if (pr && pr.catch) {
			pr.catch((err) => {
				if (err && err.name === 'AbortError') return;
				markUnavailable(btn);
				setPlaying(null);
			});
		}
	});
});

// Trivia entrance: each aside rises in once when it nears the viewport.
const trivias = [...document.querySelectorAll('.whale-trivia')];
if ('IntersectionObserver' in window && !reducedMotionQuery.matches) {
	trivias.forEach((el) => el.classList.add('is-waiting'));
	const io = new IntersectionObserver((entries) => {
		entries.forEach((e) => {
			if (e.isIntersecting) {
				e.target.classList.remove('is-waiting');
				io.unobserve(e.target);
			}
		});
	}, { rootMargin: '0px 0px -15% 0px' });
	trivias.forEach((el) => io.observe(el));
}

// The hero fills the first screen below the site header; publish the header's height.
const siteHeader = document.querySelector('.site-header');
function measureHeader() {
	root.style.setProperty('--whale-header-h', `${siteHeader ? siteHeader.offsetHeight : 0}px`);
}
measureHeader();
window.addEventListener('resize', measureHeader, { passive: true });

// Story nav: jump links with smooth scroll (instant under reduced motion), aria-current.
const navLinks = nav ? [...nav.querySelectorAll('.whale-nav__link')] : [];
const navProgress = nav?.querySelector('.whale-nav__progress');
navLinks.forEach((a) => {
	a.addEventListener('click', (e) => {
		const target = document.getElementById(a.dataset.target);
		if (!target) return;
		e.preventDefault();
		const top = target.getBoundingClientRect().top + window.scrollY;
		window.scrollTo({ top, behavior: state.reducedMotion ? 'auto' : 'smooth' });
		history.replaceState(null, '', `#${a.dataset.target}`);
		target.querySelector('.whale-scene__heading')?.focus({ preventScroll: true });
	});
});
let lastNavIndex = -2;
let lastNavVisible = null;
function updateNav(sceneIndex, visible, p) {
	if (!nav) return;
	if (visible !== lastNavVisible) {
		nav.dataset.visible = String(visible);
		lastNavVisible = visible;
	}
	if (sceneIndex !== lastNavIndex) {
		navLinks.forEach((a, i) => {
			if (i === sceneIndex) a.setAttribute('aria-current', 'step');
			else a.removeAttribute('aria-current');
			a.dataset.past = String(i < sceneIndex);
		});
		lastNavIndex = sceneIndex;
	}
	if (navProgress) navProgress.style.transform = `scaleX(${Math.round(p * 1000) / 1000})`;
}

// App bar (CONTRACT v7, ?appbar=overlay, the default): the production header is fixed over the
// hero, transparent with white type; once the hero has scrolled under it, it turns solid; while
// the scenes pass beneath it, it slides up out of the way (the stage owns the screen), and it
// returns solid over the light prose. Transform/colour only, so nothing shifts (CLS 0).
const heroEl = sections[0];
const overlayBar = root.dataset.appbar === 'overlay' && !!siteHeader;
let lastBar = '';
function updateAppbar() {
	if (!overlayBar) return;
	const hh = siteHeader.offsetHeight;
	const heroBottom = heroEl ? heroEl.getBoundingClientRect().bottom : 0;
	const firstTop = firstScene ? firstScene.getBoundingClientRect().top : Infinity;
	const lastBottom = lastScene ? lastScene.getBoundingClientRect().bottom : -Infinity;
	let bar = 'solid';
	if (heroBottom > hh) bar = 'over';
	else if (firstTop < hh && lastBottom > hh) bar = 'away';
	// Keyboard users keep the bar while focus is inside it.
	if (bar === 'away' && siteHeader.contains(document.activeElement)) bar = 'solid';
	if (bar !== lastBar) {
		root.dataset.appbarState = bar;
		lastBar = bar;
	}
}

// Subject safe zone (CONTRACT v5/v6): where subjects and data may sit, 0..1 of the canvas.
// The canvas is full-viewport and clipped to the frame, so in the scenes this is the visible
// frame less a margin and the docked step bar; in the hero it is the sky/sea above the hed.
// Eased so nothing jumps (snaps under reduced motion).
const safeTarget = { x0: 0.06, y0: 0.08, x1: 0.94, y1: 0.92 };
let safeInit = false;
const GAP = 24; // SpacingSys::Medium between text/controls and subject

// The rail's band, whether or not it is showing yet (it fades in after the reveal settles).
function navRect() {
	if (!nav) return null;
	const r = nav.getBoundingClientRect();
	return r.width ? r : null;
}

function computeSafe(info, box, dt) {
	const W = stage.clientWidth || window.innerWidth || 1; // the stage box (excludes a classic scrollbar)
	const H = stage.clientHeight || window.innerHeight || 1;
	let x0, y0, x1, y1; // canvas px

	if (info.el.classList.contains('whale-hero')) {
		// Hero: hed, dek and byline are centred at the foot of the first screen.
		const hed = info.text[0] && info.text[0].getBoundingClientRect();
		x0 = W * 0.06;
		x1 = W * 0.94;
		y0 = Math.max(H * 0.08, siteHeader ? siteHeader.getBoundingClientRect().bottom + GAP : 0);
		y1 = hed && hed.height ? hed.top - GAP : H * 0.5;
	} else {
		// Scenes: the canvas IS the frame (v7 perf), so the zone is the canvas less a margin and,
		// where the step bar docks on the frame (stacked), the bar's band.
		x0 = W * 0.06;
		x1 = W * 0.94;
		y0 = H * 0.08;
		y1 = H * 0.92;
		const sr = stage.getBoundingClientRect();
		const nr = navRect();
		// Only once pinned: while the frame slides in or out the bar is not docked on it.
		if (stageArrived && nr && nr.top < sr.bottom && nr.bottom > sr.top) y1 = Math.min(y1, nr.top - sr.top - 16); // rail top − SpacingSys::Compact
	}

	safeTarget.x0 = clamp(x0 / W);
	safeTarget.x1 = clamp(x1 / W);
	safeTarget.y0 = clamp(y0 / H);
	safeTarget.y1 = clamp(y1 / H);
	if (safeTarget.x1 - safeTarget.x0 < 0.2) safeTarget.x1 = Math.min(1, safeTarget.x0 + 0.2);
	// Too thin (a sliver of frame just revealed): grow upward, keeping the visible edge.
	if (safeTarget.y1 - safeTarget.y0 < 0.2) safeTarget.y0 = Math.max(0, safeTarget.y1 - 0.2);

	const k = !safeInit || state.reducedMotion ? 1 : 1 - Math.exp(-dt / 0.25);
	safeInit = true;
	const sf = state.safe;
	for (const key of ['x0', 'y0', 'x1', 'y1']) sf[key] = Math.round((sf[key] + (safeTarget[key] - sf[key]) * k) * 1e4) / 1e4;
}

// Which card is being read.
// Stacked (text flows under a top band): the last step whose top has crossed a trigger line
// just below the band (band bottom + 15% of the viewport); the opener until the first does.
// Split: the step most visible in the viewport, once it covers half of it.
function currentCard(info, vh, bandBottom) {
	if (bandBottom > 0) {
		const trigger = bandBottom + vh * 0.15;
		let idx = -1;
		info.steps.forEach((el, i) => { if (el.getBoundingClientRect().top <= trigger) idx = i; });
		return idx;
	}
	let best = -1;
	let bestVis = 0;
	info.steps.forEach((el, i) => {
		const r = el.getBoundingClientRect();
		const vis = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
		if (vis > bestVis) { bestVis = vis; best = i; }
	});
	return bestVis > vh * 0.5 ? best : (best > 0 ? best : -1);
}

// Per-frame state. Reads layout; writes only the stage's opacity/clip, the nav and is-current.
let lastVisibility = -1;
let lastStep = null;
function computeState(dt) {
	const vh = window.innerHeight || 1;
	let best = state.index;
	let bestCover = 0;
	for (let i = 0; i < sections.length; i++) {
		const r = sections[i].getBoundingClientRect();
		const cover = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) / vh;
		if (cover > bestCover + 1e-4) {
			bestCover = cover;
			best = i;
		}
	}
	const el = sections[best];
	const r = el.getBoundingClientRect();
	const span = r.height - vh;
	// v2: t = 0 when the section top meets the viewport top, 1 when its bottom meets the bottom.
	const t = span > 1 ? clamp(-r.top / span) : clamp(-r.top / Math.max(1, r.height));

	state.index = best;
	state.shot = el.dataset.shot;
	state.t = t;
	state.p = clamp((best + t) / sections.length);
	state.active = bestCover > 0;
	// Fully on while any immersive section is on screen: the opaque light prose slides over
	// the stage, so a partial-opacity fade only greyed the white page (finish review #4).
	state.visibility = bestCover > 0 ? 1 : 0;
	state.audio.currentTime = state.audio.playing ? audio.currentTime : 0;

	const isScene = state.shot !== 'open';
	// The scenes own the stage from the moment the first scene's top enters the viewport.
	const scenesOn = firstScene ? firstScene.getBoundingClientRect().top < vh : false;
	const box = applyStage(isScene || scenesOn);

	const lastBottom = lastScene ? lastScene.getBoundingClientRect().bottom : Infinity;
	const v = Math.round(state.visibility * 1000) / 1000;
	if (v !== lastVisibility) {
		stage.style.opacity = String(v);
		stage.style.visibility = v > 0 ? 'visible' : 'hidden';
		lastVisibility = v;
	}

	const info = sectionInfo[best];
	state.card.count = info.steps.length;
	state.card.index = isScene ? currentCard(info, vh, frameBox.stacked ? Math.max(1, frameBox.b) : 0) : -1;
	const currentStep = state.card.index >= 0 ? info.steps[state.card.index] : null;
	if (currentStep !== lastStep) {
		lastStep?.classList.remove('is-current');
		currentStep?.classList.add('is-current');
		lastStep = currentStep;
	}

	const sceneCount = sections.length - 1;
	updateAppbar();
	const navOn = isScene && stageArrived && bestCover > 0.25 && lastBottom > vh;
	updateNav(isScene ? best - 1 : -1, navOn, isScene ? clamp((best - 1 + t) / sceneCount) : 0);
	computeSafe(info, box, dt);
}

const t0 = performance.now();
let last = t0;
function frame(now) {
	const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
	last = now;
	state.time = (now - t0) / 1000;
	computeState(dt);
	if (sceneApi && state.visibility > 0) {
		try {
			sceneApi.update(state, dt);
		} catch (err) {
			console.error('[whale-scroll] scene update failed', err);
			sceneApi = null;
			root.classList.add('no-webgl');
		}
	}
	if (overlays && typeof overlays.updateOverlays === 'function') {
		try {
			overlays.updateOverlays(state, dt, sceneApi || undefined);
		} catch (err) {
			if (!overlayErrored) console.error('[whale-scroll] overlays update failed', err);
			overlayErrored = true;
		}
	}
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// QA hook, only with ?debug: exposes the live state, the un-eased safe target and the scene.
if (new URLSearchParams(location.search).has('debug')) {
	window.whaleDebug = { state, safeTarget, get sceneApi() { return sceneApi; } };
}
