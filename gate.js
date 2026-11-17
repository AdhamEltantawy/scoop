/*
 * The remote switch (supabase/migrations/20261123000000_app_gate.sql).
 * Asks the server whether this copy may run: if the app is switched off, or
 * this Android build is too old, a full-screen notice covers the app (with a
 * link to the latest release for an old build). Checked at start and when the
 * app comes back to the foreground. The last answer is remembered, so the
 * notice stays offline too; with no answer yet, the app runs.
 */
(function () {
  'use strict';
  const cfg = window.SCOOP_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.fetch) return;

  const KEY = 'scoop.gate.v1';
  const RECHECK_MS = 5 * 60000;
  const cap = window.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const platform = isNative ? 'android' : 'web';
  const base = cfg.supabaseUrl.replace(/\/+$/, '');

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } };
  const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode */ } };

  // The Android build number (versionCode): 57 for Scoop 1.0.57.
  let buildP = null;
  function build() {
    if (!isNative) return Promise.resolve(null);
    buildP = buildP || cap.nativePromise('App', 'getInfo', {})
      .then((info) => { const n = parseInt(info && info.build, 10); return Number.isFinite(n) ? n : null; })
      .catch(() => null);
    return buildP;
  }

  // Signed in: your token, so the people allowed through a switched-off app get through.
  function token() {
    try {
      const ref = new URL(base).hostname.split('.')[0];
      const s = JSON.parse(localStorage.getItem(`sb-${ref}-auth-token`));
      return s && s.access_token && s.expires_at * 1000 > Date.now() ? s.access_token : null;
    } catch (e) {
      return null;
    }
  }

  async function ask(b) {
    const call = async (bearer) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        return await fetch(`${base}/rest/v1/rpc/app_gate`, {
          method: 'POST',
          headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ build: b, platform }),
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    const t = token();
    let res = await call(t || cfg.supabaseAnonKey);
    if (res.status === 401 && t) res = await call(cfg.supabaseAnonKey);
    if (!res.ok) throw new Error(`app_gate ${res.status}`);
    const [row] = await res.json();
    return row && ['ok', 'update', 'off'].includes(row.state) ? row : null;
  }

  // ---------- the notice ----------

  let shown = null;
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick') n.addEventListener('click', v);
      else if (v != null) n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }

  function show(g) {
    hide();
    const update = g.state === 'update';
    const again = el('button', { class: 'btn outline', type: 'button', onclick: () => check(true, again) }, 'Check again');
    shown = el('div', { class: 'gate', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'gateTitle' },
      el('div', { class: 'gate-card' },
        el('span', { class: 'gate-mark', 'aria-hidden': 'true' }, update ? '⬆' : '⏸'),
        el('h1', { class: 'gate-title', id: 'gateTitle' }, update ? 'Time to update Scoop' : 'Scoop is paused'),
        el('p', { class: 'gate-body', dir: 'auto' }, g.message || (update
          ? 'This version no longer works. Get the latest one from GitHub and install it over this one. Your walks and hexes stay on your phone.'
          : 'Scoop is switched off for now. Check back soon.')),
        update && g.url ? el('a', Object.assign({ class: 'btn md', href: g.url },
          isNative ? {} : { target: '_blank', rel: 'noopener' }), 'Get the new version') : null,
        again));
    // Keep the app behind it out of reach of taps and screen readers.
    for (const n of document.body.children) if (n !== shown) n.setAttribute('inert', '');
    document.body.append(shown);
  }

  function hide() {
    if (!shown) return;
    shown.remove();
    shown = null;
    for (const n of document.body.children) n.removeAttribute('inert');
  }

  // ---------- checking ----------

  let lastCheck = 0;
  async function check(force, btn) {
    if (!force && Date.now() - lastCheck < RECHECK_MS) return;
    lastCheck = Date.now();
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    const b = await build();
    try {
      const g = await ask(b);
      if (!g) return;
      save({ build: b, state: g.state, message: g.message, url: g.url });
      if (g.state === 'ok') hide(); else show(g);
    } catch (e) {
      // Offline or the server is down: keep whatever we were showing.
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Check again'; }
    }
  }

  async function start() {
    // The last answer first, so an app that's off stays off offline. It only
    // counts for the build it was about: updating clears it.
    const last = load();
    if (last && last.state !== 'ok' && last.build === (await build())) show(last);
    check(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(false); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
