// Celebrations: a burst of hexes, numbers that count up, a banner over the map
// and a full-screen moment. No dependencies; loaded before app.js.
// Everything respects prefers-reduced-motion: no burst, numbers land straight
// on their final value, cards appear without moving.
(() => {
  'use strict';

  const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const cssVar = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      node.append(kid instanceof Node ? kid : String(kid));
    }
    return node;
  }

  /** A short vibration where the device supports it (Android app, Chrome on Android). */
  function buzz(pattern) {
    try {
      if (navigator.vibrate && !reduced()) navigator.vibrate(pattern);
    } catch (e) { /* not allowed here */ }
  }

  // ---------- hex burst ----------

  let canvas = null;
  let parts = [];
  let raf = 0;

  function hexPath(ctx, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
    }
    ctx.closePath();
  }

  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = h('canvas', { class: 'celebrate-fx', 'aria-hidden': 'true' });
    document.body.append(canvas);
    return canvas;
  }

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Hexagons in the map's heat colours fly up from (x, y) in screen pixels and
   * fall away. `big` sends them in every direction, for the bigger moments.
   */
  function burst({ x = innerWidth / 2, y = innerHeight * 0.6, count = 60, big = false } = {}) {
    if (reduced()) return;
    ensureCanvas();
    if (!raf) sizeCanvas();
    const colors = ['--heat-0', '--heat-1', '--heat-2', '--heat-3', '--accent']
      .map((n, i) => cssVar(n, ['#E0301E', '#EE6B2F', '#F49E5E', '#EBC8A2', '#D23F1C'][i]));
    const spread = big ? Math.PI * 2 : Math.PI * 0.9;
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * spread;
      const v = (big ? 5 : 4) + Math.random() * (big ? 7 : 5);
      parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        r: 4 + Math.random() * (big ? 9 : 6), rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        color: colors[i % colors.length], life: 0, max: 70 + Math.random() * 50,
      });
    }
    if (!raf) raf = requestAnimationFrame(step);
  }

  function step() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life < p.max);
    for (const p of parts) {
      p.life++;
      p.vy += 0.16;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
      hexPath(ctx, p.r);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.restore();
    }
    if (parts.length) {
      raf = requestAnimationFrame(step);
    } else {
      raf = 0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  // ---------- numbers ----------

  /** Count `el` up from 0 to `to`, easing out. `format` turns a number into its text. */
  function countUp(el, to, { ms = 900, format = (v) => Math.round(v).toLocaleString() } = {}) {
    if (!el) return;
    if (reduced() || !(to > 0)) {
      el.textContent = format(to);
      return;
    }
    const t0 = performance.now();
    el.textContent = format(0);
    const tick = (t) => {
      if (!el.isConnected) return;
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = format(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- progress steps ----------

  /**
   * A row of hex steps, one per item: `items` is [{ glyph, label, on }], and
   * the step at `fresh` (if any) fills in with a pop.
   */
  function steps(items, fresh = -1, cls = '') {
    return h('div', { class: `cel-steps ${cls}`.trim(), role: 'img',
      'aria-label': `${items.filter((i) => i.on).length} of ${items.length} done` },
    items.map((it, i) => h('span', {
      class: ['cel-step', it.on ? 'on' : '', i === fresh ? 'fresh' : ''].filter(Boolean).join(' '),
      title: it.label,
    }, it.glyph)));
  }

  // ---------- banner over the map ----------

  let bannerEl = null;
  let bannerTimer = null;

  /** A card that drops in under the stats card for a few seconds. Tap to dismiss. */
  function banner({ icon, title, sub, body, ms = 5000 }) {
    hideBanner(true);
    bannerEl = h('div', { class: 'cel-banner', role: 'status', 'aria-live': 'polite', onclick: () => hideBanner() },
      h('div', { class: 'cel-banner-top' },
        icon ? h('span', { class: 'cel-hex-icon', 'aria-hidden': 'true' }, icon) : null,
        h('div', { class: 'cel-banner-text' },
          h('b', { dir: 'auto' }, title),
          sub ? h('small', { dir: 'auto' }, sub) : null)),
      body || null);
    document.body.append(bannerEl);
    void bannerEl.offsetHeight;
    bannerEl.classList.add('on');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => hideBanner(), ms);
    return bannerEl;
  }

  function hideBanner(now = false) {
    clearTimeout(bannerTimer);
    const el = bannerEl;
    bannerEl = null;
    if (!el) return;
    if (now || reduced()) { el.remove(); return; }
    el.classList.remove('on');
    setTimeout(() => el.remove(), 400);
  }

  /** "+3" floating up from a point on screen. */
  function floatText(text, x, y) {
    if (reduced()) return;
    const el = h('span', { class: 'cel-float', 'aria-hidden': 'true', style: `left:${x}px;top:${y}px` }, text);
    document.body.append(el);
    setTimeout(() => el.remove(), 1500);
  }

  // ---------- full-screen moment ----------

  let momentEl = null;

  /**
   * A full-screen card for the big moments. `actions` is
   * [{ label, primary, onclick }]; every action closes the moment first.
   */
  function moment({ emblem, emblemLabel, kicker, title, sub, body, actions = [] }) {
    closeMoment();
    const close = () => closeMoment();
    momentEl = h('div', { class: 'cel-moment', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'cel-moment-card' },
        h('div', { class: 'cel-emblem', 'aria-hidden': 'true' },
          h('div', { class: 'cel-emblem-ring' }),
          h('div', { class: 'cel-emblem-core' },
            h('div', {}, h('strong', {}, emblem), emblemLabel ? h('span', {}, emblemLabel) : null))),
        kicker ? h('span', { class: 'cel-kicker', dir: 'auto' }, kicker) : null,
        h('h2', { class: 'cel-title', dir: 'auto' }, title),
        sub ? h('p', { class: 'cel-sub', dir: 'auto' }, sub) : null,
        body || null,
        h('div', { class: 'cel-actions' }, (actions.length ? actions : [{ label: 'Done' }]).map((a) => h('button', {
          type: 'button',
          class: a.primary ? 'btn' : 'btn outline',
          onclick: () => { close(); if (a.onclick) a.onclick(); },
        }, a.label)))));
    document.body.append(momentEl);
    void momentEl.offsetHeight;
    momentEl.classList.add('on');
    const first = momentEl.querySelector('button');
    if (first) first.focus({ preventScroll: true });
    return momentEl;
  }

  function closeMoment() {
    const el = momentEl;
    momentEl = null;
    if (!el) return false;
    if (reduced()) { el.remove(); return true; }
    el.classList.remove('on');
    setTimeout(() => el.remove(), 350);
    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && momentEl) { e.stopPropagation(); closeMoment(); }
  }, true);

  window.scoopCelebrate = {
    reduced, buzz, burst, countUp, steps, banner, hideBanner, floatText, moment, closeMoment,
    get momentOpen() { return !!momentEl; },
  };
})();
