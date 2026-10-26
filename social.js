/* Scoop community features: accounts, friends, feed, check-ins, leaderboards,
 * challenges, the community map, plus share cards and privacy zones (which
 * work without an account).
 *
 * Everything here is optional. The core app (app.js) works the same without
 * it, and it talks to app.js only through window.scoop and `scoop:*` events.
 * Only H3 cell ids, visit counts and walk totals are uploaded — never tracks.
 */
(() => {
  'use strict';

  const S = window.scoop;
  const core = window.ScoopCore;
  if (!S || !core || !window.h3) return;

  const { map, toast } = S;
  const $ = (id) => document.getElementById(id);
  const cfg = window.SCOOP_CONFIG || {};
  // Invite links point at the web app, which also works for friends without the Android app.
  const PUBLIC_URL = cfg.publicUrl ||
    (!S.isNative && location.protocol.startsWith('http') ? location.origin + location.pathname : 'https://adhameltantawy.github.io/scoop/');
  const sb = cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
    : null;

  const ZONES_KEY = 'scoop.zones.v1';
  const SYNC_KEY = 'scoop.sync.v1';
  const INVITE_KEY = 'scoop.invite';
  const TAB_KEY = 'scoop.tab';
  const PROFILE_COLS = 'id, username, display_name, home_city, leaderboard_public';
  const PHOTO_BUCKET = 'checkin-photos';
  const FRIEND_COLOR = '#4cc9f0';
  const COMMUNITY_COLOR = '#9b5de5';

  // Set once signed in (only possible when sb is configured).
  let session = null;
  let profile = null;
  const uid = () => (session ? session.user.id : null);

  // ---------- small helpers ----------

  /** Build an element. Children are appended as text unless they're nodes. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  /** Replace an element's children, skipping null/false (replaceChildren would print them). */
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Storage full: the next sync just resends.
    }
  }

  function fail(err) {
    toast((err && (err.message || err.error_description)) || String(err), 4500);
  }

  /** Throw Supabase errors so callers can use try/catch. */
  function check({ data, error }) {
    if (error) throw error;
    return data;
  }

  const distance = (a, b) => h3.greatCircleDistance([a.lat, a.lng], [b.lat, b.lng], h3.UNITS.m);
  const nameOf = (p) => (p ? p.display_name || p.username : 'Someone');
  const fmtKm = (km) => Number(km).toFixed(km >= 10 ? 1 : 2);

  async function shareFile(blob, name, title) {
    if (S.isNative) {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      const { uri } = await S.Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
      await S.Share.share({ title, files: [uri] });
      return;
    }
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return;
    }
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function shareText(title, text, url) {
    if (S.isNative) return S.Share.share({ title, text, url });
    if (navigator.share) return navigator.share({ title, text, url });
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Invite link copied');
  }

  const cancelled = (err) => /cancel|abort/i.test((err && (err.name + err.message)) || '');

  // ---------- privacy zones (local only) ----------

  map.createPane('zones').style.zIndex = '405';
  const zoneLayer = L.layerGroup([], { pane: 'zones' }).addTo(map);
  /** @type {{lat:number,lng:number,r:number}[]} */
  const zones = loadJSON(ZONES_KEY, []);
  let isHidden = core.zoneFilter(zones, h3.cellToLatLng, distance);

  function zonesChanged() {
    saveJSON(ZONES_KEY, zones);
    isHidden = core.zoneFilter(zones, h3.cellToLatLng, distance);
    drawZones();
    renderZoneList();
  }

  function drawZones() {
    zoneLayer.clearLayers();
    for (const z of zones) {
      L.circle([z.lat, z.lng], {
        pane: 'zones', radius: z.r, color: '#6b7488', weight: 1.5, dashArray: '4 4',
        fillColor: '#6b7488', fillOpacity: 0.12, interactive: false,
      }).addTo(zoneLayer);
    }
  }

  function renderZoneList() {
    const list = $('zoneList');
    list.replaceChildren(...zones.map((z, i) => h('li', {},
      h('span', {}, `Zone ${i + 1}`),
      h('select', {
        'aria-label': `Zone ${i + 1} radius`,
        onchange: (e) => { z.r = Number(e.target.value); zonesChanged(); afterZonesChanged(); },
      }, [200, 300, 500, 800].map((r) => h('option', { value: String(r), selected: r === z.r }, `${r} m`))),
      h('button', { class: 'link', onclick: () => map.setView([z.lat, z.lng], 16) }, 'Show'),
      h('button', {
        class: 'link danger',
        onclick: () => { zones.splice(i, 1); zonesChanged(); afterZonesChanged(); },
      }, 'Remove'),
    )));
    $('btnAddZone').disabled = zones.length >= 3;
  }

  $('btnAddZone').addEventListener('click', () => {
    const c = map.getCenter();
    zones.push({ lat: c.lat, lng: c.lng, r: 300 });
    zonesChanged();
    afterZonesChanged();
    toast('Privacy zone added at the map centre');
  });

  drawZones();
  renderZoneList();

  // ---------- share card ----------

  async function shareCard() {
    const res = S.settings.res;
    const W = 1080;
    const H = 1350;
    const frame = { x: 40, y: 170, w: 1000, h: 880 };
    const canvas = h('canvas', { width: W, height: H });
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1d2433');
    bg.addColorStop(1, '#121722');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#f3f5f9';
    ctx.font = '700 64px system-ui, sans-serif';
    ctx.fillText('Scoop', 48, 112);
    ctx.fillStyle = '#a3acc0';
    ctx.font = '400 32px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }), W - 48, 108);
    ctx.textAlign = 'left';

    // Hexes in the current view, minus anything near a privacy zone. Coarser
    // display hexes get the zone grown by their size so they can't leak it.
    const edge = h3.getHexagonEdgeLengthAvg(res, h3.UNITS.m);
    const hiddenDisplay = core.zoneFilter(zones.map((z) => ({ ...z, r: z.r + edge * 2 })), h3.cellToLatLng, distance);
    const bounds = map.getBounds();
    const inView = (c) => bounds.contains(h3.cellToLatLng(c));
    const display = new Set();
    for (const c of S.visited.keys()) if (!isHidden(c)) display.add(S.toDisplay(c));
    const shown = [...display].filter((c) => inView(c) && !hiddenDisplay(c));

    const size = map.getSize();
    const scale = Math.min(frame.w / size.x, frame.h / size.y);
    const ox = frame.x + (frame.w - size.x * scale) / 2;
    const oy = frame.y + (frame.h - size.y * scale) / 2;
    const toCanvas = ([lat, lng]) => {
      const p = map.latLngToContainerPoint([lat, lng]);
      return [ox + p.x * scale, oy + p.y * scale];
    };
    const hexPath = (c) => {
      const ring = h3.cellToBoundary(c).map(toCanvas);
      ctx.moveTo(ring[0][0], ring[0][1]);
      for (const [x, y] of ring.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
    };

    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(frame.x, frame.y, frame.w, frame.h, 28);
    else ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.fillStyle = '#232b3d';
    ctx.fill();
    ctx.clip();

    let grid = [];
    try {
      const b = bounds.pad(0.05);
      grid = h3.polygonToCells([
        [b.getSouth(), b.getWest()], [b.getNorth(), b.getWest()],
        [b.getNorth(), b.getEast()], [b.getSouth(), b.getEast()],
      ], res, false);
    } catch (e) {
      grid = [];
    }
    if (grid.length && grid.length <= 6000) {
      ctx.beginPath();
      for (const c of grid) hexPath(c);
      ctx.strokeStyle = 'rgba(163, 172, 192, 0.16)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.beginPath();
    for (const c of shown) hexPath(c);
    ctx.fillStyle = 'rgba(255, 122, 61, 0.6)';
    ctx.fill();
    ctx.strokeStyle = '#ff7a3d';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    let km2 = 0;
    for (const c of S.visited.keys()) km2 += S.cellAreaCached(c);
    const totalKm = S.walks.reduce((a, w) => a + (w.km || 0), 0);
    const stats = [
      [display.size.toLocaleString(), 'hexes'],
      [S.formatNum(km2), 'km² explored'],
      [S.formatNum(totalKm), 'km walked'],
      [S.walks.length.toLocaleString(), 'walks'],
    ];
    const colW = (W - 80) / stats.length;
    stats.forEach(([num, lbl], i) => {
      const x = 40 + colW * i + colW / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd166';
      ctx.font = '700 56px system-ui, sans-serif';
      ctx.fillText(num, x, 1150);
      ctx.fillStyle = '#a3acc0';
      ctx.font = '400 28px system-ui, sans-serif';
      ctx.fillText(lbl.toUpperCase(), x, 1195);
    });
    ctx.fillStyle = '#6b7488';
    ctx.font = '400 28px system-ui, sans-serif';
    ctx.fillText('Exploring my city on foot, one hexagon at a time', W / 2, 1290);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    try {
      await shareFile(blob, `scoop-${new Date().toISOString().slice(0, 10)}.png`, 'My Scoop map');
    } catch (err) {
      if (!cancelled(err)) fail(err);
    }
  }

  $('btnShareCard').addEventListener('click', () => {
    S.closeSheet();
    shareCard();
  });

  // ---------- everything below needs a Supabase project ----------

  if (!sb) {
    $('communityNote').textContent = 'Community features are off in this build (no Supabase project configured).';
    return;
  }
  document.body.classList.add('community-on');

  // ---------- sync ----------

  let syncState = loadJSON(SYNC_KEY, { uid: null, cells: {}, walks: [] });
  let syncing = false;
  let syncAgain = false;
  let syncTimer = null;
  let syncStatus = 'Not synced yet';

  function saveSync() {
    saveJSON(SYNC_KEY, syncState);
  }

  function scheduleSync(ms = 3000) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, ms);
  }

  async function sync() {
    if (!profile) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      if (syncState.uid !== uid()) syncState = { uid: uid(), cells: {}, walks: [] };
      const delta = core.syncDelta(S.visited, S.visitCount, syncState.cells, isHidden);
      for (const batch of core.chunk(delta, 1000)) {
        check(await sb.rpc('sync_cells', { cells: batch }));
        for (const x of batch) syncState.cells[x.c] = x.v;
        saveSync();
      }
      const known = new Set(syncState.walks);
      const fresh = S.walks.filter((w) => !known.has(w.start) && w.end >= w.start);
      for (const batch of core.chunk(fresh, 200)) {
        check(await sb.from('walks').upsert(batch.map((w) => ({
          started_at: new Date(w.start).toISOString(),
          ended_at: new Date(w.end).toISOString(),
          km: Math.min(299, Math.max(0, +(w.km || 0).toFixed(3))),
          new_cells: w.newCells || 0,
        })), { onConflict: 'user_id,started_at', ignoreDuplicates: true }));
        syncState.walks.push(...batch.map((w) => w.start));
        saveSync();
      }
      syncStatus = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (err) {
      syncStatus = navigator.onLine ? `Sync failed: ${err.message}` : 'Offline — will sync when back online';
    } finally {
      syncing = false;
      const el = $('syncStatus');
      if (el) el.textContent = syncStatus;
    }
    if (syncAgain) {
      syncAgain = false;
      await sync();
    }
  }

  /** Remove anything now inside a privacy zone from the server, or upload what left one. */
  async function afterZonesChanged() {
    if (!profile) return;
    try {
      const hidden = Object.keys(syncState.cells).filter(isHidden);
      for (const batch of core.chunk(hidden, 200)) {
        check(await sb.from('user_cells').delete().eq('user_id', uid()).in('cell', batch));
        check(await sb.from('checkins').delete().eq('user_id', uid()).in('cell', batch));
        for (const c of batch) delete syncState.cells[c];
        saveSync();
      }
      await sync();
      loadCheckinMarkers();
    } catch (err) {
      fail(err);
    }
  }

  document.addEventListener('scoop:changed', () => scheduleSync());
  window.addEventListener('online', () => scheduleSync(1000));

  // ---------- auth ----------

  async function setSession(next) {
    const changed = uid() !== (next ? next.user.id : null);
    session = next;
    if (!changed && profile) return;
    profile = null;
    clearFriendOverlay();
    document.body.classList.toggle('signed-in', false);
    if (session) {
      try {
        profile = check(await sb.from('profiles').select(PROFILE_COLS).eq('id', uid()).maybeSingle());
      } catch (err) {
        fail(err);
      }
    }
    if (profile) onProfileReady();
    renderCommunity();
  }

  function onProfileReady() {
    document.body.classList.add('signed-in');
    scheduleSync(500);
    acceptPendingInvite();
    loadCheckinMarkers();
  }

  // Fires once at startup with the saved session (or null), then on every change.
  // Supabase warns against awaiting its own calls inside this callback.
  sb.auth.onAuthStateChange((_event, next) => setTimeout(() => setSession(next), 0));

  // Invite links: …/scoop/?invite=CODE
  const inviteFromUrl = core.parseInvite(new URLSearchParams(location.search).get('invite'));
  if (inviteFromUrl) {
    saveJSON(INVITE_KEY, inviteFromUrl);
    history.replaceState(null, '', location.pathname);
  }

  async function acceptPendingInvite() {
    const code = loadJSON(INVITE_KEY, null);
    if (!code) return;
    localStorage.removeItem(INVITE_KEY);
    try {
      const [p] = check(await sb.rpc('send_friend_request', { code }));
      if (p) toast(p.status === 'accepted' ? `You're now friends with ${nameOf(p)}` : `Friend request sent to ${nameOf(p)}`, 4000);
    } catch (err) {
      if (!/own code/.test(err.message)) fail(err);
    }
  }

  // ---------- community sheet ----------

  let tab = loadJSON(TAB_KEY, 'feed');
  let signInEmail = '';

  $('btnCommunity').addEventListener('click', () => {
    renderCommunity();
    S.openSheet('communitySheet');
  });
  $('btnCommunityClose').addEventListener('click', S.closeSheet);

  function setBody(...kids) {
    fill($('communityBody'), ...kids);
  }

  function renderCommunity() {
    if (!session) return renderSignIn();
    if (!profile) return renderProfileSetup();
    const tabs = [['feed', 'Feed'], ['friends', 'Friends'], ['ranks', 'Ranks'], ['challenges', 'Challenges'], ['me', 'Me']];
    $('communityTabs').replaceChildren(...tabs.map(([key, label]) => h('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(key === tab),
      onclick: () => { tab = key; saveJSON(TAB_KEY, tab); renderCommunity(); },
    }, label)));
    $('communityTabs').hidden = false;
    const panel = h('div', {}, h('p', { class: 'fine' }, 'Loading…'));
    setBody(panel);
    const render = { feed: renderFeed, friends: renderFriends, ranks: renderRanks, challenges: renderChallenges, me: renderMe }[tab] || renderFeed;
    render(panel).catch((err) => {
      fill(panel, h('p', { class: 'fine' }, navigator.onLine ? `Couldn't load: ${err.message}` : 'You\'re offline.'));
    });
  }

  function renderSignIn() {
    $('communityTabs').hidden = true;
    const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', value: signInEmail, required: true });
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6-digit code', maxlength: '10' });
    const codeRow = h('label', { class: 'field', hidden: true }, h('span', {}, 'Code from the email'), code);
    const button = h('button', { class: 'primary', type: 'submit' }, 'Email me a code');
    let sent = false;
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        try {
          if (!sent) {
            signInEmail = email.value.trim();
            check(await sb.auth.signInWithOtp({ email: signInEmail, options: { shouldCreateUser: true } }));
            sent = true;
            codeRow.hidden = false;
            button.textContent = 'Sign in';
            code.focus();
            toast('Check your email for the code');
          } else {
            check(await sb.auth.verifyOtp({ email: signInEmail, token: code.value.trim(), type: 'email' }));
          }
        } catch (err) {
          fail(err);
        } finally {
          button.disabled = false;
        }
      },
    },
    h('p', {}, 'Sign in to add friends, compare maps, check in at places and climb the leaderboards.'),
    h('label', { class: 'field' }, h('span', {}, 'Email'), email),
    codeRow,
    button,
    h('p', { class: 'fine' }, 'Only hex ids, visit counts and walk totals are uploaded — never your GPS tracks. ' +
      'Friends see your map; nobody else does unless you make your profile public. Hexes inside your privacy zones are never uploaded.'));
    setBody(form);
  }

  function profileFields(p) {
    return {
      username: h('input', { value: p.username || '', placeholder: 'walker_42', autocapitalize: 'none', maxlength: '20', required: true }),
      display_name: h('input', { value: p.display_name || '', placeholder: 'Your name', maxlength: '40' }),
      home_city: h('input', { value: p.home_city || '', placeholder: 'City', maxlength: '60' }),
      leaderboard_public: h('input', { type: 'checkbox', checked: !!p.leaderboard_public }),
    };
  }

  function readProfile(f) {
    const username = f.username.value.trim().toLowerCase();
    if (!core.validUsername(username)) throw new Error('Usernames are 3–20 characters: a–z, 0–9 and _');
    return {
      username,
      display_name: f.display_name.value.trim() || null,
      home_city: f.home_city.value.trim() || null,
      leaderboard_public: f.leaderboard_public.checked,
    };
  }

  function profileError(err) {
    return err.code === '23505' ? new Error('That username is taken') : err;
  }

  function profileForm(f) {
    return [
      h('label', { class: 'field' }, h('span', {}, 'Username'), f.username),
      h('label', { class: 'field' }, h('span', {}, 'Display name'), f.display_name),
      h('label', { class: 'field' }, h('span', {}, 'Home city'), f.home_city),
      h('label', { class: 'row' },
        h('span', {}, 'Public profile', h('small', {}, 'Show me on public leaderboards and the community map')),
        f.leaderboard_public),
    ];
  }

  function renderProfileSetup() {
    $('communityTabs').hidden = true;
    const f = profileFields({});
    setBody(h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          profile = check(await sb.from('profiles').insert({ id: uid(), ...readProfile(f) }).select(PROFILE_COLS).single());
          onProfileReady();
          renderCommunity();
        } catch (err) {
          fail(profileError(err));
        }
      },
    },
    h('p', {}, 'Pick a username your friends will see.'),
    profileForm(f),
    h('button', { class: 'primary', type: 'submit' }, 'Continue'),
    h('button', { class: 'link', type: 'button', onclick: () => sb.auth.signOut() }, 'Use a different email')));
  }

  // ---------- feed ----------

  async function photoUrls(paths) {
    if (!paths.length) return {};
    const rows = check(await sb.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600));
    return Object.fromEntries(rows.filter((r) => r.signedUrl).map((r) => [r.path, r.signedUrl]));
  }

  async function loadFeedPage(before) {
    const lim = 20;
    const [walks, checkins, badges] = await Promise.all([
      sb.from('walks').select('id, user_id, started_at, km, new_cells, profiles(username, display_name), kudos(user_id, emoji)')
        .lt('started_at', before).order('started_at', { ascending: false }).limit(lim),
      sb.from('checkins')
        .select('id, user_id, cell, kind, note, photo_path, met_with, created_at, author:profiles!checkins_user_id_fkey(username, display_name), met:profiles!checkins_met_with_fkey(username, display_name)')
        .lt('created_at', before).order('created_at', { ascending: false }).limit(lim),
      sb.from('badges').select('user_id, badge_key, earned_at, profiles(username, display_name)')
        .lt('earned_at', before).order('earned_at', { ascending: false }).limit(lim),
    ].map((q) => q.then(check)));
    const items = [
      ...walks.map((w) => ({ type: 'walk', at: w.started_at, ...w })),
      ...checkins.map((c) => ({ type: 'checkin', at: c.created_at, ...c })),
      ...badges.map((b) => ({ type: 'badge', at: b.earned_at, ...b })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, lim);
    const urls = await photoUrls(items.filter((i) => i.photo_path).map((i) => i.photo_path));
    return { items, urls, more: walks.length === lim || checkins.length === lim || badges.length === lim };
  }

  function kudosBar(w) {
    const bar = h('div', { class: 'kudos' });
    const draw = () => {
      const mine = w.kudos.find((k) => k.user_id === uid());
      bar.replaceChildren(...core.KUDOS.map((emoji) => {
        const n = w.kudos.filter((k) => k.emoji === emoji).length;
        return h('button', {
          class: 'chip', 'aria-pressed': String(!!mine && mine.emoji === emoji), disabled: w.user_id === uid(),
          title: w.user_id === uid() ? 'Kudos from friends show here' : 'Give kudos',
          onclick: async () => {
            try {
              if (mine) check(await sb.from('kudos').delete().eq('walk_id', w.id).eq('user_id', uid()));
              w.kudos = w.kudos.filter((k) => k.user_id !== uid());
              if (!mine || mine.emoji !== emoji) {
                check(await sb.from('kudos').insert({ walk_id: w.id, emoji }));
                w.kudos.push({ user_id: uid(), emoji });
              }
              draw();
            } catch (err) {
              fail(err);
            }
          },
        }, emoji, n ? ` ${n}` : '');
      }));
    };
    draw();
    return bar;
  }

  function feedItem(item, urls) {
    const when = h('time', {}, core.timeAgo(Date.parse(item.at)));
    if (item.type === 'walk') {
      return h('li', { class: 'feed-item' },
        h('div', {}, h('b', {}, nameOf(item.profiles)), ` walked ${fmtKm(item.km)} km`,
          item.new_cells ? ` · ${item.new_cells} new hex${item.new_cells === 1 ? '' : 'es'}` : '', ' ', when),
        kudosBar(item));
    }
    if (item.type === 'badge') {
      const b = core.BADGES[item.badge_key] || { icon: '🏅', label: item.badge_key };
      return h('li', { class: 'feed-item' },
        h('div', {}, h('b', {}, nameOf(item.profiles)), ` earned ${b.icon} ${b.label} `, when));
    }
    const kind = core.CHECKIN_KINDS[item.kind];
    const what = item.kind === 'meetup'
      ? (item.met_with ? ` met up with ${item.met ? nameOf(item.met) : 'a friend'}` : ' is up for a meetup')
      : ` checked in · ${kind.label.toLowerCase()}`;
    return h('li', { class: 'feed-item' },
      h('div', {}, `${kind.icon} `, h('b', {}, nameOf(item.author)), what, ' ', when),
      item.note ? h('div', { class: 'note' }, item.note) : null,
      urls[item.photo_path] ? h('img', { class: 'photo', src: urls[item.photo_path], alt: item.note || 'Check-in photo', loading: 'lazy' }) : null,
      h('button', {
        class: 'link',
        onclick: () => { S.closeSheet(); map.setView(h3.cellToLatLng(item.cell), 17); },
      }, 'Show on map'));
  }

  async function renderFeed(panel) {
    const list = h('ul', { class: 'list' });
    const more = h('button', { class: 'link', hidden: true }, 'Load more');
    let before = new Date(Date.now() + 60000).toISOString();
    const load = async () => {
      more.disabled = true;
      const page = await loadFeedPage(before);
      for (const item of page.items) list.append(feedItem(item, page.urls));
      if (page.items.length) before = page.items[page.items.length - 1].at;
      more.hidden = !page.more;
      more.disabled = false;
      if (!list.children.length) {
        list.append(h('li', { class: 'fine' }, 'Nothing here yet. Add friends in the Friends tab, then go for a walk!'));
      }
    };
    more.addEventListener('click', () => load().catch(fail));
    await load();
    fill(panel, list, more);
  }

  // ---------- friends, map overlay and compare ----------

  async function loadFriends() {
    const rows = check(await sb.from('friendships').select('requester, addressee, status, created_at'));
    const ids = rows.map((r) => (r.requester === uid() ? r.addressee : r.requester));
    const profiles = ids.length
      ? check(await sb.from('profiles').select(PROFILE_COLS).in('id', ids))
      : [];
    const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
    return rows.map((r) => {
      const otherId = r.requester === uid() ? r.addressee : r.requester;
      return { ...r, other: byId[otherId] || { id: otherId, username: '?' }, incoming: r.addressee === uid() };
    });
  }

  async function renderFriends(panel) {
    const [rows, code] = await Promise.all([loadFriends(), sb.rpc('my_invite_code').then(check)]);
    const friends = rows.filter((r) => r.status === 'accepted');
    const incoming = rows.filter((r) => r.status === 'pending' && r.incoming);
    const outgoing = rows.filter((r) => r.status === 'pending' && !r.incoming);
    const codeInput = h('input', { placeholder: 'Friend\'s invite code or link', autocapitalize: 'characters' });

    const friendRow = (r) => {
      const p = r.other;
      const showing = overlay && overlay.friend.id === p.id;
      return h('li', { class: 'person' },
        h('span', {}, h('b', {}, nameOf(p)), p.home_city ? h('small', {}, ` ${p.home_city}`) : ''),
        h('button', {
          class: 'chip', 'aria-pressed': String(showing),
          onclick: () => (showing ? clearFriendOverlay() : showFriendOverlay(p)).then(() => renderCommunity()).catch(fail),
        }, showing ? 'Hide map' : 'Compare'),
        h('button', {
          class: 'link danger',
          onclick: async () => {
            if (!confirm(`Remove ${nameOf(p)} from your friends?`)) return;
            try {
              check(await sb.from('friendships').delete().eq('requester', r.requester).eq('addressee', r.addressee));
              if (showing) clearFriendOverlay();
              renderCommunity();
            } catch (err) {
              fail(err);
            }
          },
        }, 'Remove'));
    };

    const respond = (r, accept) => async () => {
      try {
        check(await sb.rpc('respond_friend_request', { other: r.other.id, accept }));
        renderCommunity();
      } catch (err) {
        fail(err);
      }
    };

    fill(panel, 
      h('div', { class: 'invite' },
        h('div', {}, h('small', {}, 'Your invite code'), h('div', { class: 'code' }, code)),
        h('button', {
          class: 'primary',
          onclick: () => shareText('Scoop', 'Explore the city with me on Scoop!', `${PUBLIC_URL}?invite=${code}`)
            .catch((err) => { if (!cancelled(err)) fail(err); }),
        }, 'Share invite')),
      h('form', {
        class: 'inline',
        onsubmit: async (e) => {
          e.preventDefault();
          const c = core.parseInvite(codeInput.value);
          if (!c) return toast('That doesn\'t look like an invite code');
          try {
            const [p] = check(await sb.rpc('send_friend_request', { code: c }));
            toast(p.status === 'accepted' ? `You're now friends with ${nameOf(p)}` : `Request sent to ${nameOf(p)}`);
            renderCommunity();
          } catch (err) {
            fail(err);
          }
        },
      }, codeInput, h('button', { type: 'submit' }, 'Add')),
      incoming.length ? h('h3', {}, 'Requests') : null,
      incoming.length ? h('ul', { class: 'list' }, incoming.map((r) => h('li', { class: 'person' },
        h('b', {}, nameOf(r.other)),
        h('button', { class: 'chip', onclick: respond(r, true) }, 'Accept'),
        h('button', { class: 'link', onclick: respond(r, false) }, 'Decline')))) : null,
      h('h3', {}, `Friends (${friends.length})`),
      friends.length
        ? h('ul', { class: 'list' }, friends.map(friendRow))
        : h('p', { class: 'fine' }, 'No friends yet — share your invite code.'),
      outgoing.length ? h('p', { class: 'fine' }, `Waiting on: ${outgoing.map((r) => nameOf(r.other)).join(', ')}`) : null,
      h('h3', {}, 'Map layers'),
      h('label', { class: 'row' },
        h('span', {}, 'Community map', h('small', {}, 'Blocks explored by you, friends and public profiles. Tap a block to see who got there first.')),
        h('input', {
          type: 'checkbox', checked: communityOn,
          onchange: (e) => { communityOn = e.target.checked; drawCommunity(); },
        })),
    );
  }

  map.createPane('friends').style.zIndex = '425';
  const friendLayer = L.layerGroup([], { pane: 'friends' }).addTo(map);
  /** @type {{friend:object, cells:Set<string>}|null} */
  let overlay = null;

  async function fetchAllCells(userId) {
    const cells = new Set();
    for (let from = 0; ; from += 1000) {
      const rows = check(await sb.from('user_cells').select('cell').eq('user_id', userId)
        .order('cell').range(from, from + 999));
      for (const r of rows) cells.add(r.cell);
      if (rows.length < 1000) return cells;
    }
  }

  async function showFriendOverlay(friend) {
    toast(`Loading ${nameOf(friend)}'s map…`);
    overlay = { friend, cells: await fetchAllCells(friend.id) };
    S.closeSheet();
    S.render();
  }

  async function clearFriendOverlay() {
    overlay = null;
    friendLayer.clearLayers();
    $('compareBar').hidden = true;
    document.body.classList.remove('comparing');
  }
  $('btnCompareClose').addEventListener('click', clearFriendOverlay);

  function drawFriendOverlay(myDisplay) {
    friendLayer.clearLayers();
    if (!overlay) return;
    const theirs = new Set([...overlay.cells].map(S.toDisplay));
    const bounds = map.getBounds().pad(0.5);
    const draw = [...theirs].filter((c) => bounds.contains(h3.cellToLatLng(c)));
    if (draw.length) {
      L.polygon(h3.cellsToMultiPolygon(draw, false), {
        pane: 'friends', color: FRIEND_COLOR, weight: 2, opacity: 0.95,
        fillColor: FRIEND_COLOR, fillOpacity: 0.16, interactive: false,
      }).addTo(friendLayer);
    }
    const mine = new Set([...myDisplay].filter((c) => !isHidden(c)));
    const cmp = core.compare(mine, theirs);
    $('compareText').replaceChildren(
      h('b', {}, nameOf(overlay.friend)), ` · ${cmp.both.toLocaleString()} shared · `,
      h('span', { class: 'you' }, `${cmp.onlyMine.toLocaleString()} only you`), ' · ',
      h('span', { class: 'them' }, `${cmp.onlyTheirs.toLocaleString()} only them`));
    $('compareBar').hidden = false;
    document.body.classList.add('comparing');
  }

  // ---------- community map ----------

  map.createPane('community').style.zIndex = '402';
  const communityLayer = L.layerGroup([], { pane: 'community' }).addTo(map);
  let communityOn = false;
  let communityKey = '';
  /** @type {Map<string, {explorers:number, first_username:string, first_visited:string}>} */
  let communityCells = new Map();
  let communityTimer = null;

  function drawCommunity() {
    clearTimeout(communityTimer);
    if (!communityOn) {
      communityLayer.clearLayers();
      communityKey = '';
      return;
    }
    communityTimer = setTimeout(async () => {
      if (map.getZoom() < 12) {
        communityLayer.clearLayers();
        return;
      }
      const b = map.getBounds().pad(0.2);
      let cells8 = [];
      try {
        cells8 = h3.polygonToCells([
          [b.getSouth(), b.getWest()], [b.getNorth(), b.getWest()],
          [b.getNorth(), b.getEast()], [b.getSouth(), b.getEast()],
        ], 8, true);
      } catch (e) {
        return;
      }
      if (!cells8.length || cells8.length > 400) return;
      const key = cells8.sort().join();
      if (key === communityKey) return;
      communityKey = key;
      try {
        const rows = check(await sb.rpc('collective_map', { cells8 }));
        communityCells = new Map(rows.map((r) => [r.cell, r]));
        communityLayer.clearLayers();
        for (const r of rows) {
          L.polygon(h3.cellToBoundary(r.cell), {
            pane: 'community', stroke: false, interactive: false,
            fillColor: COMMUNITY_COLOR, fillOpacity: Math.min(0.15 + 0.1 * r.explorers, 0.65),
          }).addTo(communityLayer);
        }
      } catch (err) {
        communityKey = '';
        fail(err);
      }
    }, 600);
  }

  map.on('click', (e) => {
    if (!communityOn) return;
    const r = communityCells.get(h3.latLngToCell(e.latlng.lat, e.latlng.lng, 9));
    if (!r) return;
    L.popup().setLatLng(e.latlng).setContent(h('div', {},
      h('b', {}, `${r.explorers} explorer${r.explorers === 1 ? '' : 's'}`), h('br'),
      `First here: ${r.first_username} (${new Date(r.first_visited).toLocaleDateString()})`)).openOn(map);
  });

  document.addEventListener('scoop:render', (e) => {
    drawFriendOverlay(e.detail.display);
    drawCommunity();
  });

  // ---------- leaderboards ----------

  const rankPrefs = loadJSON('scoop.ranks', { scope: 'friends', period: 'week', metric: 'score' });

  async function renderRanks(panel) {
    const select = (key, options) => h('select', {
      'aria-label': key,
      onchange: (e) => { rankPrefs[key] = e.target.value; saveJSON('scoop.ranks', rankPrefs); renderCommunity(); },
    }, options.map(([v, label]) => h('option', { value: v, selected: rankPrefs[key] === v }, label)));
    const rows = check(await sb.rpc('leaderboard', rankPrefs));
    const unit = { score: 'pts', hexes: 'hexes', km: 'km' }[rankPrefs.metric];
    fill(panel, 
      h('div', { class: 'filters' },
        select('scope', [['friends', 'Friends'], ['public', 'Everyone']]),
        select('period', [['week', 'This week'], ['all', 'All time']]),
        select('metric', [['score', 'Score'], ['hexes', 'Hexes'], ['km', 'Distance']])),
      rows.length
        ? h('ol', { class: 'list ranks' }, rows.map((r) => h('li', { class: r.user_id === uid() ? 'me' : '' },
          h('span', { class: 'rank' }, String(r.rank)),
          h('span', { class: 'who' }, nameOf(r)),
          h('span', { class: 'val' }, `${Number(r.value).toLocaleString()} ${unit}`))))
        : h('p', { class: 'fine' }, rankPrefs.scope === 'public'
          ? 'No public profiles yet. Turn on "Public profile" in the Me tab to appear here.'
          : 'No one here yet.'),
      h('p', { class: 'fine' },
        'Score: 1 point per new street hex, bonus points for hexes you keep returning to (all-time only), ' +
        'plus check-ins — photo 3, coffee or food 2, meeting a friend 5.'),
    );
  }

  // ---------- challenges ----------

  map.createPane('challenge').style.zIndex = '403';
  const challengeLayer = L.layerGroup([], { pane: 'challenge' }).addTo(map);
  let openChallenge = null;

  function viewCells8() {
    const b = map.getBounds();
    return h3.polygonToCells([
      [b.getSouth(), b.getWest()], [b.getNorth(), b.getWest()],
      [b.getNorth(), b.getEast()], [b.getSouth(), b.getEast()],
    ], 8, false);
  }

  function challengeStatus(c) {
    const now = Date.now();
    const end = Date.parse(c.ends_at);
    if (end < now) return 'Finished';
    if (Date.parse(c.starts_at) > now) return 'Not started';
    const days = Math.ceil((end - now) / 86400000);
    return `${days} day${days === 1 ? '' : 's'} left`;
  }

  async function renderChallenges(panel) {
    if (openChallenge) return renderChallengeDetail(panel, openChallenge);
    const rows = check(await sb.from('challenge_members')
      .select('status, challenges(id, title, metric, starts_at, ends_at, creator, area_cells)')
      .eq('user_id', uid()));
    const list = rows.filter((r) => r.challenges)
      .sort((a, b) => (a.challenges.ends_at < b.challenges.ends_at ? 1 : -1));
    fill(panel, 
      h('button', { class: 'primary', onclick: () => renderNewChallenge(panel).catch(fail) }, 'New challenge'),
      list.length
        ? h('ul', { class: 'list' }, list.map((r) => {
          const c = r.challenges;
          return h('li', { class: 'person' },
            h('span', {}, h('b', {}, c.title), h('small', {}, ` ${c.metric} · ${challengeStatus(c)}`)),
            r.status === 'invited'
              ? h('button', {
                class: 'chip',
                onclick: async () => {
                  try {
                    check(await sb.from('challenge_members').update({ status: 'joined' }).eq('challenge_id', c.id).eq('user_id', uid()));
                    renderCommunity();
                  } catch (err) {
                    fail(err);
                  }
                },
              }, 'Join')
              : null,
            h('button', { class: 'link', onclick: () => { openChallenge = c; renderCommunity(); } }, 'Open'));
        }))
        : h('p', { class: 'fine' }, 'Race your friends: most new hexes, distance or score in a set time — optionally in one part of town.'),
    );
  }

  async function renderChallengeDetail(panel, c) {
    const rows = check(await sb.rpc('challenge_standings', { cid: c.id }));
    const unit = { score: 'pts', hexes: 'hexes', km: 'km' }[c.metric];
    const mine = rows.find((r) => r.user_id === uid());
    challengeLayer.clearLayers();
    fill(panel, 
      h('button', { class: 'link', onclick: () => { openChallenge = null; challengeLayer.clearLayers(); renderCommunity(); } }, '‹ All challenges'),
      h('h3', {}, c.title),
      h('p', { class: 'fine' }, `${c.metric} · ${new Date(c.starts_at).toLocaleDateString()} – ${new Date(c.ends_at).toLocaleDateString()} · ${challengeStatus(c)}`,
        c.area_cells ? ' · limited to an area' : ''),
      h('ol', { class: 'list ranks' }, rows.map((r) => h('li', { class: r.user_id === uid() ? 'me' : '' },
        h('span', { class: 'rank' }, r.status === 'joined' ? String(r.rank) : '–'),
        h('span', { class: 'who' }, nameOf(r)),
        h('span', { class: 'val' }, r.status === 'joined' ? `${Number(r.value).toLocaleString()} ${unit}` : 'invited')))),
      c.area_cells ? h('button', {
        onclick: () => {
          challengeLayer.clearLayers();
          const area = L.polygon(h3.cellsToMultiPolygon(c.area_cells, false), {
            pane: 'challenge', color: COMMUNITY_COLOR, weight: 3, dashArray: '8 6', fillOpacity: 0.05, interactive: false,
          }).addTo(challengeLayer);
          S.closeSheet();
          map.fitBounds(area.getBounds(), { padding: [30, 30] });
        },
      }, 'Show area on map') : null,
      c.creator === uid()
        ? h('button', {
          class: 'link danger',
          onclick: async () => {
            if (!confirm('Delete this challenge for everyone?')) return;
            try {
              check(await sb.from('challenges').delete().eq('id', c.id));
              openChallenge = null;
              renderCommunity();
            } catch (err) {
              fail(err);
            }
          },
        }, 'Delete challenge')
        : h('button', {
          class: 'link danger',
          onclick: async () => {
            try {
              check(await sb.from('challenge_members').delete().eq('challenge_id', c.id).eq('user_id', uid()));
              openChallenge = null;
              renderCommunity();
            } catch (err) {
              fail(err);
            }
          },
        }, mine && mine.status === 'invited' ? 'Decline' : 'Leave challenge'),
    );
  }

  async function renderNewChallenge(panel) {
    const friends = (await loadFriends()).filter((r) => r.status === 'accepted').map((r) => r.other);
    const title = h('input', { placeholder: 'Weekend hex hunt', maxlength: '60', required: true });
    const metric = h('select', {}, [['hexes', 'Most new hexes'], ['km', 'Longest distance'], ['score', 'Highest score']]
      .map(([v, l]) => h('option', { value: v }, l)));
    const days = h('select', {}, [1, 3, 7, 14, 30].map((d) => h('option', { value: String(d), selected: d === 7 }, `${d} day${d === 1 ? '' : 's'}`)));
    const area = h('input', { type: 'checkbox' });
    const picks = friends.map((p) => ({ p, box: h('input', { type: 'checkbox', checked: true }) }));
    fill(panel, h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          let areaCells = null;
          if (area.checked) {
            areaCells = viewCells8();
            if (!areaCells.length || areaCells.length > 400) throw new Error('Zoom the map to the area you want first');
          }
          const start = new Date();
          const c = check(await sb.from('challenges').insert({
            title: title.value.trim(), metric: metric.value, area_cells: areaCells,
            starts_at: start.toISOString(), ends_at: new Date(+start + Number(days.value) * 86400000).toISOString(),
          }).select('id, title, metric, starts_at, ends_at, creator, area_cells').single());
          const invites = picks.filter((x) => x.box.checked).map((x) => ({ challenge_id: c.id, user_id: x.p.id, status: 'invited' }));
          if (invites.length) check(await sb.from('challenge_members').insert(invites));
          openChallenge = c;
          renderCommunity();
        } catch (err) {
          fail(err);
        }
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Name'), title),
    h('label', { class: 'row' }, h('span', {}, 'Goal'), metric),
    h('label', { class: 'row' }, h('span', {}, 'Length'), days),
    h('label', { class: 'row' }, h('span', {}, 'Only count hexes in the area on the map now', h('small', {}, 'Distance counts everywhere')), area),
    h('h3', {}, 'Invite'),
    picks.length
      ? picks.map((x) => h('label', { class: 'row' }, h('span', {}, nameOf(x.p)), x.box))
      : h('p', { class: 'fine' }, 'Add friends first to race them.'),
    h('button', { class: 'primary', type: 'submit' }, 'Start challenge'),
    h('button', { class: 'link', type: 'button', onclick: () => renderCommunity() }, 'Cancel')));
  }

  // ---------- me: profile, badges, streak ----------

  async function renderMe(panel) {
    const [badges, board] = await Promise.all([
      sb.from('badges').select('badge_key, earned_at').eq('user_id', uid()).then(check),
      sb.rpc('leaderboard', { scope: 'friends', metric: 'score', period: 'all' }).then(check),
    ]);
    const earned = new Map(badges.map((b) => [b.badge_key, b.earned_at]));
    const me = board.find((r) => r.user_id === uid());
    const streak = core.streaks(S.walks.map((w) => w.start));
    const f = profileFields(profile);
    fill(panel, 
      h('div', { class: 'me-stats' },
        h('div', {}, h('b', {}, me ? Number(me.value).toLocaleString() : '0'), h('small', {}, 'score')),
        h('div', {}, h('b', {}, `${streak.current}🔥`), h('small', {}, 'day streak')),
        h('div', {}, h('b', {}, String(streak.longest)), h('small', {}, 'best streak')),
        h('div', {}, h('b', {}, `${earned.size}/${Object.keys(core.BADGES).length}`), h('small', {}, 'badges'))),
      h('h3', {}, 'Badges'),
      h('ul', { class: 'badges' }, Object.entries(core.BADGES).map(([key, b]) => h('li', {
        class: earned.has(key) ? 'earned' : '',
        title: earned.has(key) ? `${b.desc} — earned ${new Date(earned.get(key)).toLocaleDateString()}` : b.desc,
      }, h('span', { class: 'icon' }, b.icon), h('span', {}, b.label), h('small', {}, b.desc)))),
      h('h3', {}, 'Profile'),
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            profile = check(await sb.from('profiles').update(readProfile(f)).eq('id', uid()).select(PROFILE_COLS).single());
            toast('Profile saved');
            if (communityOn) { communityKey = ''; drawCommunity(); }
          } catch (err) {
            fail(profileError(err));
          }
        },
      }, profileForm(f), h('button', { type: 'submit' }, 'Save profile')),
      h('h3', {}, 'Sync'),
      h('p', { class: 'fine', id: 'syncStatus' }, syncStatus),
      h('div', { class: 'buttons' },
        h('button', { onclick: () => sync() }, 'Sync now'),
        h('button', { onclick: () => sb.auth.signOut() }, 'Sign out')),
      h('button', { class: 'link danger', onclick: deleteAccount }, 'Delete my account and community data'),
    );
  }

  async function deleteAccount() {
    if (!confirm('Delete your account, friends, check-ins and everything you uploaded? Your map on this device stays.')) return;
    try {
      const files = check(await sb.storage.from(PHOTO_BUCKET).list(uid(), { limit: 1000 }));
      if (files.length) check(await sb.storage.from(PHOTO_BUCKET).remove(files.map((f) => `${uid()}/${f.name}`)));
      check(await sb.rpc('delete_my_account'));
      syncState = { uid: null, cells: {}, walks: [] };
      saveSync();
      await sb.auth.signOut();
      toast('Account deleted');
    } catch (err) {
      fail(err);
    }
  }

  // ---------- check-ins ----------

  const checkinLayer = L.layerGroup().addTo(map);

  async function loadCheckinMarkers() {
    if (!profile) return;
    try {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const rows = check(await sb.from('checkins')
        .select('id, user_id, cell, kind, note, met_with, created_at, author:profiles!checkins_user_id_fkey(username, display_name)')
        .gte('created_at', since).order('created_at', { ascending: false }).limit(300));
      checkinLayer.clearLayers();
      for (const r of rows) {
        const kind = core.CHECKIN_KINDS[r.kind];
        L.marker(h3.cellToLatLng(r.cell), {
          icon: L.divIcon({ className: `checkin-pin${r.user_id === uid() ? ' mine' : ''}`, html: kind.icon, iconSize: [30, 30] }),
          title: `${nameOf(r.author)}: ${kind.label}`,
        }).bindPopup(() => h('div', {},
          h('b', {}, nameOf(r.author)), ` · ${kind.label}`, h('br'),
          r.note ? [r.note, h('br')] : null,
          h('small', {}, core.timeAgo(Date.parse(r.created_at)))))
          .addTo(checkinLayer);
      }
      toggleCheckinMarkers();
    } catch (err) {
      // Markers are a nice-to-have; don't nag when offline.
    }
  }

  function toggleCheckinMarkers() {
    const show = map.getZoom() >= 13;
    if (show && !map.hasLayer(checkinLayer)) checkinLayer.addTo(map);
    if (!show && map.hasLayer(checkinLayer)) map.removeLayer(checkinLayer);
  }
  map.on('zoomend', toggleCheckinMarkers);

  // The check-in button appears once we know where you are.
  setInterval(() => document.body.classList.toggle('has-fix', !!S.position()), 2000);

  let checkinKind = 'coffee';

  function hereCell() {
    const pos = S.position();
    return pos ? h3.latLngToCell(pos.latlng.lat, pos.latlng.lng, S.BASE_RES) : null;
  }

  $('btnCheckin').addEventListener('click', () => {
    renderCheckin();
    S.openSheet('checkinSheet');
  });
  $('btnCheckinClose').addEventListener('click', S.closeSheet);

  function renderCheckin() {
    const cell = hereCell();
    const body = $('checkinBody');
    if (!cell) return body.replaceChildren(h('p', {}, 'Waiting for your location…'));
    if (!S.visited.has(cell)) {
      return body.replaceChildren(h('p', {}, 'Walk through this hex first — you can only check in where you\'ve explored.'));
    }
    if (isHidden(cell)) return body.replaceChildren(h('p', {}, 'This hex is inside one of your privacy zones, so it can\'t be shared.'));
    const note = h('input', { placeholder: 'Add a note (optional)', maxlength: '140' });
    const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    const photoHint = h('small', {});
    const kinds = h('div', { class: 'kinds', role: 'radiogroup' });
    const drawKinds = () => {
      kinds.replaceChildren(...Object.entries(core.CHECKIN_KINDS).map(([key, k]) => h('button', {
        type: 'button', class: 'kind', role: 'radio', 'aria-checked': String(key === checkinKind),
        onclick: () => { checkinKind = key; drawKinds(); },
      }, h('span', { class: 'icon' }, k.icon), k.label, h('small', {}, `+${k.points}`))));
      photoHint.textContent = checkinKind === 'photo' ? 'Required' : 'Optional';
      if (checkinKind === 'meetup') photoHint.textContent += ' — the meetup counts once a friend checks in here within 30 minutes';
    };
    drawKinds();
    const submit = h('button', { class: 'primary', type: 'submit' }, 'Check in');
    body.replaceChildren(h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const file = photo.files[0];
        if (checkinKind === 'photo' && !file) return toast('Add a photo first');
        submit.disabled = true;
        try {
          await sync(); // the server only accepts check-ins in hexes it knows you walked
          let photoPath = null;
          if (file) {
            photoPath = `${uid()}/${Date.now()}.jpg`;
            check(await sb.storage.from(PHOTO_BUCKET).upload(photoPath, await compressPhoto(file), { contentType: 'image/jpeg' }));
          }
          const { id } = check(await sb.from('checkins')
            .insert({ cell, kind: checkinKind, note: note.value.trim() || null, photo_path: photoPath })
            .select('id').single());
          // Read it back: a trigger links the meetup after the insert returns.
          const row = check(await sb.from('checkins').select('met_with').eq('id', id).single());
          S.closeSheet();
          const k = core.CHECKIN_KINDS[checkinKind];
          if (checkinKind !== 'meetup') toast(`${k.icon} Checked in · +${k.points} points`);
          else toast(row.met_with ? '🤝 Meetup verified · +5 points' : '🤝 Checked in — waiting for a friend to check in here');
          loadCheckinMarkers();
        } catch (err) {
          fail(err.code === '23505' ? new Error('You already checked in like that here today') : err);
        } finally {
          submit.disabled = false;
        }
      },
    },
    kinds,
    h('label', { class: 'field' }, h('span', {}, 'Note'), note),
    h('label', { class: 'field' }, h('span', {}, 'Photo ', photoHint), photo),
    submit));
  }

  /** Downscale to at most 1280 px and re-encode as JPEG (also strips EXIF location). */
  async function compressPhoto(file) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  }

  // ---------- boot ----------

  // Exposed for debugging and end-to-end tests.
  window.scoopSocial = { sb, sync, get profile() { return profile; } };
})();
