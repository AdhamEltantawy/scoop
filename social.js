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
  const Areas = window.scoopAreas;
  if (!S || !core || !window.h3) return;

  const { map, toast, el: h, fill, segmented, confirmDialog } = S;
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
  const PROFILE_COLS = 'id, username, display_name';
  const AREA_WAIT_MS = 3 * 86400000;
  // How often an open app checks your account for walks from your other devices.
  const PULL_EVERY_MS = 2 * 60000;
  // Fetch hexes changed a little before the last one we saw too, in case an
  // upload that started earlier finished after we looked. Merging is idempotent.
  const PULL_OVERLAP_MS = 60000;
  const PHOTO_BUCKET = 'checkin-photos';

  // Set once signed in (only possible when sb is configured).
  let session = null;
  let profile = null;
  const uid = () => (session ? session.user.id : null);

  // ---------- small helpers ----------

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
  const initialOf = (name) => (Array.from(String(name || '').trim())[0] || '?').toUpperCase();
  const fmtKm = (km) => Number(km).toFixed(km >= 10 ? 1 : 2);
  const fmtPts = (n) => Math.round(Number(n) || 0).toLocaleString();
  const avatar = (name, cls = '') => h('span', { class: `avatar ${cls}`, 'aria-hidden': 'true' }, initialOf(name));
  /** Reporting and blocking (moderation.js), once it has loaded. */
  const mod = () => (window.scoopKit && window.scoopKit.mod) || null;

  const sheetHead = (title) => h('div', { class: 'sheet-head' },
    h('span', { class: 'sheet-title' }, title),
    h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕'));

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
  const ZONE_RADII = [200, 300, 500, 800];
  /** @type {{lat:number,lng:number,r:number}[]} */
  const zones = loadJSON(ZONES_KEY, []);
  let isHidden = core.zoneFilter(zones, h3.cellToLatLng, distance);
  // Zones are drawn only after "Show on map", so the map stays clean.
  let zonesShown = false;

  function zonesChanged() {
    saveJSON(ZONES_KEY, zones);
    isHidden = core.zoneFilter(zones, h3.cellToLatLng, distance);
    drawZones();
    renderZoneList();
    afterZonesChanged();
  }

  function drawZones() {
    zoneLayer.clearLayers();
    if (!zonesShown) return;
    for (const z of zones) {
      L.circle([z.lat, z.lng], {
        pane: 'zones', radius: z.r, color: S.COLORS.privacyStroke, weight: 2, dashArray: '6 5',
        fillColor: S.COLORS.privacy, fillOpacity: 0.12, interactive: false,
      }).addTo(zoneLayer);
    }
  }

  const zoneName = (i) => ['Zone 1', 'Zone 2', 'Zone 3'][i] || `Zone ${i + 1}`;

  function renderZoneList() {
    fill($('zoneList'), zones.map((z, i) => h('div', { class: 'zone-card' },
      h('div', { class: 'zone-head' },
        h('span', { class: 'zone-ring', 'aria-hidden': 'true' }),
        h('span', { class: 'zone-name' }, zoneName(i)),
        h('span', { class: 'sub' }, `${z.r} m`)),
      segmented(h('div', { class: 'seg', 'aria-label': `${zoneName(i)} radius` }),
        ZONE_RADII.map((r) => [r, `${r} m`]), z.r, (r) => { z.r = r; zonesChanged(); }),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn outline',
          onclick: () => {
            zonesShown = true;
            drawZones();
            S.closeSheet();
            map.fitBounds(L.latLng(z.lat, z.lng).toBounds(z.r * 2.6));
          },
        }, 'Show on map'),
        h('button', {
          class: 'btn outline danger',
          onclick: () => { zones.splice(i, 1); zonesChanged(); toast('Zone removed'); },
        }, 'Remove')))));
    $('btnAddZone').disabled = zones.length >= 3;
    $('btnAddZone').textContent = zones.length >= 3 ? 'Up to 3 zones' : 'Add zone at map centre';
    $('zonesCount').textContent = `${zones.length} of 3`;
  }

  $('btnZones').addEventListener('click', () => {
    renderZoneList();
    S.openSheet('zonesSheet');
  });
  $('btnZonesBack').addEventListener('click', () => S.openSettings());
  $('btnAddZone').addEventListener('click', () => {
    if (zones.length >= 3) return;
    const c = map.getCenter();
    zones.push({ lat: c.lat, lng: c.lng, r: 300 });
    zonesShown = true;
    zonesChanged();
    toast('Privacy zone added at the map centre');
  });
  document.addEventListener('scoop:cleared', () => {
    zones.length = 0;
    zonesChanged();
  });

  drawZones();
  renderZoneList();

  // ---------- share card ----------

  async function shareCard() {
    const res = S.BASE_RES;
    const W = 1080;
    const H = 1350;
    const frame = { x: 40, y: 170, w: 1000, h: 880 };
    const canvas = h('canvas', { width: W, height: H });
    const ctx = canvas.getContext('2d');
    const display = "'Bricolage Grotesque', system-ui, sans-serif";
    const body = "'Instrument Sans', system-ui, sans-serif";

    ctx.fillStyle = '#F5F0E8';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#1E1A16';
    ctx.font = `700 68px ${display}`;
    ctx.fillText('Scoop', 48, 112);
    ctx.fillStyle = '#6E655B';
    ctx.font = `500 32px ${body}`;
    ctx.textAlign = 'right';
    ctx.fillText(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }), W - 48, 108);
    ctx.textAlign = 'left';

    // Hexes in the current view, minus anything in a privacy zone.
    const bounds = map.getBounds();
    const inView = (c) => bounds.contains(h3.cellToLatLng(c));
    const shown = new Set();
    for (const c of S.visited.keys()) if (!isHidden(c)) shown.add(c);
    const now = Date.now();

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
    if (ctx.roundRect) ctx.roundRect(frame.x, frame.y, frame.w, frame.h, 40);
    else ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.fillStyle = '#FFFFFF';
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
      ctx.strokeStyle = 'rgba(26, 26, 26, 0.12)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // Same heat bands as the map, coldest first.
    const bands = S.HEAT_BANDS.map(() => []);
    for (const c of shown) {
      if (!inView(c)) continue;
      const heat = core.heat(S.lastSeen.get(c), now);
      bands[S.HEAT_BANDS.findIndex((b) => heat >= b.min)].push(c);
    }
    for (let i = bands.length - 1; i >= 0; i--) {
      if (!bands[i].length) continue;
      const b = S.HEAT_BANDS[i];
      ctx.beginPath();
      for (const c of bands[i]) hexPath(c);
      ctx.globalAlpha = b.fill;
      ctx.fillStyle = b.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = b.stroke;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.restore();

    let km2 = 0;
    for (const c of S.visited.keys()) km2 += S.cellAreaCached(c);
    const totalKm = S.walks.reduce((a, w) => a + (w.km || 0), 0);
    const stats = [
      [shown.size.toLocaleString(), 'hexes'],
      [S.formatNum(km2), 'km² explored'],
      [S.formatNum(totalKm), 'km walked'],
      [S.walks.length.toLocaleString(), 'walks'],
    ];
    const colW = (W - 80) / stats.length;
    stats.forEach(([num, lbl], i) => {
      const x = 40 + colW * i + colW / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = i === 0 ? '#E0301E' : '#1E1A16';
      ctx.font = `700 60px ${display}`;
      ctx.fillText(num, x, 1152);
      ctx.fillStyle = '#6E655B';
      ctx.font = `500 28px ${body}`;
      ctx.fillText(lbl, x, 1196);
    });
    ctx.fillStyle = '#0B7A62';
    ctx.font = `600 28px ${body}`;
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
    $('communityNote').textContent = 'Your map, walks, trends and privacy zones stay on this phone. Community features are off in this build.';
    return;
  }
  document.body.classList.add('community-on');

  // ---------- sync ----------

  let syncState = loadJSON(SYNC_KEY, { uid: null, cells: {}, walks: [] });
  let syncing = false;
  let syncAgain = false;
  let syncTimer = null;
  let syncStatus = 'Not synced yet';
  let pullError = null;
  let lastPull = 0; // when this session last fetched your hexes from your account

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
      if (Date.now() - lastPull >= PULL_EVERY_MS) {
        // A failed pull must never hold up uploads: try again next sync.
        try {
          await pullFromServer();
          lastPull = Date.now();
        } catch (err) {
          pullError = err;
        }
      }
      if (Areas) await Areas.ready; // Scoop's own districts, before reading any tags
      const areaOf = Areas ? Areas.of : () => null;
      const cutoff = Date.now() - AREA_WAIT_MS;
      // Hexes with no country yet still need OSM, even when Scoop's own district is known.
      const needsOsm = (x) => !x.a || !x.a[0];
      // Upload what can go up now. Recent hexes with no country wait for OSM;
      // after a few days they go up without. In Scoop's own districts they go
      // up right away: the server knows the rest. Returns what was changed
      // before the upload (uploaded or still waiting).
      const uploadCells = async () => {
        const delta = core.syncDelta(S.visited, S.visitCount, S.lastSeen, areaOf, syncState.cells, isHidden);
        const ready = delta.filter((x) => core.readyToUpload(x, cutoff));
        for (const batch of core.chunk(ready, 1000)) {
          const ids = new Set(batch.flatMap((x) => x.a || []).filter(Boolean));
          const areas = [...ids].map((id) => ({ id, ...Areas.info(id) })).filter((a) => a.kind);
          check(await sb.rpc('sync_cells', { cells: batch, areas }));
          for (const x of batch) syncState.cells[x.c] = core.cellSig(x);
          saveSync();
        }
        return delta;
      };
      // Upload first, look up areas after: OSM can be slow (or down), and a
      // slow lookup must never keep hexes and walks off the server. Own-district
      // hexes are looked up too, so the server learns their real country and city.
      let delta = await uploadCells();
      await uploadWalks();
      let untagged = 0;
      if (Areas && delta.some(needsOsm)) {
        untagged = await Areas.resolve(delta.filter(needsOsm).map((x) => x.c));
        delta = await uploadCells();
      }
      const held = delta.filter((x) => !core.readyToUpload(x, cutoff)).length;
      if (untagged) scheduleSync(60000);
      syncStatus = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` +
        (held ? ` · ${held.toLocaleString()} hex${held === 1 ? '' : 'es'} waiting for their area` : '') +
        (pullError ? ` · couldn't restore your map: ${pullError.message}` : '');
      pullError = null;
    } catch (err) {
      syncStatus = navigator.onLine ? `Sync failed: ${err.message}` : 'Offline · will sync when back online';
    } finally {
      syncing = false;
      const status = $('syncStatus');
      if (status) status.textContent = syncStatus;
    }
    if (syncAgain) {
      syncAgain = false;
      await sync();
    }
  }

  async function uploadWalks() {
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
  }

  /** Every row of a query, a page at a time (Supabase returns at most 1000 per request). */
  async function fetchAll(query, order) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = check(await query().order(order).range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  /**
   * Your own hexes with their dates (the table hides dates, so this goes
   * through my_cells()), all of them or only those changed after `since`.
   */
  async function fetchMyCells(since) {
    const out = [];
    for (let after = ''; ;) {
      const rows = check(await sb.rpc('my_cells', since ? { after_cell: after, since } : { after_cell: after }));
      out.push(...rows);
      if (rows.length < 1000) return out;
      after = rows[rows.length - 1].cell;
    }
  }

  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : word.endsWith('x') ? 'es' : 's'}`;

  /**
   * Bring in your hexes and walks from your account: after reinstalling the
   * app, on another phone, and whatever your other devices walked since this
   * one last looked (the app on your phone, this browser). The first time
   * everything comes down; after that only what changed. It merges, so
   * nothing on this device is lost.
   */
  async function pullFromServer() {
    const first = !syncState.pulledAt;
    const since = first ? null : new Date(Date.parse(syncState.pulledAt) - PULL_OVERLAP_MS).toISOString();
    const walkAfter = first ? 0 : syncState.pulledWalk || 0;
    const [cellRows, walkRows] = await Promise.all([
      fetchMyCells(since),
      fetchAll(() => sb.from('walks').select('id, started_at, ended_at, km, new_cells').eq('user_id', uid()).gt('id', walkAfter), 'id'),
    ]);
    const valid = (c) => h3.isValidCell(c) && h3.getResolution(c) === S.BASE_RES;
    const got = core.mergeRemote(S, cellRows, walkRows, valid);
    // Walks already on the server don't need uploading again.
    const known = new Set(syncState.walks);
    for (const r of walkRows) {
      const start = Date.parse(r.started_at);
      if (!known.has(start)) syncState.walks.push(start);
    }
    let cursor = syncState.pulledAt ? Date.parse(syncState.pulledAt) : 0;
    for (const r of cellRows) cursor = Math.max(cursor, Date.parse(r.synced_at) || 0);
    // Older servers don't send synced_at: keep doing full pulls until they do.
    syncState.pulledAt = cursor ? new Date(cursor).toISOString() : undefined;
    for (const r of walkRows) syncState.pulledWalk = Math.max(syncState.pulledWalk || 0, Number(r.id) || 0);
    delete syncState.pulled; // from before pulls were incremental
    saveSync();
    if (!got.cells && !got.warmed && !got.walks) return;
    S.saveNow();
    S.render();
    if (!got.cells && !got.walks) return; // only warmed-up hexes: the map shows it
    const what = [got.cells && plural(got.cells, 'new hex'), got.walks && plural(got.walks, 'walk')].filter(Boolean).join(', ');
    toast(`${first ? 'Restored from your account' : 'From your other devices'} · ${what}`, 4000);
  }

  /** Remove anything now inside a privacy zone from the server, or upload what left one. */
  async function afterZonesChanged() {
    if (!profile) return;
    try {
      const hidden = Object.keys(syncState.cells).filter(isHidden);
      for (const batch of core.chunk(hidden, 200)) {
        check(await sb.from('user_cells').delete().eq('user_id', uid()).in('cell', batch));
        check(await sb.from('checkins').delete().eq('user_id', uid()).in('cell', batch));
        check(await sb.from('landmarks').delete().eq('user_id', uid()).in('cell', batch));
        for (const c of batch) delete syncState.cells[c];
        saveSync();
      }
      await sync();
      loadCheckinMarkers();
      reloadLandmarks();
    } catch (err) {
      fail(err);
    }
  }

  document.addEventListener('scoop:changed', () => scheduleSync());
  window.addEventListener('online', () => scheduleSync(1000));
  // Back to the app or tab: pick up walks from your other devices right away.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !profile) return;
    lastPull = 0;
    scheduleSync(500);
  });
  // And keep checking while it stays open on the map.
  setInterval(() => {
    if (!document.hidden && profile) scheduleSync(0);
  }, PULL_EVERY_MS);

  // ---------- auth and identity ----------

  /** The areas you score most in ([{kind, name, rank, total, id}]), for the identity line, Me and ranks. */
  let homes = [];

  function updateIdentity() {
    if (!profile) {
      S.setIdentity({ initial: '·', name: 'Your map', sub: session ? 'Pick a username to finish signing in' : 'Signed out · everything stays on this phone' });
      return;
    }
    const district = homes.find((a) => a.kind === 'district');
    S.setIdentity({
      initial: initialOf(nameOf(profile)),
      name: nameOf(profile),
      sub: district && district.name ? `Walks mostly in ${district.name}` : `@${profile.username}`,
    });
  }

  async function loadHomes() {
    try {
      homes = check(await sb.rpc('my_areas', { period: 'now' }));
    } catch (err) {
      homes = [];
    }
    updateIdentity();
  }

  async function setSession(next) {
    const changed = uid() !== (next ? next.user.id : null);
    session = next;
    if (!changed && profile) return;
    profile = null;
    homes = [];
    firstsCache = null;
    clearFriendOverlay();
    document.body.classList.toggle('signed-in', false);
    if (session) {
      try {
        profile = check(await sb.from('profiles').select(PROFILE_COLS).eq('id', uid()).maybeSingle());
      } catch (err) {
        fail(err);
      }
    }
    updateIdentity();
    if (profile) onProfileReady();
    else reloadLandmarks(); // signed out: clear them
    if (S.currentSheet() === 'signinSheet') {
      if (profile) {
        S.closeSheet();
        toast(`Signed in as ${nameOf(profile)}`);
      } else if (session) {
        renderSignIn(2);
      }
    }
    if (S.currentSheet() === 'socialSheet') renderSocial();
    seedFirsts();
    document.dispatchEvent(new CustomEvent('scoop:profile', { detail: { profile } }));
  }

  function onProfileReady() {
    document.body.classList.add('signed-in');
    scheduleSync(500);
    acceptPendingInvite();
    loadCheckinMarkers();
    loadHomes();
    reloadLandmarks();
    setTimeout(checkInvitesUsed, 3000);
    // Signed in now: the pulse can say which explorer of the district you are.
    const pos = S.position();
    if (pos) loadPulse(pos.latlng, true);
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

  // A personal invite can carry a welcome landmark: the first one you're pointed to.
  const WELCOME_FROM_KEY = 'scoop.welcomeFrom.v1';

  /** Use an invite code: a personal one makes you friends now, an old-style one sends a request. */
  async function useInvite(code) {
    const [p] = check(await sb.rpc('use_invite', { code }));
    if (!p) return null;
    if (p.status === 'invalid') throw new Error("That code doesn't work. It may have expired or been used already. Ask for a new one");
    if (p.status === 'slow_down') throw new Error('Too many codes tried. Try again in an hour');
    if (p.landmark_id && (p.status === 'accepted' || p.status === 'already')) {
      saveJSON(WELCOME_FROM_KEY, { landmark: Number(p.landmark_id), from: nameOf(p) });
      firstsCache = null;
    }
    toast({
      accepted: `You're friends with ${nameOf(p)}` + (p.landmark_id ? ' · they left you a welcome to find' : ''),
      already: `You and ${nameOf(p)} are already friends`,
      lapsed: `Your friendship with ${nameOf(p)} lapsed. Renew it in Friends`,
      renewing: `Renewed on your side · waiting for ${nameOf(p)}`,
    }[p.status] || `Friend request sent to ${nameOf(p)}`, 4000);
    return p;
  }

  async function acceptPendingInvite() {
    const code = loadJSON(INVITE_KEY, null);
    if (!code) return;
    localStorage.removeItem(INVITE_KEY);
    try {
      await useInvite(code);
    } catch (err) {
      if (!/own code/.test(err.message)) fail(err);
    }
  }

  // ---------- sign in: email → code → name ----------

  let signInEmail = '';

  function openSignIn() {
    renderSignIn(session && !profile ? 2 : 0);
    S.openSheet('signinSheet');
  }

  function renderSignIn(step) {
    const titles = ['Sign in', 'Check your email', 'Pick a name'];
    const cta = h('button', { class: 'btn', type: 'submit', disabled: true }, ['Send code', 'Sign in', 'Start exploring'][step]);
    let content;
    let valid;
    let submit;

    if (step === 0) {
      const email = h('input', {
        class: 'input', type: 'email', placeholder: 'you@example.com', autocomplete: 'email', value: signInEmail, required: true,
      });
      valid = () => /^\S+@\S+\.\S+$/.test(email.value.trim());
      email.addEventListener('input', () => { cta.disabled = !valid(); });
      content = [
        h('span', { class: 'body' }, "We'll email you a sign-in code. No password to remember."),
        h('label', { class: 'field' }, 'Email', email),
      ];
      submit = async () => {
        signInEmail = email.value.trim();
        check(await sb.auth.signInWithOtp({ email: signInEmail, options: { shouldCreateUser: true } }));
        renderSignIn(1);
      };
    } else if (step === 1) {
      const code = h('input', {
        class: 'input code', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '••••••••', maxlength: '10',
        'aria-label': 'Code from the email',
      });
      // Supabase sends 6 to 10 digits, depending on the project's OTP length.
      valid = () => /^\d{6,10}$/.test(code.value.trim());
      code.addEventListener('input', () => {
        code.value = code.value.replace(/\D/g, '').slice(0, 10);
        cta.disabled = !valid();
      });
      content = [
        h('span', { class: 'body' }, 'Enter the code we sent to ', h('b', { style: 'color:var(--ink)' }, signInEmail), '.'),
        code,
        h('button', {
          class: 'link', type: 'button',
          onclick: async () => {
            try {
              check(await sb.auth.signInWithOtp({ email: signInEmail, options: { shouldCreateUser: true } }));
              toast('New code sent');
            } catch (err) {
              fail(err);
            }
          },
        }, 'Resend code'),
      ];
      submit = async () => {
        check(await sb.auth.verifyOtp({ email: signInEmail, token: code.value.trim(), type: 'email' }));
        // onAuthStateChange takes it from here: closes the sheet or moves to step 3.
      };
      setTimeout(() => code.focus(), 360);
    } else {
      const f = profileFields(profile || {});
      valid = () => core.validUsername(f.username.value.trim().toLowerCase());
      f.username.addEventListener('input', () => { cta.disabled = !valid(); });
      content = [
        profileForm(f),
        h('span', { class: 'card-note' }, 'Friends see your display name. Everyone else only ever sees "Explorer".'),
      ];
      submit = async () => {
        try {
          profile = check(await sb.from('profiles').insert({ id: uid(), ...readProfile(f) }).select(PROFILE_COLS).single());
        } catch (err) {
          throw profileError(err);
        }
        updateIdentity();
        onProfileReady();
        S.closeSheet();
        toast(`Welcome, ${nameOf(profile)}`);
      };
    }

    fill($('signinBody'), h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!valid()) return;
        cta.disabled = true;
        try {
          await submit();
        } catch (err) {
          fail(err);
        } finally {
          cta.disabled = !valid();
        }
      },
    },
    sheetHead(titles[step]),
    h('div', { class: 'progress-steps', 'aria-hidden': 'true' }, [0, 1, 2].map((i) => h('span', { class: i <= step ? 'on' : '' }))),
    content,
    cta,
    step === 0 ? h('span', { class: 'fine' }, 'Only hex ids, visit counts, visit times and walk totals are uploaded — never your GPS tracks. ' +
      'Hexes inside your privacy zones are never uploaded.') : null,
    step === 2 ? h('button', { class: 'btn ghost', type: 'button', onclick: () => sb.auth.signOut() }, 'Use a different email') : null));
    cta.disabled = !valid();
  }

  function profileFields(p) {
    return {
      username: h('input', {
        class: 'input', value: p.username || '', placeholder: 'walker_42', autocapitalize: 'none', autocomplete: 'username', maxlength: '20', required: true,
      }),
      display_name: h('input', { class: 'input', value: p.display_name || '', placeholder: 'Your name', maxlength: '40', dir: 'auto' }),
    };
  }

  function readProfile(f) {
    const username = f.username.value.trim().toLowerCase();
    if (!core.validUsername(username)) throw new Error('Usernames are 3–20 characters: a–z, 0–9 and _');
    return {
      username,
      display_name: f.display_name.value.trim() || null,
    };
  }

  function profileError(err) {
    return err.code === '23505' ? new Error('That username is taken') : err;
  }

  function profileForm(f) {
    return [
      h('label', { class: 'field' }, 'Username', f.username),
      h('label', { class: 'field' }, 'Display name', f.display_name),
    ];
  }

  // ---------- Me and Settings, signed-in parts ----------

  document.addEventListener('scoop:me-open', async () => {
    fill($('meSignedOut'), profile ? null : h('div', { class: 'panel tint' },
      h('span', { class: 'panel-title' }, 'Walk with friends'),
      h('span', { class: 'card-body' }, 'Sign in to compare maps, climb your district\'s ranks and race in challenges. Your map stays on this phone either way.'),
      h('button', { class: 'btn md', onclick: openSignIn }, session ? 'Finish signing in' : 'Sign in')));
    fill($('meAreas'));
    if (!profile) return;
    try {
      const [badges, board] = await Promise.all([
        sb.from('badges').select('badge_key, earned_at').eq('user_id', uid()).then(check),
        sb.rpc('leaderboard', { period: 'now' }).then(check),
        loadHomes(),
      ]);
      S.setServerBadges(new Map(badges.map((b) => [b.badge_key, b.earned_at])));
      S.renderBadges();
      // The server score also counts check-ins.
      const me = board.find((r) => r.user_id === uid());
      if (me) $('meScore').textContent = fmtPts(me.value);
      const KIND = { district: 'District', city: 'City', country: 'Country' };
      // Where you score most; nothing to choose, it follows your walking.
      fill($('meAreas'), homes.length ? h('div', { class: 'block' },
        h('span', { class: 'label' }, 'Where you walk most'),
        h('div', { class: 'list-card' }, homes.map((a) => h('div', { class: 'list-row' },
          h('span', { dir: 'auto' }, a.name || '?'),
          h('span', { class: 'row-val' }, a.rank ? `#${a.rank} of ${Number(a.total).toLocaleString()}` : KIND[a.kind]),
          a.rank ? h('span', { class: 'row-val accent' }, `top ${core.topPercent(a.rank, a.total)}%`) : null)))) : null);
    } catch (err) {
      // Offline: the local parts of the sheet are already there.
    }
  });

  document.addEventListener('scoop:settings-open', () => {
    fill($('settingsMapExtra'), profile ? h('button', {
      class: 'toggle-row', role: 'switch', 'aria-checked': String(communityOn),
      onclick: (e) => {
        communityOn = !communityOn;
        e.currentTarget.setAttribute('aria-checked', String(communityOn));
        drawCommunity();
      },
    }, h('span', {}, 'Community map', h('small', {}, 'How warm every hex is, whoever walked it. Tap one for how many explorers; friends’ names show.')),
    h('span', { class: 'switch' }, h('span'))) : null);

    if (!profile) {
      fill($('settingsAccount'), h('button', { class: 'btn outline', onclick: openSignIn }, session ? 'Finish signing in' : 'Sign in'));
      return;
    }
    const f = profileFields(profile);
    fill($('settingsAccount'), h('div', { class: 'stack' },
      h('form', {
        class: 'block',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            profile = check(await sb.from('profiles').update(readProfile(f)).eq('id', uid()).select(PROFILE_COLS).single());
            updateIdentity();
            toast('Profile saved');
            if (communityOn) { communityKey = ''; drawCommunity(); }
          } catch (err) {
            fail(profileError(err));
          }
        },
      },
      h('span', { class: 'label' }, 'Account'),
      profileForm(f),
      h('button', { class: 'btn outline', type: 'submit' }, 'Save profile')),
      h('div', { class: 'list-card' },
        h('button', { class: 'list-row', onclick: () => sync() },
          h('span', {}, 'Sync now'), h('span', { class: 'row-val', id: 'syncStatus' }, syncStatus), h('span', { class: 'chev' }, '›')),
        mod() ? h('button', { class: 'list-row', onclick: () => mod().blocked({ back: S.openSettings }) },
          h('span', {}, 'Blocked people'), h('span', { class: 'chev' }, '›')) : null,
        h('button', { class: 'list-row danger', onclick: deleteAccount }, h('span', {}, 'Delete account'))),
      h('button', {
        class: 'btn outline',
        onclick: async () => { await sb.auth.signOut(); S.closeSheet(); toast('Signed out · your map stays on this phone'); },
      }, 'Sign out')));
  });

  async function deleteAccount() {
    const choice = await confirmDialog({
      title: 'Delete your account?',
      body: 'This deletes your account, friends, check-ins and everything you uploaded. Your map on this phone stays. It can\'t be undone.',
      confirm: 'Delete account',
    });
    if (choice !== 'confirm') return;
    try {
      const files = check(await sb.storage.from(PHOTO_BUCKET).list(uid(), { limit: 1000 }));
      if (files.length) check(await sb.storage.from(PHOTO_BUCKET).remove(files.map((x) => `${uid()}/${x.name}`)));
      check(await sb.rpc('delete_my_account'));
      syncState = { uid: null, cells: {}, walks: [] };
      saveSync();
      await sb.auth.signOut();
      S.closeSheet();
      toast('Account deleted');
    } catch (err) {
      fail(err);
    }
  }

  // ---------- Friends sheet ----------

  const TABS = [['feed', 'Feed'], ['friends', 'Friends'], ['ranks', 'Ranks'], ['challenges', 'Challenges']];
  let tab = loadJSON(TAB_KEY, 'ranks');
  if (!TABS.some(([k]) => k === tab)) tab = 'ranks';
  $('btnSocial').addEventListener('click', () => {
    if (!profile) return openSignIn();
    renderSocial();
    S.openSheet('socialSheet');
  });

  /** Back from reporting or blocking someone: the Friends sheet as you left it. */
  const backToSocial = () => S.openSheet('socialSheet');

  function renderSocial() {
    if (!profile) return fill($('socialBody'));
    const panel = h('div', { class: 'stack' }, h('span', { class: 'fine' }, 'Loading…'));
    fill($('socialBody'), h('div', { class: 'stack' },
      sheetHead('Friends'),
      segmented(h('div', { class: 'seg tabs', 'aria-label': 'Friends sections' }), TABS, tab, (v) => {
        tab = v;
        saveJSON(TAB_KEY, tab);
        renderSocial();
      }),
      panel));
    const render = { feed: renderFeed, friends: renderFriends, ranks: renderRanks, challenges: renderChallenges }[tab];
    render(panel).catch((err) => {
      fill(panel, h('span', { class: 'body' }, navigator.onLine ? `Couldn't load: ${err.message}` : "You're offline. Your map still works."));
    });
  }

  // ---------- feed ----------

  async function photoUrls(paths) {
    if (!paths.length) return {};
    const rows = check(await sb.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600));
    return Object.fromEntries(rows.filter((r) => r.signedUrl).map((r) => [r.path, r.signedUrl]));
  }

  /** The key a reaction is stored under, for items other than walks. */
  const reactionKey = (i) => (i.type === 'checkin' ? String(i.id)
    : i.type === 'badge' ? `${i.user_id}:${i.badge_key}` : null);

  async function loadFeedPage(before) {
    const lim = 20;
    const [walks, checkins, badges, finds] = await Promise.all([
      sb.from('walks').select('id, user_id, started_at, km, new_cells, profiles!walks_user_id_fkey(username, display_name), kudos(user_id, emoji)')
        .lt('started_at', before).order('started_at', { ascending: false }).limit(lim),
      sb.from('checkins')
        .select('id, user_id, cell, kind, note, photo_path, met_with, created_at, author:profiles!checkins_user_id_fkey(username, display_name), met:profiles!checkins_met_with_fkey(username, display_name)')
        .lt('created_at', before).order('created_at', { ascending: false }).limit(lim),
      sb.from('badges').select('user_id, badge_key, earned_at, profiles(username, display_name)')
        .lt('earned_at', before).order('earned_at', { ascending: false }).limit(lim),
      // When your landmarks were found, never by whom (that would give away votes).
      sb.rpc('landmark_finds_feed', { before, lim }),
    ].map((q) => q.then(check)));
    const items = [
      ...walks.map((w) => ({ type: 'walk', at: w.started_at, ...w })),
      ...checkins.map((c) => ({ type: 'checkin', at: c.created_at, ...c })),
      ...badges.map((b) => ({ type: 'badge', at: b.earned_at, ...b })),
      ...finds.map((f) => ({ type: 'find', at: f.found_at, ...f, user_id: null, profiles: { display_name: 'Someone' } })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, lim);
    const [urls, reactions] = await Promise.all([
      photoUrls(items.filter((i) => i.photo_path).map((i) => i.photo_path)),
      loadReactions(items),
    ]);
    return { items, urls, reactions, more: walks.length === lim || checkins.length === lim || badges.length === lim || finds.length === lim };
  }

  /** Reactions on a page of check-ins and badges: "kind|key" → [{emoji, n, mine}]. */
  async function loadReactions(items) {
    const out = {};
    await Promise.all(['checkin', 'badge'].map(async (kind) => {
      const keys = items.filter((i) => i.type === kind).map(reactionKey);
      if (!keys.length) return;
      try {
        for (const r of check(await sb.rpc('reactions_for', { kind, items: keys }))) {
          (out[`${kind}|${r.item}`] = out[`${kind}|${r.item}`] || []).push({ emoji: r.emoji, n: Number(r.n), mine: r.mine });
        }
      } catch (err) {
        // Shown without counts.
      }
    }));
    return out;
  }

  /** The four kudos on a friend's check-in or badge. */
  function reactBar(item, rows) {
    const kind = item.type;
    const key = reactionKey(item);
    const own = item.user_id === uid();
    const bar = h('div', { class: 'kudos' });
    const draw = () => {
      const mine = rows.find((r) => r.mine);
      fill(bar, core.KUDOS.map((emoji) => {
        const r = rows.find((x) => x.emoji === emoji);
        return h('button', {
          class: 'chip', 'aria-pressed': String(!!mine && mine.emoji === emoji), disabled: own,
          title: own ? 'Kudos from friends show here' : 'Give kudos',
          onclick: async () => {
            const taking = mine && mine.emoji === emoji;
            try {
              check(await sb.rpc('react', { kind, item: key, emoji: taking ? null : emoji }));
              if (mine) { mine.n -= 1; mine.mine = false; }
              rows = rows.filter((x) => x.n > 0);
              if (!taking) {
                const x = rows.find((y) => y.emoji === emoji);
                if (x) { x.n += 1; x.mine = true; } else rows.push({ emoji, n: 1, mine: true });
              }
              draw();
            } catch (err) {
              fail(err);
            }
          },
        }, emoji, r && r.n ? ` ${r.n}` : '');
      }));
    };
    draw();
    return bar;
  }

  function kudosBar(w) {
    const bar = h('div', { class: 'kudos' });
    const draw = () => {
      const mine = w.kudos.find((k) => k.user_id === uid());
      fill(bar, core.KUDOS.map((emoji) => {
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

  function feedItem(item, urls, reactions = {}) {
    const who = item.type === 'checkin' ? item.author : item.profiles;
    const mine = item.user_id === uid();
    const name = mine ? 'You' : nameOf(who);
    const reacts = () => reactBar(item, reactions[`${item.type}|${reactionKey(item)}`] || []);
    let text;
    let extra = [];
    if (item.type === 'walk') {
      text = `walked ${fmtKm(item.km)} km` + (item.new_cells ? ` · ${item.new_cells} new hex${item.new_cells === 1 ? '' : 'es'}` : '');
      extra = [kudosBar(item)];
    } else if (item.type === 'badge') {
      const b = core.BADGES[item.badge_key] || { icon: '🏅', label: item.badge_key };
      text = `earned ${b.icon} ${b.label}`;
      extra = [reacts()];
    } else if (item.type === 'find') {
      text = `found your landmark ${(core.LANDMARK_KINDS[item.kind] || { icon: '⚑' }).icon}`;
      extra = [h('span', { class: 'feed-note', dir: 'auto' }, `“${item.title}”`)];
    } else {
      const kind = core.CHECKIN_KINDS[item.kind];
      text = item.kind === 'meetup'
        ? (item.met_with ? ['met up with ', h('bdi', {}, item.met ? nameOf(item.met) : 'a friend'), ' 🤝'] : 'is up for a meetup 🤝')
        : `checked in · ${kind.icon} ${kind.label.toLowerCase()}`;
      extra = [
        item.note ? h('span', { class: 'feed-note', dir: 'auto' }, item.note) : null,
        urls[item.photo_path] ? h('img', { class: 'feed-photo', src: urls[item.photo_path], alt: item.note || 'Check-in photo', loading: 'lazy' }) : null,
        h('button', { class: 'link', onclick: () => { S.closeSheet(); map.setView(h3.cellToLatLng(item.cell), 17); } }, 'Show on map'),
        reacts(),
      ];
    }
    return h('div', { class: 'feed-item' },
      avatar(nameOf(who), mine ? 'me' : ''),
      h('div', { class: 'feed-main' },
        h('span', { class: 'feed-text' }, h('b', {}, h('bdi', {}, name)), ' ', text),
        h('span', { class: 'feed-meta' }, h('span', {}, core.timeAgo(Date.parse(item.at)))),
        extra));
  }

  async function renderFeed(panel) {
    const list = h('div', { class: 'feed' });
    const more = h('button', { class: 'btn outline', hidden: true }, 'Load more');
    let before = new Date(Date.now() + 60000).toISOString();
    const load = async () => {
      more.disabled = true;
      const page = await loadFeedPage(before);
      for (const item of page.items) list.append(feedItem(item, page.urls, page.reactions));
      if (page.items.length) before = page.items[page.items.length - 1].at;
      more.hidden = !page.more;
      more.disabled = false;
      if (!list.children.length) {
        list.append(h('span', { class: 'body' }, 'Nothing here yet. Add friends in the Friends tab, then go for a walk!'));
      }
    };
    more.addEventListener('click', () => load().catch(fail));
    const [, top] = await Promise.all([load(), yourLandmarkCard()]);
    fill(panel, top, list, more);
  }

  /** Your most-found landmark, at the top of the feed: what it has done for you. */
  async function yourLandmarkCard() {
    let mine = [];
    try {
      mine = check(await sb.rpc('my_landmarks'));
    } catch (err) {
      return null;
    }
    const best = mine.filter((l) => !l.buried && !l.held).sort((a, b) => Number(b.finds) - Number(a.finds) || (a.created_at < b.created_at ? 1 : -1))[0];
    if (!best) return null;
    const finds = Number(best.finds) || 0;
    return h('div', { class: 'your-landmark' },
      h('span', { class: 'emoji', 'aria-hidden': 'true' }, (core.LANDMARK_KINDS[best.kind] || { icon: '⚑' }).icon),
      h('div', {},
        h('span', { class: 'kicker' }, best.welcome ? 'Your landmark · a welcome' : 'Your landmark'),
        h('b', { dir: 'auto' }, `“${best.title}”`),
        h('small', {}, [finds ? `Found by ${finds} explorer${finds === 1 ? '' : 's'}` : 'Not found yet',
          Number(best.ups) ? `👍 ${best.ups}` : null, `earned you ${fmtPts(best.points)} pts`].filter(Boolean).join(' · '))));
  }

  // ---------- friends, map overlay and compare ----------

  const DAY = 86400000;
  const RENEW_WINDOW_MS = 7 * DAY;  // keep in sync with renew_friendship()
  const LAPSE_GRACE_MS = 30 * DAY;

  /**
   * Friendship rows with the other person's profile. state: 'pending',
   * 'active', 'renew' (last 7 days), 'lapsed' (renewable for 30 days) or
   * 'gone' (lapsed too long ago).
   */
  async function loadFriends() {
    const rows = check(await sb.from('friendships')
      .select('requester, addressee, status, created_at, expires_at, requester_renewed, addressee_renewed'));
    const ids = rows.map((r) => (r.requester === uid() ? r.addressee : r.requester));
    const profiles = ids.length
      ? check(await sb.from('profiles').select(PROFILE_COLS).in('id', ids))
      : [];
    const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
    const now = Date.now();
    return rows.map((r) => {
      const mine = r.requester === uid();
      const otherId = mine ? r.addressee : r.requester;
      const expires = r.expires_at ? Date.parse(r.expires_at) : null;
      let state = 'pending';
      if (r.status === 'accepted') {
        if (expires > now + RENEW_WINDOW_MS) state = 'active';
        else if (expires > now) state = 'renew';
        else if (expires > now - LAPSE_GRACE_MS) state = 'lapsed';
        else state = 'gone';
      }
      return {
        ...r, state, expires,
        other: byId[otherId] || { id: otherId, username: '?' },
        incoming: r.addressee === uid(),
        iRenewed: mine ? r.requester_renewed : r.addressee_renewed,
        theyRenewed: mine ? r.addressee_renewed : r.requester_renewed,
      };
    });
  }

  const isFriend = (r) => r.state === 'active' || r.state === 'renew';
  const daysLeft = (ms) => Math.max(0, Math.ceil((ms - Date.now()) / DAY));

  async function renewFriend(r, after = renderSocial) {
    try {
      const [res] = check(await sb.rpc('renew_friendship', { other: r.other.id }));
      toast(res.renewed ? `Renewed · friends with ${nameOf(r.other)} for 30 more days`
        : `Renewed on your side · waiting for ${nameOf(r.other)}`, 4000);
      after();
    } catch (err) {
      fail(err);
    }
  }

  /** Renewal chip: "21 days left", "Renew · 5 days left", "Waiting for them", "Renew — they did". */
  function renewal(r, after = renderSocial) {
    if (r.state === 'active') {
      return h('span', { class: 'chip status ok', role: 'note' }, `${daysLeft(r.expires)} days left`);
    }
    if (r.iRenewed) return h('span', { class: 'chip status quiet', role: 'note' }, 'Waiting for them');
    return h('button', { class: 'chip status warn', onclick: () => renewFriend(r, after) },
      r.theyRenewed ? 'Renew — they did' : r.state === 'lapsed' ? 'Renew' : `Renew · ${daysLeft(r.expires)} days left`);
  }

  /** "Bring someone into Zamalek": a code for one person, carrying your welcome landmark. */
  async function bringSomeoneIn() {
    // Look without making one: a code only exists once you share it.
    let inv = null;
    try {
      [inv] = check(await sb.rpc('new_invite', { make: false }));
    } catch (err) {
      // Offline: the rest of the tab still works.
    }
    const where = hoodName() || 'your neighbourhood';
    const codeEl = h('span', { class: inv && inv.code ? 'code' : 'code none' }, inv && inv.code ? inv.code : 'Made when you share');
    const shared = h('div', { class: 'note-row', hidden: true },
      h('span', { class: 'dot friend pulse' }), h('span', {}, "Code shared. We'll tell you when they join."));
    const share = h('button', {
      class: 'btn sm',
      onclick: async () => {
        try {
          if (!inv.code) {
            share.disabled = true;
            try {
              [inv] = check(await sb.rpc('new_invite', { make: true }));
            } finally {
              share.disabled = false;
            }
            codeEl.textContent = inv.code;
            codeEl.className = 'code';
          }
          await shareText('Walk with me on Scoop', `Come and walk ${where} with me on Scoop. My code: ${inv.code}`, `${PUBLIC_URL}?invite=${inv.code}`);
          share.textContent = '✓ Shared';
          shared.hidden = false;
        } catch (err) {
          if (!cancelled(err)) fail(err);
        }
      },
    }, 'Share');
    const lm = inv && inv.landmark_title ? (core.LANDMARK_KINDS[inv.landmark_kind] || { icon: '⚑' }).icon : null;
    return h('div', { class: 'stack tight' },
      h('div', { class: 'bring' },
        h('div', { class: 'bring-head' },
          h('b', { dir: 'auto' }, `Bring someone into ${where}`),
          h('small', {}, lm ? "They'll arrive with a welcome from you" : 'Leave a welcome landmark and they’ll be pointed to it first')),
        lm ? h('div', { class: 'bring-lm' }, h('span', { 'aria-hidden': 'true' }, lm),
          h('span', { dir: 'auto' }, `“${inv.landmark_title}” will be the first landmark they're pointed to.`)) : null,
        h('div', { class: 'invite' },
          h('div', {}, h('small', {}, 'Your code'), inv ? codeEl : h('span', { class: 'code' }, '—')),
          inv ? share : null)),
      shared,
      h('span', { class: 'fine' }, 'A code works for one person and expires after 7 days. Scoop never reads your contacts.'));
  }

  // Tell you when someone used your code.
  const INVITES_SEEN_KEY = 'scoop.invitesSeen.v1';
  async function checkInvitesUsed() {
    if (!profile) return;
    try {
      const rows = check(await sb.rpc('my_invites')).filter((r) => r.used_at);
      const seen = new Set(loadJSON(INVITES_SEEN_KEY, []));
      const fresh = rows.filter((r) => !seen.has(r.code));
      if (fresh.length) toast(`${core.nameList(fresh.map((r) => r.used_by_name || 'Someone'))} joined with your code`, 4000);
      saveJSON(INVITES_SEEN_KEY, rows.map((r) => r.code));
    } catch (err) {
      // Next time.
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkInvitesUsed(); });

  async function renderFriends(panel) {
    const [rows, bring, stats] = await Promise.all([
      loadFriends(), bringSomeoneIn(), sb.rpc('friend_stats').then(check),
    ]);
    checkInvitesUsed();
    const statsById = Object.fromEntries(stats.map((x) => [x.user_id, x]));
    const friends = rows.filter(isFriend).sort((a, b) => a.expires - b.expires);
    const lapsed = rows.filter((r) => r.state === 'lapsed');
    const incoming = rows.filter((r) => r.state === 'pending' && r.incoming);
    const outgoing = rows.filter((r) => r.state === 'pending' && !r.incoming);
    const codeInput = h('input', { class: 'input', placeholder: "Friend's invite code or link", autocapitalize: 'characters', 'aria-label': "Friend's invite code" });

    const removeFriend = async (r) => {
      const choice = await confirmDialog({
        title: `Remove ${nameOf(r.other)}?`,
        body: `You'll stop seeing each other's maps, walks and check-ins. You can add each other again with an invite code.`,
        confirm: 'Remove friend',
      });
      if (choice !== 'confirm') return;
      try {
        check(await sb.from('friendships').delete().eq('requester', r.requester).eq('addressee', r.addressee));
        if (overlay && overlay.friend.id === r.other.id) clearFriendOverlay();
        renderSocial();
      } catch (err) {
        fail(err);
      }
    };

    const friendRow = (r) => {
      const p = r.other;
      const st = statsById[p.id];
      const showing = overlay && overlay.friend.id === p.id;
      return h('div', { class: 'person' },
        h('div', { class: 'person-main' },
          avatar(nameOf(p)),
          h('div', { class: 'person-who' },
            h('span', { dir: 'auto' }, nameOf(p)),
            h('small', {}, st ? [st.district_name, `${fmtPts(st.week)} pts this week`].filter(Boolean).join(' · ') : `@${p.username}`)),
          h('div', { class: 'person-end' },
            st ? h('span', { class: 'score' }, fmtPts(st.score)) : null,
            mod()
              ? mod().moreBtn({ id: p.id, name: nameOf(p) },
                { back: backToSocial, changed: renderSocial, remove: ['Remove friend', () => removeFriend(r)] })
              : h('button', { class: 'link danger', 'aria-label': `Remove ${nameOf(p)}`, onclick: () => removeFriend(r) }, 'Remove'))),
        h('div', { class: 'person-actions' },
          h('button', {
            class: 'chip', 'aria-pressed': String(!!showing),
            onclick: () => (showing ? clearFriendOverlay() : showFriendOverlay(p)).catch(fail),
          }, showing ? 'Hide map' : 'Compare maps'),
          renewal(r)));
    };

    const respond = (r, accept) => async () => {
      try {
        check(await sb.rpc('respond_friend_request', { other: r.other.id, accept }));
        renderSocial();
      } catch (err) {
        fail(err);
      }
    };

    const me = statsById[uid()];
    fill(panel,
      bring,
      h('form', {
        class: 'inline-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const c = core.parseInvite(codeInput.value);
          if (!c) return toast("That doesn't look like an invite code");
          try {
            await useInvite(c);
            renderSocial();
          } catch (err) {
            fail(err);
          }
        },
      }, codeInput, h('button', { class: 'btn sm', type: 'submit' }, 'Add')),
      incoming.length ? h('div', { class: 'block' },
        h('span', { class: 'label' }, 'Requests'),
        h('div', { class: 'people' }, incoming.map((r) => h('div', { class: 'person' },
          h('div', { class: 'person-main' }, avatar(nameOf(r.other)),
            h('div', { class: 'person-who' }, h('span', { dir: 'auto' }, nameOf(r.other)), h('small', {}, `@${r.other.username}`))),
          h('div', { class: 'person-actions' },
            h('button', { class: 'chip status ok', onclick: respond(r, true) }, 'Accept'),
            h('button', { class: 'link', onclick: respond(r, false) }, 'Decline'),
            mod() ? mod().moreBtn({ id: r.other.id, name: nameOf(r.other) }, { back: backToSocial, changed: renderSocial }) : null))))) : null,
      h('div', { class: 'block' },
        h('span', { class: 'label' }, `Friends · ${friends.length}`),
        friends.length
          ? h('div', { class: 'people' }, friends.map(friendRow))
          : h('span', { class: 'body' }, 'No friends yet. Share your invite code to walk together.')),
      outgoing.length ? h('span', { class: 'fine' }, `Waiting on: ${outgoing.map((r) => nameOf(r.other)).join(', ')}`) : null,
      lapsed.length ? h('div', { class: 'block' },
        h('span', { class: 'label' }, 'Lapsed'),
        h('div', { class: 'people' }, lapsed.map((r) => h('div', { class: 'person' },
          h('div', { class: 'person-main' }, avatar(nameOf(r.other)),
            h('div', { class: 'person-who' }, h('span', { dir: 'auto' }, nameOf(r.other)),
              h('small', {}, `Renewable for ${daysLeft(r.expires + LAPSE_GRACE_MS)} more days`))),
          h('div', { class: 'person-actions' }, renewal(r)))))) : null,
      h('span', { class: 'fine' }, 'Friendships last 30 days. In the last week you both tap Renew to keep going — it only renews once you both have. ' +
        'Friends see your map, walks, check-ins, scores and the district you walk most' + (me && me.district_name ? ` (${me.district_name})` : '') + '.'));
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
    const theirs = overlay.cells;
    const bounds = map.getBounds().pad(0.5);
    const draw = [...theirs].filter((c) => bounds.contains(h3.cellToLatLng(c)));
    if (draw.length) {
      // Inset outlines, so your heat colours still show inside their hexes.
      const inset = (c) => {
        const [clat, clng] = h3.cellToLatLng(c);
        return [h3.cellToBoundary(c).map(([lat, lng]) => [clat + (lat - clat) * 0.86, clng + (lng - clng) * 0.86])];
      };
      L.polygon(draw.map(inset), {
        pane: 'friends', color: S.COLORS.friend, weight: 2.4, opacity: 1,
        fillColor: S.COLORS.friend, fillOpacity: 0.14, interactive: false,
      }).addTo(friendLayer);
    }
    const mine = new Set([...myDisplay.keys()].filter((c) => !isHidden(c)));
    const cmp = core.compare(mine, theirs);
    const them = nameOf(overlay.friend);
    $('compareAvatar').textContent = initialOf(them);
    $('compareTitle').textContent = `You & ${them}`;
    fill($('compareLegend'),
      h('span', {}, h('span', { class: 'key shared' }), h('b', {}, cmp.both.toLocaleString()), 'shared'),
      h('span', {}, h('span', { class: 'key mine' }), h('b', {}, cmp.onlyMine.toLocaleString()), 'only you'),
      h('span', {}, h('span', { class: 'key theirs' }), h('b', {}, cmp.onlyTheirs.toLocaleString()), h('span', { dir: 'auto' }, `only ${them}`)));
    $('compareBar').hidden = false;
    document.body.classList.add('comparing');
  }

  // ---------- community map ----------

  map.createPane('community').style.zIndex = '402';
  const communityLayer = L.layerGroup([], { pane: 'community' }).addTo(map);
  let communityOn = false;
  let communityKey = '';
  /** @type {Map<string, {heat:number, explorers:number, mine:boolean, first_username:string|null}>} */
  let communityCells = new Map();
  let communityTimer = null;
  let communitySeq = 0;
  let communityTooWide = false;
  // community_heat() takes at most 60 blocks (~0.7 km² each) a call. A desktop
  // window at street zoom covers more, so ask in chunks, up to a screenful.
  const COMMUNITY_CHUNK = 60;
  const COMMUNITY_MAX_BLOCKS = 240;

  function drawCommunity() {
    clearTimeout(communityTimer);
    if (!communityOn) {
      communityLayer.clearLayers();
      communityKey = '';
      return;
    }
    communityTimer = setTimeout(async () => {
      if (map.getZoom() < 14) {
        communityLayer.clearLayers();
        communityKey = '';
        return;
      }
      const b = map.getBounds().pad(0.2);
      let cells8 = [];
      try {
        cells8 = core.boxCells(h3, b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), 8);
      } catch (e) {
        return;
      }
      if (!cells8.length) return;
      if (cells8.length > COMMUNITY_MAX_BLOCKS) {
        communityLayer.clearLayers();
        communityKey = '';
        if (!communityTooWide) { communityTooWide = true; toast('Zoom in to see everyone’s hexes'); }
        return;
      }
      communityTooWide = false;
      const key = cells8.sort().join();
      if (key === communityKey) return;
      communityKey = key;
      const seq = ++communitySeq;
      try {
        // Every hex anyone walked, as warm as the district number counts it.
        const chunks = [];
        for (let i = 0; i < cells8.length; i += COMMUNITY_CHUNK) chunks.push(cells8.slice(i, i + COMMUNITY_CHUNK));
        const rows = (await Promise.all(chunks.map((c) => sb.rpc('community_heat', { cells8: c }).then(check))))
          .flat().filter((r) => r.heat >= 0.03);
        if (seq !== communitySeq) return; // the map moved on while this was loading
        communityCells = new Map(rows.map((r) => [r.cell, r]));
        communityLayer.clearLayers();
        for (const r of rows) {
          const band = S.COMMUNITY_BANDS.find((x) => r.heat >= x.min) || S.COMMUNITY_BANDS[S.COMMUNITY_BANDS.length - 1];
          L.polygon(h3.cellToBoundary(r.cell), {
            pane: 'community', stroke: false, interactive: false,
            fillColor: band.color, fillOpacity: band.fill,
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
    const r = communityCells.get(h3.latLngToCell(e.latlng.lat, e.latlng.lng, S.BASE_RES));
    if (!r) return;
    L.popup().setLatLng(e.latlng).setContent(h('div', {},
      h('b', {}, `${Math.round(r.heat * 100)}% warm`), h('br'),
      `${r.explorers} explorer${r.explorers === 1 ? '' : 's'}`,
      r.first_username ? h('span', {}, h('br'), `First here: ${r.first_username}`) : null)).openOn(map);
  });

  document.addEventListener('scoop:render', (e) => {
    drawFriendOverlay(e.detail.display);
    drawCommunity();
  });

  // ---------- leaderboards ----------

  const rankPrefs = Object.assign({ scope: 'friends', period: 'now' }, loadJSON('scoop.ranks.v2', {}));
  const PERIODS = [['now', 'Now'], ['week', 'This week'], ['month', 'This month']];
  const PERIOD_SUB = { now: 'Score right now', week: 'Points earned this week', month: 'Points earned this month' };
  const KIND_LABEL = { district: 'District', city: 'City', country: 'Country' };

  function rankRow(r, { me, friend, name, sub }) {
    return h('div', { class: `rank-row${me ? ' me' : friend ? ' friend' : name ? '' : ' stranger'}` },
      h('span', { class: 'pos' }, String(r.rank)),
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'who' }, h('span', { dir: 'auto' }, name || 'Explorer'), sub ? h('small', {}, sub) : null),
      h('span', { class: 'val' }, fmtPts(r.value)));
  }

  async function renderRanks(panel) {
    const areas = check(await sb.rpc('my_areas', { period: rankPrefs.period }));
    const scopes = [['friends', 'Friends'], ...areas.map((a) => [a.kind, `${KIND_LABEL[a.kind]} · ${a.name || '?'}`]), ['everyone', 'Everyone']];
    if (!scopes.some(([v]) => v === rankPrefs.scope)) rankPrefs.scope = 'friends';
    const savePrefs = () => { saveJSON('scoop.ranks.v2', rankPrefs); renderSocial(); };
    const controls = [
      h('div', { class: 'chips' }, scopes.map(([v, label]) => h('button', {
        class: 'chip', 'aria-pressed': String(rankPrefs.scope === v),
        onclick: () => { rankPrefs.scope = v; savePrefs(); },
      }, label))),
      segmented(h('div', { class: 'seg sm', 'aria-label': 'Period' }), PERIODS, rankPrefs.period,
        (v) => { rankPrefs.period = v; savePrefs(); }),
    ];
    const myName = `${nameOf(profile)} (you)`;

    if (rankPrefs.scope === 'friends') {
      const rows = check(await sb.rpc('leaderboard', { period: rankPrefs.period }));
      const mine = rows.find((r) => r.user_id === uid());
      fill(panel, controls,
        h('div', { class: 'panel tint sm' },
          h('span', { class: 'standing' }, mine && rows.length > 1 ? `You're #${mine.rank} of ${rows.length} friends` : 'Just you so far'),
          h('span', { class: 'sub' }, PERIOD_SUB[rankPrefs.period])),
        h('div', { class: 'rank-list' }, rows.map((r) => {
          const me = r.user_id === uid();
          return rankRow(r, { me, friend: !me, name: me ? myName : nameOf(r) });
        })),
        rows.length < 2 ? h('span', { class: 'body' }, 'Add friends in the Friends tab to compete with them, or tap Everyone to see all explorers.') : null,
        h('span', { class: 'fine' }, 'Points fade as hexes cool, so the board always reflects recent walking. ' +
          'Check-ins add points too: photo 3, coffee or food 2, meeting a friend 5. ' +
          'Landmarks: leave one 3, find one 2, +1 each time yours is found or gets a 👍.'));
      return;
    }

    // Everyone: all explorers wherever they walk (area null on the server).
    const everyone = rankPrefs.scope === 'everyone';
    const home = everyone ? { id: null, kind: 'everyone' } : areas.find((a) => a.kind === rankPrefs.scope);
    const [rows, extras] = await Promise.all([
      sb.rpc('area_leaderboard', { area: home.id, period: rankPrefs.period }).then(check),
      home.kind === 'district' ? districtExtras(home) : [],
    ]);
    const mine = rows.find((r) => r.is_me);
    const total = rows.length ? rows[0].total : 0;
    const where = everyone ? '' : ` in ${home.name}`;
    fill(panel, controls, extras,
      h('div', { class: 'panel tint sm' },
        h('span', { class: 'standing', dir: 'auto' }, mine
          ? `You're #${mine.rank} of ${Number(total).toLocaleString()}${everyone ? ' explorers' : where}`
          : `No points${where} yet`),
        h('span', { class: 'sub' }, mine
          ? `Top ${core.topPercent(mine.rank, total)}%` + (home.kind === 'district' ? ' · where you walk most' : '')
          : PERIOD_SUB[rankPrefs.period])),
      h('div', { class: 'rank-list' }, rows.map((r, i) => [
        i > 0 && r.rank > rows[i - 1].rank + 1 ? h('div', { class: 'rank-gap', 'aria-hidden': 'true' }, '…') : null,
        rankRow(r, { me: r.is_me, friend: r.is_friend, name: r.is_me ? myName : r.username ? nameOf(r) : null }),
      ])),
      h('span', { class: 'fine' }, 'Points fade over 30 days, so ranks show who’s walking lately and anyone can climb. Non-friends always appear as “Explorer”.'));
  }

  /**
   * In your district's ranks: how your circle does against the district's
   * circles (by km together, never members' points), and how close you are
   * to becoming a local.
   */
  async function districtExtras(home) {
    const out = [];
    const circle = window.scoopCircles ? window.scoopCircles.circles.find((c) => c.district === home.id) : null;
    const [standing, firsts] = await Promise.all([
      circle ? sb.rpc('circle_standing', { circle: circle.id }).then(check).then((r) => r[0]).catch(() => null) : null,
      loadFirsts().catch(() => null),
    ]);
    if (circle && standing && Number(standing.total) > 1) {
      out.push(h('button', { class: 'rank-card friend', onclick: () => window.scoopCircles.openIntro() },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, '🤝'),
        h('div', {}, h('b', { dir: 'auto' }, `Circles in ${home.name}`),
          h('small', { dir: 'auto' }, `${circle.name} is #${standing.rank} of ${standing.total} this week`)),
        h('span', { class: 'big-pos' }, `#${standing.rank}`)));
    }
    const next = firsts ? core.nextFirst(firsts) : null;
    if (next) {
      const done = core.firstsDone(firsts);
      const left = core.FIRSTS.length - done;
      out.push(h('button', { class: 'rank-card', onclick: openFirsts },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, '🏠'),
        h('div', {}, h('span', { dir: 'auto' }, left === 1
          ? ['One more first from becoming a ', h('b', {}, `${home.name} local`)]
          : [`${left} firsts from becoming a `, h('b', {}, `${home.name} local`)])),
        h('span', { class: 'big-pos' }, `${done}/${core.FIRSTS.length}`)));
    }
    return out;
  }

  // ---------- challenges ----------

  // Always shared, never solo: your district against its rival this week,
  // your circle's weekly goal, becoming a local, and the district's open
  // challenges (added by an admin with add_area_challenge()).

  const daysLeft2 = (ms) => Math.max(0, Math.ceil((ms - Date.now()) / DAY));
  const bar = (pct, cls = '') => h('div', { class: `progress ${cls}`, role: 'img', 'aria-label': `${Math.round(pct)}%` },
    h('div', { class: 'progress-fill', style: `width:${Math.max(0, Math.min(100, pct))}%` }));

  async function renderChallenges(panel) {
    const homeD = homes.find((a) => a.kind === 'district');
    const district = homeD ? { id: homeD.id, name: homeD.name } : hood.id ? { id: hood.id, name: hood.name } : null;
    if (!district) {
      fill(panel, h('span', { class: 'body' }, 'Walk a few hexes in a district and its challenges show up here.'));
      return;
    }
    const circles = window.scoopCircles ? window.scoopCircles.circles : [];
    const [mu, open, firsts] = await Promise.all([
      sb.rpc('district_matchup', { district: district.id }).then(check).then((r) => r[0]),
      sb.rpc('area_challenges_for', { district: district.id }).then(check),
      loadFirsts().catch(() => null),
    ]);
    const here = circles.find((c) => c.district === district.id);
    const ends = Date.parse(mu.ends_at);
    const matchup = h('div', { class: 'chal-hero' },
      h('div', { class: 'top' }, h('span', { class: 'label' }, 'This week · neighbourhoods'),
        h('span', { class: 'sub' }, `${daysLeft2(ends)} day${daysLeft2(ends) === 1 ? '' : 's'} left`)),
      h('span', { class: 'panel-title', dir: 'auto' }, mu.rival ? `${district.name} vs ${mu.rival_name || 'a neighbour'}` : `${district.name} · ${core.WARMTH_GOAL}% by Sunday`),
      h('div', { class: 'vs' },
        h('div', { class: 'vs-row mine' }, h('span', { dir: 'auto' }, district.name), bar(mu.pct), h('b', {}, `${mu.pct}%`)),
        mu.rival ? h('div', { class: 'vs-row' }, h('span', { dir: 'auto' }, mu.rival_name || 'Rival'), bar(mu.rival_pct, 'quiet'), h('b', {}, `${mu.rival_pct}%`)) : null),
      h('span', { class: 'sub' }, [
        mu.rival ? 'Warmest on Sunday night wins the week.' : 'No district in your city to race this week, so it’s a goal instead.',
        here ? `${here.name} walked ${Math.round(here.week_km * 10) / 10} km together this week.` : null,
      ].filter(Boolean).join(' ')));
    const circleGoals = circles.map((c) => h('div', { class: 'chal-goal' },
      h('div', { class: 'top' }, h('b', { dir: 'auto' }, `${c.name} · ${c.goal_km} km together`), h('span', {}, `${Math.round(c.week_km * 10) / 10} km`)),
      bar((c.week_km / c.goal_km) * 100, 'friend'),
      h('span', { class: 'sub' }, `${c.next ? `Next walk ${new Date(c.next.starts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'No walk booked'} · resets Monday`)));
    const next = firsts ? core.nextFirst(firsts) : null;
    const local = next ? h('button', { class: 'rank-card', onclick: openFirsts },
      h('span', { class: 'big-pos' }, `${core.firstsDone(firsts)}/${core.FIRSTS.length}`),
      h('div', {}, h('b', { dir: 'auto' }, `Become a ${district.name} local`),
        h('small', {}, `Your goal · ${core.FIRSTS.length - core.firstsDone(firsts)} first${core.FIRSTS.length - core.firstsDone(firsts) === 1 ? '' : 's'} to go`))) : null;
    const openList = h('div', { class: 'stack tight' },
      h('span', { class: 'label' }, `Open to everyone in ${district.name}`),
      open.length ? open.map((c) => {
        const btn = h('button', {
          class: c.joined ? 'chip status ok' : 'btn sm',
          onclick: async () => {
            try {
              check(await sb.rpc('join_area_challenge', { challenge: c.id, join_it: !c.joined }));
              renderSocial();
            } catch (err) {
              fail(err);
            }
          },
        }, c.joined ? '✓ Joined' : 'Join');
        return h('div', { class: 'open-chal' },
          h('div', { class: 'top' },
            h('div', {}, h('b', { dir: 'auto' }, c.title),
              h('small', { dir: 'auto' }, [c.detail, `${c.members} explorer${Number(c.members) === 1 ? '' : 's'}`,
                c.ends_at ? `ends ${new Date(c.ends_at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : 'no end date']
                .filter(Boolean).join(' · '))),
            btn),
          bar(Number(c.progress) * 100));
      }) : h('span', { class: 'body' }, `No open challenges in ${district.name} right now.`));
    fill(panel, matchup, circleGoals, local, openList,
      h('span', { class: 'fine' }, 'Challenges are always shared, never solo. Missing a week costs nothing.'));
  }

  // ---------- check-ins ----------

  // Close up, each check-in gets its own pin. Zoomed out, pins would cover the
  // street hexes, so check-ins are grouped into one small count per block.
  const PIN_ZOOM = 16;
  const BUBBLE_ZOOM = 13;
  const checkinLayer = L.layerGroup();
  const bubbleLayer = L.layerGroup();

  async function loadCheckinMarkers() {
    if (!profile) return;
    try {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const rows = check(await sb.from('checkins')
        .select('id, user_id, cell, kind, note, met_with, created_at, author:profiles!checkins_user_id_fkey(username, display_name)')
        .gte('created_at', since).order('created_at', { ascending: false }).limit(300));
      checkinLayer.clearLayers();
      bubbleLayer.clearLayers();
      const blocks = new Map();
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
        const block = h3.cellToParent(r.cell, 9);
        const b = blocks.get(block) || { n: 0, mine: false };
        b.n++;
        b.mine = b.mine || r.user_id === uid();
        blocks.set(block, b);
      }
      for (const [block, b] of blocks) {
        const at = h3.cellToLatLng(block);
        L.marker(at, {
          icon: L.divIcon({ className: `checkin-bubble${b.mine ? ' mine' : ''}`, html: String(b.n), iconSize: [20, 20] }),
          title: `${b.n} check-in${b.n === 1 ? '' : 's'} — tap to zoom in`,
        }).on('click', () => map.setView(at, PIN_ZOOM)).addTo(bubbleLayer);
      }
      toggleCheckinMarkers();
    } catch (err) {
      // Markers are a nice-to-have; don't nag when offline.
    }
  }

  function toggleCheckinMarkers() {
    const z = map.getZoom();
    const show = (layer, on) => {
      if (on && !map.hasLayer(layer)) layer.addTo(map);
      if (!on && map.hasLayer(layer)) map.removeLayer(layer);
    };
    show(checkinLayer, z >= PIN_ZOOM);
    show(bubbleLayer, z >= BUBBLE_ZOOM && z < PIN_ZOOM);
  }
  map.on('zoomend', toggleCheckinMarkers);

  let checkinKind = null;

  function hereCell() {
    const pos = S.position();
    return pos ? h3.latLngToCell(pos.latlng.lat, pos.latlng.lng, S.BASE_RES) : null;
  }

  $('btnCheckin').addEventListener('click', () => {
    checkinKind = null;
    renderCheckin();
    S.openSheet('checkinSheet');
  });

  /** One pattern for every reason you can't check in: glyph, title, why, one action and "Not now". */
  function blocked(glyph, title, body, action, onAction, target = 'checkinBody') {
    fill($(target), h('div', { class: 'stack' },
      h('div', { class: 'blocked' },
        h('div', { class: 'hex-badge quiet', 'aria-hidden': 'true' }, glyph),
        h('span', { class: 'card-title' }, title),
        h('span', { class: 'body' }, body)),
      h('div', { class: 'onb-actions' },
        h('button', { class: 'btn', onclick: onAction }, action),
        action === 'OK' ? null : h('button', { class: 'btn ghost', 'data-close': true }, 'Not now'))));
  }

  async function renderCheckin() {
    const cell = hereCell();
    if (!cell) {
      return blocked('⌖', 'Finding you…', 'We need your location to check in. Outdoors it usually takes a few seconds.', 'Locate me', () => {
        S.closeSheet();
        S.locate();
      });
    }
    if (!S.visited.has(cell)) {
      return S.walking()
        ? blocked('?', 'Not counted yet', "Check-ins go on hexes you've walked, and this one counts once you're well inside it. Keep going and try again in a moment.",
          'OK', S.closeSheet)
        : blocked('?', 'Walk this hex first', "Check-ins go on hexes you've walked. This one is still unexplored — walk through it and try again.",
          'Start walk', () => S.startWalk());
    }
    if (isHidden(cell)) {
      return blocked('◌', "You're in a privacy zone", 'Nothing inside your privacy zones is shared, so check-ins are off here.', 'Manage zones', () => {
        renderZoneList();
        S.openSheet('zonesSheet');
      });
    }
    fill($('checkinBody'), h('span', { class: 'fine' }, 'Loading…'));
    // One check-in of each kind per hex per (UTC) day.
    let doneToday = new Map();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rows = check(await sb.from('checkins').select('kind, created_at').eq('user_id', uid()).eq('cell', cell).eq('day', today));
      doneToday = new Map(rows.map((r) => [r.kind, r.created_at]));
    } catch (err) {
      // Offline: the server still refuses duplicates.
    }
    const kinds = Object.entries(core.CHECKIN_KINDS);
    if (doneToday.size >= kinds.length) {
      return blocked('☕', 'Already checked in today', "You've checked in every way here today. Come back tomorrow for more points.", 'OK', S.closeSheet);
    }
    if (checkinKind && doneToday.has(checkinKind)) checkinKind = null;

    const area = Areas ? Areas.of(cell) : null;
    const district = area && area.district ? (Areas.info(area.district) || {}).name : null;
    const ago = core.timeAgo(S.lastSeen.get(cell) || S.visited.get(cell));
    const walkedAgo = /ago|now/.test(ago) ? ago : `on ${ago}`;
    let file = null;
    const note = h('input', { class: 'input note', placeholder: 'Add a note (optional)', maxlength: '140', dir: 'auto', 'aria-label': 'Note' });
    const submit = h('button', { class: 'btn', type: 'submit', disabled: true }, 'Check in');
    const photoInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': 'Add a photo' });
    const photoSlot = h('label', { class: 'photo-slot' });
    const kindGrid = h('div', { class: 'kinds', role: 'radiogroup', 'aria-label': 'Kind of check-in' });
    const POINTS_NOTE = { photo: '+3 · photo needed', coffee: '+2 pts', food: '+2 pts', meetup: '+5 with a friend' };
    const meetupNote = h('span', { class: 'fine' }, 'The meetup counts once a friend checks in at this hex within 30 minutes.');

    const valid = () => !!checkinKind && (checkinKind !== 'photo' || !!file);
    const draw = () => {
      fill(kindGrid, kinds.map(([key, k]) => h('button', {
        type: 'button', class: 'kind', role: 'radio', 'aria-checked': String(key === checkinKind), disabled: doneToday.has(key),
        onclick: () => { checkinKind = key; draw(); },
      }, h('span', { class: 'emoji', 'aria-hidden': 'true' }, k.icon), h('b', {}, k.label),
      h('small', {}, doneToday.has(key) ? 'Done today' : POINTS_NOTE[key]))));
      photoSlot.hidden = checkinKind !== 'photo';
      photoSlot.classList.toggle('has', !!file);
      fill(photoSlot, h('b', {}, file ? 'Photo added' : 'Add a photo'),
        h('span', {}, file ? file.name : 'Required for a photo check-in'), photoInput);
      meetupNote.hidden = checkinKind !== 'meetup';
      submit.textContent = checkinKind === 'meetup' ? 'Check in for a meetup' : 'Check in';
      submit.disabled = !valid();
    };
    photoInput.addEventListener('change', () => { file = photoInput.files[0] || null; draw(); });

    fill($('checkinBody'), h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!valid()) return;
        submit.disabled = true;
        try {
          await sync(); // the server only accepts check-ins in hexes it knows you walked
          let photoPath = null;
          if (file && checkinKind === 'photo') {
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
          const checkMsg = checkinKind !== 'meetup' ? `${k.icon} Checked in · +${k.points} pts`
            : row.met_with ? '🤝 Meetup verified · +5 pts' : '🤝 Checked in · waiting for a friend to check in here';
          const earned = checkinKind !== 'meetup' ? k.points : row.met_with ? 5 : 0;
          if (earned) smallWin(earned);
          celebrateFirsts(checkMsg.replace(/^\S+ /, '')).then((shown) => { if (!shown) toast(checkMsg); });
          loadCheckinMarkers();
        } catch (err) {
          fail(err.code === '23505' ? new Error('You already checked in like that here today') : err);
          submit.disabled = !valid();
        }
      },
    },
    h('div', { class: 'stack tight', style: 'gap:2px' },
      h('span', { class: 'sheet-title' }, 'Check in here'),
      h('span', { class: 'me-sub' }, [district, `a hex you walked ${walkedAgo}`].filter(Boolean).join(' · '))),
    kindGrid,
    photoSlot,
    note,
    meetupNote,
    submit));
    draw();
  }

  /** Downscale to at most 1280 px and re-encode as JPEG (also strips EXIF location). */
  async function compressPhoto(file) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  }

  // ---------- landmarks ----------

  // Explorers leave landmarks on hexes they've walked: a viewpoint, a bit of
  // history, street art… When you pass through a hex with someone else's
  // landmark, the app tells you (a banner, and a notification in the Android
  // app when the screen is off) and you can check it off. The author sees how
  // many explorers found it. Only you and your friends see who left one.
  const LANDMARK_BLOCK_RES = 7;             // fetch the ~5 km² block you're in and the ring around it
  const LANDMARK_REFRESH_MS = 10 * 60000;
  const LANDMARK_RETRY_MS = 60000;
  const LANDMARK_MAX_ACCURACY = 35;         // metres: a vaguer fix could be the hex next door
  const LANDMARK_FIX_MAX_AGE_MS = 2 * 60000; // leaving one needs a recent fix: you may have moved on
  const LANDMARK_ALERT_HIDE_MS = 10 * 60000;
  const LANDMARK_CHECK_WINDOW_MS = 30 * 60000; // after being told, you can still check it off from afar
  const LANDMARK_ZOOM = 15;
  const LANDMARK_LIMIT = 25;                // keep in sync with landmark_limit() in the migration
  const LANDMARK_PER_HEX_LIMIT = 3;         // keep in sync with landmark_per_hex_limit()
  const LANDMARK_ALERTS_KEY = 'scoop.landmarkAlerts.v1';
  const Notifier = S.WalkReminder;          // the Android app's own plugin also posts landmark notifications

  /** @type {Map<string, object[]>} cell → landmarks there */
  let landmarksByCell = new Map();
  /** @type {Map<number, object>} */
  let landmarksById = new Map();
  let landmarkBlocks = new Set();
  let landmarksLoadedAt = 0;
  let landmarksLoading = false;
  let landmarkAlerts = core.pruneAlerted(loadJSON(LANDMARK_ALERTS_KEY, {}));
  let alertedLandmark = null;
  let landmarkAlertTimer = null;
  /** The neighbourhood around you, from area_pulse() (see "belonging" below). */
  let pulse = null;
  /** Your neighbourhood firsts, once worked out (see "belonging" below). */
  let firstsCache = null;
  const landmarkLayer = L.layerGroup();
  const kindOf = (l) => core.LANDMARK_KINDS[l.kind] || { icon: '⚑', label: 'Landmark' };
  const blockOf = (lat, lng) => h3.latLngToCell(lat, lng, LANDMARK_BLOCK_RES);

  async function loadLandmarks(block) {
    if (!profile || !block || landmarksLoading) return;
    landmarksLoading = true;
    const disk = h3.gridDisk(block, 1);
    try {
      const rows = check(await sb.rpc('landmarks_near', { blocks: disk }));
      landmarksByCell = new Map();
      landmarksById = new Map();
      for (const r of rows) {
        r.id = Number(r.id);
        r.finds = Number(r.finds) || 0;
        r.ups = Number(r.ups) || 0;
        r.downs = Number(r.downs) || 0;
        if (!landmarksByCell.has(r.cell)) landmarksByCell.set(r.cell, []);
        landmarksByCell.get(r.cell).push(r);
        landmarksById.set(r.id, r);
      }
      landmarkBlocks = new Set(disk);
      landmarksLoadedAt = Date.now();
      drawLandmarks();
      const pos = S.position();
      if (pos) lookHere(pos.latlng, pos.accuracy);
    } catch (err) {
      // Offline or not signed in any more: try again in a minute.
      landmarksLoadedAt = Date.now() - LANDMARK_REFRESH_MS + LANDMARK_RETRY_MS;
    } finally {
      landmarksLoading = false;
    }
  }

  /**
   * Signed out: "?" pins from the neighbourhood pulse (where landmarks are and
   * how they're rated, nothing more). Tapping one asks you to sign in.
   */
  function showTeasers(pins) {
    if (profile) return;
    landmarksByCell = new Map();
    landmarksById = new Map();
    (pins || []).forEach((p, i) => {
      const l = { id: -(i + 1), teaser: true, cell: p.cell, ups: Number(p.ups) || 0, downs: 0, finds: 0, welcome: !!p.welcome };
      if (!landmarksByCell.has(l.cell)) landmarksByCell.set(l.cell, []);
      landmarksByCell.get(l.cell).push(l);
      landmarksById.set(l.id, l);
    });
    drawLandmarks();
  }

  /** Load around you, or around the map when there's no GPS fix. */
  function reloadLandmarks() {
    if (!profile) {
      landmarksByCell = new Map();
      landmarksById = new Map();
      landmarkBlocks = new Set();
      drawLandmarks();
      if (pulse) showTeasers(pulse.pins);
      return;
    }
    const pos = S.position();
    const at = pos ? pos.latlng : map.getCenter();
    landmarksLoadedAt = 0;
    loadLandmarks(blockOf(at.lat, at.lng));
  }

  const isSecret = (l) => !l.mine && !l.found_by_me;

  /** One pin per hex: a hex can hold several landmarks. */
  function drawLandmarks() {
    landmarkLayer.clearLayers();
    for (const [cell, here] of landmarksByCell) {
      const many = here.length > 1;
      const shown = here.find((l) => !isSecret(l));
      const face = shown ? kindOf(shown).icon : '?';
      const style = here.some((l) => l.mine) ? ' mine' : shown ? ' found' : ' unfound';
      // Ratings show before you've been there: is it worth the walk?
      const ups = here.reduce((n, l) => n + (l.ups || 0), 0);
      const single = here[0];
      const title = many
        ? `${here.length} landmarks here`
        : [isSecret(single) ? 'A landmark · walk through this hex to check it' : single.title, core.landmarkRating(single)]
          .filter(Boolean).join(' · ');
      L.marker(h3.cellToLatLng(cell), {
        icon: L.divIcon({
          className: `landmark-pin${style}`,
          // Only emoji and numbers go in here, never anything people typed.
          html: face +
            (many ? `<span class="pin-count">${here.length}</span>` : '') +
            (ups ? `<span class="pin-rating">👍${ups}</span>` : ''),
          iconSize: [30, 30],
        }),
        title,
        zIndexOffset: 500,
      }).on('click', () => openHex(cell)).addTo(landmarkLayer);
    }
    toggleLandmarks();
  }

  /** A hex's landmarks: straight to the one, or a list when there are several. */
  function openHex(cell) {
    const here = landmarksByCell.get(cell) || [];
    if (here.length === 1) return openLandmark(here[0]);
    if (!here.length) return toast("Those landmarks aren't around any more");
    S.openSheet('landmarkSheet');
    renderHex(cell);
  }

  function renderHex(cell) {
    const here = landmarksByCell.get(cell) || [];
    const secrets = here.filter(isSecret).length;
    fill($('landmarkBody'), h('div', { class: 'stack' },
      h('div', { class: 'stack tight', style: 'gap:2px' },
        sheetHead(`${here.length} landmarks on this hex`),
        secrets
          ? h('span', { class: 'me-sub' }, hereCell() === cell
            ? 'Tap one to check it off'
            : `Walk through this hex to find out what ${secrets === 1 ? "the hidden one is" : 'the hidden ones are'}`)
          : null),
      h('div', { class: 'list-card' }, here.map((l) => h('button', { class: 'list-row', onclick: () => openLandmark(l, cell) },
        h('span', { dir: 'auto' }, isSecret(l) ? '? A landmark' : `${kindOf(l).icon} ${l.title}`),
        h('span', { class: 'row-val' }, [l.mine ? 'yours' : null, core.landmarkRating(l) ||
          (l.finds ? `found ${l.finds}×` : 'not found yet')].filter(Boolean).join(' · ')),
        h('span', { class: 'chev' }, '›')))),
      h('button', { class: 'btn', 'data-close': true }, 'Done')));
  }

  function toggleLandmarks() {
    const on = landmarksByCell.size > 0 && map.getZoom() >= LANDMARK_ZOOM;
    if (on && !map.hasLayer(landmarkLayer)) landmarkLayer.addTo(map);
    if (!on && map.hasLayer(landmarkLayer)) map.removeLayer(landmarkLayer);
  }
  map.on('zoomend', toggleLandmarks);
  // Browsing the map without GPS: show the landmarks where you're looking.
  map.on('moveend', () => {
    if (!profile || map.getZoom() < LANDMARK_ZOOM) return;
    const pos = S.position();
    if (pos && Date.now() - pos.time < 2 * 60000) return;
    const c = map.getCenter();
    const block = blockOf(c.lat, c.lng);
    if (!landmarkBlocks.has(block) || Date.now() - landmarksLoadedAt > LANDMARK_REFRESH_MS) loadLandmarks(block);
  });

  // Every GPS fix, walk or not: keep the landmarks around you loaded and look
  // for one in the hex you're in.
  document.addEventListener('scoop:fix', (e) => {
    if (!profile) return;
    const { latlng, accuracy } = e.detail;
    const block = blockOf(latlng.lat, latlng.lng);
    if (!landmarkBlocks.has(block) || Date.now() - landmarksLoadedAt > LANDMARK_REFRESH_MS) loadLandmarks(block);
    lookHere(latlng, accuracy);
  });

  function lookHere(latlng, accuracy) {
    if (!landmarksByCell.size || accuracy > LANDMARK_MAX_ACCURACY) return;
    const cell = h3.latLngToCell(latlng.lat, latlng.lng, S.BASE_RES);
    const here = landmarksByCell.get(cell);
    if (!here) return;
    // Like hexes, only once you're well inside it: no alerts from walking along the edge.
    if (!core.inCore(latlng.lat, latlng.lng, h3.cellToLatLng(cell), h3.cellToBoundary(cell))) return;
    const fresh = core.landmarksToAlert(here, landmarkAlerts);
    if (fresh.length) alertLandmarks(fresh);
  }

  /** Tell you about the landmarks in the hex you just entered (one banner for all of them). */
  function alertLandmarks(list) {
    const now = Date.now();
    for (const l of list) landmarkAlerts[l.id] = now;
    landmarkAlerts = core.pruneAlerted(landmarkAlerts);
    saveJSON(LANDMARK_ALERTS_KEY, landmarkAlerts);
    alertedLandmark = list;
    const l = list[0];
    const one = list.length === 1;
    const kind = one ? kindOf(l) : { icon: '⚑' };
    const by = l.author ? `left by ${l.author}` : 'left by another explorer';
    const title = one ? l.title : `${list.length} landmarks here`;
    const rating = one ? core.landmarkRating(l) : null;
    $('landmarkAlertIcon').textContent = kind.icon;
    $('landmarkAlertTitle').textContent = title;
    $('landmarkAlertSub').textContent = one
      ? ['Landmark here', by, rating, `+${core.LANDMARK_POINTS.found} pts`].filter(Boolean).join(' · ')
      : `Check them off for +${core.LANDMARK_POINTS.found} pts each`;
    $('landmarkAlert').hidden = false;
    document.body.classList.add('landmark-alert-on');
    clearTimeout(landmarkAlertTimer);
    landmarkAlertTimer = setTimeout(hideLandmarkAlert, LANDMARK_ALERT_HIDE_MS);
    try {
      // Browsers only allow it once you've tapped the page.
      const tapped = !navigator.userActivation || navigator.userActivation.hasBeenActive;
      if (navigator.vibrate && tapped) navigator.vibrate([80, 60, 80]);
    } catch (e) {
      // Not supported: the banner is enough.
    }
    // Screen off (the Android app keeps walking in the background): a notification.
    if (Notifier && document.hidden) {
      Notifier.notifyLandmark({
        id: l.id,
        title: `${kind.icon} ${title}`,
        text: one
          ? `A landmark here, ${by}. Tap to check it for +${core.LANDMARK_POINTS.found} pts.`
          : `Tap to check them off for +${core.LANDMARK_POINTS.found} pts each.`,
      }).catch(() => {});
    }
  }

  function hideLandmarkAlert() {
    clearTimeout(landmarkAlertTimer);
    $('landmarkAlert').hidden = true;
    document.body.classList.remove('landmark-alert-on');
    alertedLandmark = null;
  }

  $('btnLandmarkCheck').addEventListener('click', () => {
    const list = alertedLandmark;
    hideLandmarkAlert();
    if (!list) return;
    if (list.length === 1) openLandmark(list[0]);
    else openHex(list[0].cell);
  });
  $('btnLandmarkLater').addEventListener('click', hideLandmarkAlert);

  /** Opened from a landmark notification (Android). */
  function openLandmarkById(id) {
    const l = landmarksById.get(Number(id));
    if (l) {
      hideLandmarkAlert();
      openHex(l.cell);
    } else {
      toast("That landmark isn't around any more");
    }
  }
  if (Notifier) {
    Notifier.addListener('openLandmark', (r) => r && r.id && openLandmarkById(r.id));
    // Opened from the notification while the app wasn't running: wait for the
    // landmarks around you before showing it.
    Notifier.takeLandmarkRequest().then((r) => {
      if (!r || !r.id) return;
      const tryOpen = (n) => {
        if (landmarksById.has(Number(r.id)) || n <= 0) openLandmarkById(r.id);
        else setTimeout(() => tryOpen(n - 1), 1000);
      };
      tryOpen(15);
    }).catch(() => {});
  }

  /** You can check a landmark off in its hex, or for a while after being told about it. */
  function canCheck(l) {
    return hereCell() === l.cell || Date.now() - (landmarkAlerts[l.id] || 0) < LANDMARK_CHECK_WINDOW_MS;
  }

  /** `fromHex`: opened from that hex's list, so "Done" goes back to it. */
  async function openLandmark(l, fromHex = null) {
    S.openSheet('landmarkSheet');
    let justFound = false;
    if (!l.teaser && !l.mine && !l.found_by_me && canCheck(l)) {
      fill($('landmarkBody'), h('span', { class: 'fine' }, 'Checking it off…'));
      try {
        const [r] = check(await sb.rpc('find_landmark', { landmark: l.id }));
        l.found_by_me = true;
        l.finds = Number(r.finds) || l.finds + 1;
        drawLandmarks();
        if (r.first_time) {
          justFound = true;
          const foundMsg = `${kindOf(l).icon} Landmark found · +${core.LANDMARK_POINTS.found} pts · you're the ${core.ordinal(l.finds)} explorer to find it`;
          if (firstsCache) firstsCache.found = true;
          smallWin(core.LANDMARK_POINTS.found);
          celebrateFirsts(`Landmark found · +${core.LANDMARK_POINTS.found} pts`).then((shown) => { if (!shown) toast(foundMsg, 4000); });
        }
      } catch (err) {
        if (/gone/.test(err.message)) {
          S.closeSheet();
          toast("That landmark isn't around any more");
          reloadLandmarks();
          return;
        }
        fail(err);
      }
    }
    renderLandmark(l, fromHex, justFound);
  }

  /** Hexes flying out from a hex badge: something just landed. */
  function burst(glyph) {
    const colours = ['var(--heat-0)', 'var(--heat-1)', 'var(--heat-2)', 'var(--you)'];
    const bits = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return h('i', {
        style: `background:${colours[i % 4]};--x:${Math.round(Math.cos(a) * 110)}px;--y:${Math.round(Math.sin(a) * 42)}px;animation-delay:${(i % 3) * 70}ms`,
      });
    });
    return h('div', { class: 'burst', 'aria-hidden': 'true' }, bits, h('div', { class: 'core' }, glyph));
  }

  /** `justFound`: checked off just now, so it lands with a burst. */
  function renderLandmark(l, fromHex = null, justFound = false) {
    const kind = kindOf(l);
    const secret = isSecret(l);
    const finds = l.finds === 1 ? 'Found by 1 explorer' : `Found by ${l.finds.toLocaleString()} explorers`;
    const votes = core.landmarkRating(l);
    const done = fromHex && (landmarksByCell.get(fromHex) || []).length > 1
      ? h('button', { class: 'btn', onclick: () => renderHex(fromHex) }, 'Back to this hex')
      : h('button', { class: 'btn', 'data-close': true }, secret ? 'OK' : 'Done');
    if (l.teaser) {
      // Signed out: we only know where it is and how it's rated.
      fill($('landmarkBody'), h('div', { class: 'stack' },
        sheetHead(l.welcome ? 'A welcome from a neighbour' : 'A landmark'),
        h('div', { class: 'blocked' },
          h('div', { class: 'hex-badge quiet', 'aria-hidden': 'true' }, '?'),
          h('span', { class: 'card-title' }, 'Something is here'),
          h('span', { class: 'body' }, l.welcome
            ? 'A neighbour left this for people new to the area. Sign in, then walk through this hex to find out what it is.'
            : 'Another explorer left a landmark on this hex. Sign in, then walk through it to find out what it is.'),
          votes ? h('span', { class: 'sublabel' }, votes) : null),
        h('button', { class: 'btn', onclick: openSignIn }, 'Sign in'),
        h('button', { class: 'btn ghost', 'data-close': true }, 'Not now')));
      return;
    }
    if (secret) {
      // What it is stays a surprise until you get there, but how explorers rated it doesn't.
      fill($('landmarkBody'), h('div', { class: 'stack' },
        sheetHead(l.welcome ? 'A welcome from a neighbour' : 'A landmark'),
        h('div', { class: 'blocked' },
          h('div', { class: 'hex-badge quiet', 'aria-hidden': 'true' }, '?'),
          h('span', { class: 'card-title' }, 'Something is here'),
          h('span', { class: 'body' }, l.welcome
            ? 'A neighbour left this for people new to the area. Walk through this hex to find out what it is.'
            : 'Another explorer left a landmark on this hex. Walk through it to find out what it is.'),
          h('span', { class: 'sublabel' }, [l.finds ? finds : 'Nobody has found it yet', votes || (l.finds ? 'no votes yet' : null)]
            .filter(Boolean).join(' · '))),
        done));
      return;
    }
    const welcome = l.welcome && !l.mine;
    const firstsLine = justFound && firstsCache ? `${core.firstsDone(firstsCache)} of ${core.FIRSTS.length} firsts` : null;
    fill($('landmarkBody'), h('div', { class: 'stack' },
      sheetHead(l.mine ? 'Your landmark' : 'Landmark found'),
      justFound ? burst(kind.icon) : null,
      h('div', { class: 'landmark-card' },
        welcome ? h('span', { class: 'kicker' }, 'A welcome from a neighbour') : null,
        justFound ? null : h('span', { class: 'emoji', 'aria-hidden': 'true' }, kind.icon),
        h('span', { class: 'card-title', dir: 'auto' }, l.title),
        h('span', { class: 'me-sub' }, [kind.label, l.mine ? 'left by you' : `left by ${l.author || 'an explorer'}`,
          core.timeAgo(Date.parse(l.created_at))].join(' · ')),
        l.note ? h('p', { class: 'note', dir: 'auto' }, l.note) : null,
        justFound
          ? h('span', { class: 'fine' }, [`+${core.LANDMARK_POINTS.found} pts`, firstsLine,
            `${core.ordinal(l.finds)} to find it`, votes].filter(Boolean).join(' · '))
          : h('span', { class: 'fine' }, [l.finds ? finds : 'Nobody has found it yet', votes,
            l.mine && l.points != null ? `earned you ${fmtPts(l.points)} pts` : null].filter(Boolean).join(' · '))),
      l.mine && l.buried
        ? h('div', { class: 'panel tint sm' }, h('span', { class: 'body' },
          'Hidden: explorers who found it voted it down, so nobody else sees it or gets told about it.'))
        : l.mine && l.held
          ? h('div', { class: 'panel tint sm' }, h('span', { class: 'body' },
            'Hidden while we look at reports about it. Nobody else sees it until then.'))
          : null,
      l.mine ? null : voteBox(l, fromHex),
      l.mine || !mod() ? null : h('button', {
        class: 'link muted',
        onclick: () => mod().landmark(l, {
          back: () => { S.openSheet('landmarkSheet'); renderLandmark(l, fromHex); },
          changed: reloadLandmarks,
        }),
      }, 'Report or block'),
      l.mine
        ? h('button', { class: 'btn outline danger', onclick: () => removeLandmark(l) }, 'Remove landmark')
        : null,
      l.mine && !fromHex ? null : done));
  }

  /** Thumbs up or down, for explorers who found it. */
  function voteBox(l, fromHex) {
    const vote = async (v) => {
      if (busy) return;
      busy = true;
      try {
        const [r] = check(await sb.rpc('vote_landmark', { landmark: l.id, vote: v }));
        const first = !l.my_vote;
        l.my_vote = v;
        l.ups = Number(r.ups) || 0;
        l.downs = Number(r.downs) || 0;
        if (first) toast(v === 1 ? `👍 Thanks · +${core.LANDMARK_POINTS.upvoted} pt for whoever left it` : '👎 Thanks · that helps keep landmarks worth the stop');
        drawLandmarks(); // the pin shows the rating
        renderLandmark(l, fromHex);
      } catch (err) {
        fail(err);
      } finally {
        busy = false;
      }
    };
    let busy = false;
    const btn = (v, icon, label) => h('button', {
      type: 'button', class: 'kind vote', role: 'radio', 'aria-checked': String(l.my_vote === v), 'aria-label': label,
      onclick: () => vote(v),
    }, h('span', { class: 'emoji', 'aria-hidden': 'true' }, icon), h('b', {}, label));
    return h('div', { class: 'stack tight' },
      h('span', { class: 'sublabel' }, l.my_vote ? 'Your vote · tap to change it'
        : l.welcome ? 'Worth the stop? Your vote helps the next newcomer' : 'Worth the stop? Your vote helps other explorers'),
      h('div', { class: 'kinds', role: 'radiogroup', 'aria-label': 'Vote' },
        btn(1, '👍', 'Yes'), btn(-1, '👎', 'Not really')));
  }

  async function removeLandmark(l) {
    const ok = await confirmDialog({
      title: 'Remove this landmark?',
      body: `"${l.title}" disappears from the map${l.finds ? `, and so do its ${l.finds} find${l.finds === 1 ? '' : 's'}` : ''}, along with the points it earned you. This can't be undone.`,
      confirm: 'Remove',
    });
    if (ok !== 'confirm') return;
    try {
      check(await sb.from('landmarks').delete().eq('id', l.id));
      toast('Landmark removed');
      reloadLandmarks();
      S.closeSheet();
    } catch (err) {
      fail(err);
    }
  }

  // ---------- leave a landmark ----------

  let landmarkKind = null;
  let landmarkWelcome = true;

  $('btnLandmark').addEventListener('click', () => {
    landmarkKind = null;
    landmarkWelcome = true;
    renderLeaveLandmark();
    S.openSheet('landmarkSheet');
  });

  async function renderLeaveLandmark() {
    const body = 'landmarkBody';
    const cell = hereCell();
    if (!cell) {
      return blocked('⌖', 'Finding you…', 'Landmarks go on the hex you are standing in, so we need your location. Outdoors it usually takes a few seconds.',
        'Locate me', () => { S.closeSheet(); S.locate(); }, body);
    }
    // Any hex you're standing in, walked or not: but be sure it's this one.
    const pos = S.position();
    if (pos.accuracy > LANDMARK_MAX_ACCURACY || Date.now() - pos.time > LANDMARK_FIX_MAX_AGE_MS) {
      return blocked('⌖', 'Pinpointing you…', `Landmarks go on the hex you're standing in, so we need a precise location (within ${LANDMARK_MAX_ACCURACY} m; now ${Math.round(pos.accuracy)} m). Outdoors, away from tall buildings, it usually takes a few seconds.`,
        'Try again', () => renderLeaveLandmark(), body);
    }
    if (isHidden(cell)) {
      return blocked('◌', "You're in a privacy zone", 'Nothing inside your privacy zones is shared, so landmarks are off here.', 'Manage zones', () => {
        renderZoneList();
        S.openSheet('zonesSheet');
      }, body);
    }
    fill($(body), h('span', { class: 'fine' }, 'Loading…'));
    let mine = [];
    try {
      mine = check(await sb.rpc('my_landmarks')).map((r) => ({
        ...r, id: Number(r.id), finds: Number(r.finds) || 0, ups: Number(r.ups) || 0, downs: Number(r.downs) || 0,
        points: Number(r.points) || 0, mine: true,
      }));
    } catch (err) {
      // Offline: the server still checks everything on submit.
    }
    const mineHere = mine.filter((l) => l.cell === cell).length;
    const full = mine.length >= LANDMARK_LIMIT;
    const fullHere = mineHere >= LANDMARK_PER_HEX_LIMIT;
    // Everything already on this hex (yours and others'), so you don't leave the same thing twice.
    const mineById = new Map(mine.map((l) => [l.id, l]));
    const here = (landmarksByCell.get(cell) || []).map((l) => mineById.get(l.id) || l);
    for (const l of mine) if (l.cell === cell && !here.some((x) => x.id === l.id)) here.push(l);

    const title = h('input', { class: 'input note', placeholder: 'Name it, e.g. "Rooftop view of the Nile"', maxlength: '60', dir: 'auto', 'aria-label': 'Title' });
    const note = h('textarea', { class: 'input', placeholder: 'What should people look for? (optional)', maxlength: '280', dir: 'auto', 'aria-label': 'Note' });
    const submit = h('button', { class: 'btn', type: 'submit', disabled: true }, 'Leave landmark');
    const districtName = (() => {
      const a = Areas ? Areas.of(cell) : null;
      return a && a.district ? (Areas.info(a.district) || {}).name : null;
    })();
    // A welcome: newcomers to the area are pointed to it as their first landmark to find.
    const welcome = h('button', {
      type: 'button', class: 'toggle-row', role: 'switch', 'aria-checked': String(landmarkWelcome),
      onclick: () => {
        landmarkWelcome = !landmarkWelcome;
        welcome.setAttribute('aria-checked', String(landmarkWelcome));
      },
    }, h('span', {}, 'Point newcomers here',
      h('small', {}, `New explorers in ${districtName || 'the area'} get it as a welcome`)),
    h('span', { class: 'switch' }, h('span')));
    const kindGrid = h('div', { class: 'kinds', role: 'radiogroup', 'aria-label': 'Kind of landmark' });
    const valid = () => !!landmarkKind && !!title.value.trim();
    const draw = () => {
      fill(kindGrid, Object.entries(core.LANDMARK_KINDS).map(([key, k]) => h('button', {
        type: 'button', class: 'kind', role: 'radio', 'aria-checked': String(key === landmarkKind),
        onclick: () => { landmarkKind = key; draw(); },
      }, h('span', { class: 'emoji', 'aria-hidden': 'true' }, k.icon), h('b', {}, k.label))));
      submit.disabled = !valid();
    };
    title.addEventListener('input', draw);

    const onThisHex = here.length ? h('div', { class: 'stack tight' },
      h('span', { class: 'label' }, `Already on this hex · ${here.length}`),
      h('div', { class: 'list-card' }, here.map((l) => h('button', {
        class: 'list-row', onclick: () => (l.mine ? renderLandmark(l) : openLandmark(l)),
      },
      h('span', { dir: 'auto' }, isSecret(l) ? '? A landmark · tap to check it' : `${kindOf(l).icon} ${l.title}`),
      h('span', { class: 'row-val' }, [l.mine ? 'yours' : null, core.landmarkRating(l)].filter(Boolean).join(' · ')),
      h('span', { class: 'chev' }, '›'))))) : null;

    const form = full
      ? h('span', { class: 'body' }, `You have ${LANDMARK_LIMIT} landmarks out. Remove one below to leave another.`)
      : fullHere
        ? h('span', { class: 'body' }, `You have ${LANDMARK_PER_HEX_LIMIT} landmarks on this hex. Leave the next one somewhere else.`)
        : h('form', {
          class: 'stack tight',
          onsubmit: async (e) => {
            e.preventDefault();
            if (!valid()) return;
            submit.disabled = true;
            try {
              check(await sb.from('landmarks')
                .insert({ cell, kind: landmarkKind, title: title.value.trim(), note: note.value.trim() || null, welcome: landmarkWelcome }));
              const leftMsg = `${core.LANDMARK_KINDS[landmarkKind].icon} Landmark left · +${core.LANDMARK_POINTS.left} pts · ${landmarkWelcome
                ? 'newcomers will be pointed to it' : 'explorers passing by will be told'}`;
              if (firstsCache) firstsCache.left = true;
              smallWin(core.LANDMARK_POINTS.left);
              celebrateFirsts(`Landmark left · +${core.LANDMARK_POINTS.left} pts`).then((shown) => { if (!shown) toast(leftMsg, 4000); });
              landmarkKind = null;
              landmarkWelcome = true;
              reloadLandmarks();
              renderLeaveLandmark();
            } catch (err) {
              fail(err);
              submit.disabled = !valid();
            }
          },
        }, kindGrid, title, note, welcome, submit);

    const district = districtName;
    fill($(body), h('div', { class: 'stack' },
      h('div', { class: 'stack tight', style: 'gap:2px' },
        h('div', { class: 'sheet-head' },
          h('span', { class: 'sheet-title' }, 'Leave a landmark'),
          h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕')),
        h('span', { class: 'me-sub' }, [district, 'on this hex · explorers who pass through get told'].filter(Boolean).join(' · ')),
        h('span', { class: 'fine' }, `+${core.LANDMARK_POINTS.left} pts now, +${core.LANDMARK_POINTS.wasFound} each time someone finds it, +${core.LANDMARK_POINTS.upvoted} for each 👍.`)),
      onThisHex,
      form,
      await notificationRow(),
      mine.length ? h('div', { class: 'stack tight' },
        h('span', { class: 'label' }, `Your landmarks · ${mine.length}/${LANDMARK_LIMIT}`),
        h('div', { class: 'list-card' }, mine.map((l) => h('button', { class: 'list-row', onclick: () => renderLandmark(l) },
          h('span', { dir: 'auto' }, `${kindOf(l).icon} ${l.title}`),
          h('span', { class: l.finds && !l.buried && !l.held ? 'row-val accent' : 'row-val' },
            l.buried || l.held ? 'hidden' : l.finds ? `found ${l.finds}×${l.ups ? ` · 👍 ${l.ups}` : ''}` : 'not found yet'),
          h('span', { class: 'chev' }, '›'))))) : null));
    draw();
  }

  /** Android: landmark notifications need the notification permission. */
  async function notificationRow() {
    if (!Notifier) return null;
    try {
      const s = await Notifier.getStatus();
      if (s.notificationsAllowed) return null;
    } catch (err) {
      return null;
    }
    return h('div', { class: 'list-card' },
      h('button', {
        class: 'list-row',
        onclick: async () => {
          try {
            const s = await Notifier.allowNotifications();
            if (s.notificationsAllowed) {
              toast("You'll get a notification when you pass a landmark");
              renderLeaveLandmark();
            } else {
              toast('Allow notifications for Scoop in Android settings', 4000);
            }
          } catch (err) {
            fail(err);
          }
        },
      }, h('span', {}, 'Notify me about landmarks with the screen off'), h('span', { class: 'row-val accent' }, 'Allow'), h('span', { class: 'chev' }, '›')));
  }

  // ---------- belonging: arriving in a neighbourhood ----------
  //
  // Where you are (worked out on the phone from Scoop's districts, or areas
  // already looked up), and a pulse of that neighbourhood from the server:
  // how many explorers keep it warm, where landmarks are, which explorer you'd
  // be. The pulse works signed out too: it sends only the district id and the
  // ~5 km² blocks around you, and never while you're inside a privacy zone.
  const HOOD_KEY = 'scoop.hood.v1';
  const PULSE_REFRESH_MS = 15 * 60000;
  const PULSE_RETRY_MS = 60000;
  /** @type {{id:string|null,name:string|null}} the district you're in; none where Scoop has no district (offline with no fix, it's the last one) */
  let hood = loadJSON(HOOD_KEY, { id: null, name: null });
  // The place the home panel shows: your district, or, where OSM has none (El
  // Gouna), the city-level area it has (the governorate).
  const PLACE_KEY = 'scoop.place.v1';
  /** @type {{id:string|null,name:string|null,kind:'district'|'city'|null}} */
  let place = loadJSON(PLACE_KEY, null) || (hood.id ? { ...hood, kind: 'district' } : { id: null, name: null, kind: null });
  let pulseBlock = null;
  let pulseAt = 0;
  let pulseLoading = null;

  function cityOf(latlng) {
    if (!Areas || !latlng) return null;
    const a = Areas.of(h3.latLngToCell(latlng.lat, latlng.lng, S.BASE_RES));
    if (!a || !a.city) return null;
    const info = Areas.info(a.city);
    return info && info.name ? { id: a.city, name: info.name } : null;
  }

  function districtOf(latlng) {
    if (!Areas || !latlng) return null;
    const a = Areas.of(h3.latLngToCell(latlng.lat, latlng.lng, S.BASE_RES));
    if (!a || !a.district) return null;
    const info = Areas.info(a.district);
    return info && info.name ? { id: a.district, name: info.name } : null;
  }

  /** The district you're in (or were last), else the one you walk most. */
  function hoodName() {
    const home = homes.find((a) => a.kind === 'district');
    return hood.name || (firstsCache && firstsCache.homeName) || (home && home.name) || null;
  }

  /** Landmarks you could go and find, with how far each is from you. */
  function openMarks() {
    const pos = S.position();
    const all = [...landmarksByCell.values()].flat();
    const dist = (l) => {
      if (!pos) return NaN;
      const [lat, lng] = h3.cellToLatLng(l.cell);
      return distance(pos.latlng, { lat, lng });
    };
    return { all, dist };
  }

  function nearbyCount() {
    const { all, dist } = openMarks();
    return all.filter((l) => !l.mine && dist(l) <= core.NEAR_METERS).length;
  }

  function updateHood() {
    const name = hood.name;
    $('walkSub').textContent = name ? `warms ${name}` : '';
    const row = $('hoodRow');
    row.hidden = !name;
    if (name) {
      $('hoodName').textContent = `You're in ${name}`;
      const n = pulse && pulse.district === hood.id ? Number(pulse.explorers) || 0 : null;
      const near = nearbyCount();
      $('hoodSub').textContent = [
        n === null ? null : n ? `${n.toLocaleString()} explorer${n === 1 ? '' : 's'} keep it warm` : 'Be the first explorer here',
        near ? `${near} landmark${near === 1 ? '' : 's'} within 5 min` : null,
      ].filter(Boolean).join(' · ') || 'Your first walk starts here';
    }
    $('mapHint').hidden = !nearbyCount();
  }

  /** Fetch the pulse for where you are. `force` skips the "fetched lately" check. */
  async function loadPulse(latlng, force = false) {
    if (!latlng) return pulse;
    const cell = h3.latLngToCell(latlng.lat, latlng.lng, S.BASE_RES);
    if (isHidden(cell)) return pulse; // never look anything up from inside a privacy zone
    if (Areas) await Areas.ready;
    const here = districtOf(latlng);
    if (here && (here.id !== hood.id || here.name !== hood.name)) {
      hood = here;
      saveJSON(HOOD_KEY, hood);
    } else if (!here && hood.id) {
      // You're somewhere Scoop has no district for (yet): don't keep claiming the last one.
      hood = { id: null, name: null };
      saveJSON(HOOD_KEY, hood);
    }
    // The district, else the city-level area; none when neither is known yet.
    const city = here ? null : cityOf(latlng);
    const next = here ? { ...here, kind: 'district' } : city ? { ...city, kind: 'city' } : { id: null, name: null, kind: null };
    if (next.id !== place.id || next.name !== place.name || next.kind !== place.kind) {
      place = next;
      saveJSON(PLACE_KEY, place);
      document.dispatchEvent(new CustomEvent('scoop:hood', { detail: place }));
    }
    const block = h3.latLngToCell(latlng.lat, latlng.lng, LANDMARK_BLOCK_RES);
    const fresh = block === pulseBlock && Date.now() - pulseAt < PULSE_REFRESH_MS;
    if (pulseLoading) return pulseLoading;
    if (fresh && !force) {
      updateHood();
      return pulse;
    }
    pulseLoading = (async () => {
      try {
        const district = here ? here.id : null;
        const [r] = check(await sb.rpc('area_pulse', { district, blocks: h3.gridDisk(block, 1) }));
        pulse = { district, ...r, pins: Array.isArray(r.pins) ? r.pins : [] };
        pulseBlock = block;
        pulseAt = Date.now();
        if (!profile) showTeasers(pulse.pins);
      } catch (err) {
        // Offline: try again in a minute. The map works without it.
        pulseAt = Date.now() - PULSE_REFRESH_MS + PULSE_RETRY_MS;
      } finally {
        pulseLoading = null;
        updateHood();
      }
      return pulse;
    })();
    return pulseLoading;
  }

  document.addEventListener('scoop:fix', (e) => loadPulse(e.detail.latlng));
  updateHood();

  // ---------- belonging: your first week (neighbourhood firsts) ----------

  /** Work out the firsts: on this phone, plus your account when signed in. */
  async function loadFirsts() {
    const s = { walked: S.walks.length > 0 || S.visited.size > 0, homeName: null,
      found: false, met: false, coffee: false, left: false };
    if (profile) {
      try {
        const [r] = check(await sb.rpc('my_firsts'));
        Object.assign(s, {
          walked: s.walked || r.walked, homeName: r.home_name || null,
          found: r.found, met: r.met, coffee: r.coffee, left: r.left_one, ok: true,
        });
      } catch (err) {
        if (firstsCache && firstsCache.signedIn) return firstsCache; // offline: keep what we knew
      }
    }
    s.signedIn = !!profile;
    if (!profile) s.ok = true;
    firstsCache = s;
    return s;
  }

  // ---------- celebrating firsts ----------

  // What was done the last time we celebrated (per account), so each first is
  // celebrated once, whichever device or friend completed it.
  const FIRSTS_SEEN_KEY = 'scoop.firstsSeen.v1';
  const seenKey = () => `${FIRSTS_SEEN_KEY}:${uid() || 'anon'}`;
  const pickFirsts = (s) => Object.fromEntries(core.FIRSTS.map((k) => [k, !!s[k]]));
  /** Became a local mid-walk: the full moment waits for the walk summary. */
  let localPending = null;

  /** Remember what's already done without celebrating it (new install, new device, new account). */
  async function seedFirsts() {
    if (loadJSON(seenKey(), null)) return;
    const s = await loadFirsts().catch(() => null);
    if (s && s.ok) saveJSON(seenKey(), pickFirsts(s));
  }

  /** Where your location dot is on screen, or the middle of the map. */
  function dotOnScreen() {
    const r = map.getContainer().getBoundingClientRect();
    const pos = S.position();
    const p = pos ? map.latLngToContainerPoint(pos.latlng) : { x: r.width / 2, y: r.height / 2 };
    return { x: r.left + p.x, y: r.top + p.y };
  }

  /** A small win on the map: hexes burst from your dot and the points float up. */
  function smallWin(points) {
    const C = window.scoopCelebrate;
    if (!C) return;
    const { x, y } = dotOnScreen();
    C.burst({ x, y, count: 28 });
    if (points) C.floatText(`+${points}`, x + 10, y - 34);
    C.buzz([40, 40, 60]);
  }

  /**
   * After something that can complete a first: celebrate the firsts done since
   * last time. On the walk summary it's a card; anywhere else a banner over
   * the map; the sixth is the full-screen "You're a local" (after the walk,
   * if you're walking). `what` is the action's own line ("Landmark left ·
   * +3 pts"). Returns true if something was celebrated.
   */
  async function celebrateFirsts(what) {
    const C = window.scoopCelebrate;
    let s;
    try {
      s = await loadFirsts();
    } catch (err) {
      return false;
    }
    if (!C || !s || !s.ok) return false;
    const seen = loadJSON(seenKey(), null);
    saveJSON(seenKey(), pickFirsts(s));
    const fresh = core.newFirsts(seen, s);
    if (!fresh.length) return false;
    const name = hoodName() || 'your neighbourhood';
    const local = hoodName() ? `${name} local` : 'local';
    const done = core.firstsDone(s);
    const left = core.FIRSTS.length - done;
    const freshAt = core.FIRSTS.indexOf(fresh[fresh.length - 1]);
    const items = core.FIRSTS.map((k) => ({ ...core.FIRST_GLYPHS[k], on: !!s[k] }));
    const label = core.FIRST_GLYPHS[fresh[fresh.length - 1]].label;
    const next = core.nextFirst(s);
    const inSummary = S.currentSheet() === 'summarySheet' && $('summaryExtra');

    if (!next) {
      if (S.walking()) {
        localPending = name;
        C.banner({ icon: '🏠', title: `You're a ${local}!`, sub: what || label, body: C.steps(items, freshAt, 'sm') });
        C.buzz([60, 60, 60]);
        return true;
      }
      setTimeout(() => showLocal(name), inSummary ? (C.reduced() ? 300 : 2600) : 0);
      if (!inSummary) return true;
    }

    const togo = !next ? `You're a ${local}`
      : left === 1 ? `One more first and you're a ${local}` : `${left} firsts from becoming a ${local}`;
    if (inSummary) {
      const nextLine = next ? firstItems(s, hoodName())[next] : null;
      const card = h('button', { type: 'button', class: 'cel-local cel-later', onclick: openFirsts },
        h('div', { class: 'cel-local-top' },
          h('b', {}, next ? 'A step closer to local' : 'Local ✓'),
          h('span', {}, `${done} / ${core.FIRSTS.length}`)),
        C.steps(items, freshAt),
        h('span', { class: 'cel-local-what', dir: 'auto' }, `${label}. `,
          h('em', {}, togo), nextLine ? `: ${nextLine.t.charAt(0).toLowerCase()}${nextLine.t.slice(1)}` : null, '.'));
      $('summaryExtra').before(card);
      setTimeout(() => { card.classList.remove('cel-later'); card.classList.add('cel-in'); }, C.reduced() ? 0 : 2200);
    } else {
      C.banner({ icon: core.FIRST_GLYPHS[fresh[fresh.length - 1]].glyph, title: what || label, sub: togo, body: C.steps(items, freshAt, 'sm') });
    }
    return true;
  }

  /** The full-screen moment: you've done all six firsts. */
  function showLocal(name) {
    const C = window.scoopCelebrate;
    localPending = null;
    const named = name && name !== 'your neighbourhood';
    const items = core.FIRSTS.map((k) => ({ ...core.FIRST_GLYPHS[k], on: true }));
    C.moment({
      emblem: '🏠',
      emblemLabel: 'Local',
      kicker: `${named ? `${name} · ` : ''}6 of 6 firsts`,
      title: named ? `You're a ${name} local` : 'You’re a local',
      sub: 'You walked it, made it home, found a neighbour’s landmark, walked with someone, had a coffee and left a landmark of your own.',
      body: C.steps(items, -1, 'all'),
      actions: [{ label: 'Share my map', primary: true, onclick: () => shareCard() }, { label: 'Done' }],
    });
    C.buzz([60, 60, 60, 60, 160]);
    if (!C.reduced()) {
      setTimeout(() => C.burst({ x: innerWidth / 2, y: innerHeight * 0.3, count: 140, big: true }), 450);
      setTimeout(() => C.burst({ x: innerWidth * 0.25, y: innerHeight * 0.55, count: 50 }), 1100);
      setTimeout(() => C.burst({ x: innerWidth * 0.75, y: innerHeight * 0.55, count: 50 }), 1350);
    }
  }

  function goSignIn() {
    S.closeSheet();
    openSignIn();
  }

  /** Close the sheet and show the landmark a newcomer should go and find. */
  function showWelcome(pick) {
    S.closeSheet();
    const ll = h3.cellToLatLng(pick.l.cell);
    map.setView(ll, Math.max(map.getZoom(), 17));
    openHex(pick.l.cell);
  }

  function firstItems(s, name) {
    const where = name || 'your neighbourhood';
    const { all, dist } = openMarks();
    // Invited by a friend: their welcome comes first, wherever it is.
    const invited = loadJSON(WELCOME_FROM_KEY, null);
    const fromFriend = invited ? landmarksById.get(invited.landmark) : null;
    const pick = fromFriend && !fromFriend.found_by_me ? { l: fromFriend, m: dist(fromFriend), from: invited.from }
      : core.pickWelcome(all, dist);
    const cafes = pulse && pulse.district === hood.id ? Number(pulse.cafes) || 0 : 0;
    return {
      walked: { t: 'Take your first walk', m: 'Tap Start walk and head out', act: () => S.closeSheet() },
      found: {
        t: 'Find a neighbour’s landmark',
        m: pick
          ? [pick.from ? `${pick.from} left you one` : null,
            Number.isFinite(pick.m) ? `${pick.from ? '' : 'Nearest is '}${core.walkDistance(pick.m)} away` : null,
            pick.l.ups ? `👍 ${pick.l.ups}` : null].filter(Boolean).join(' · ')
          : 'Walk past a ? on the map',
        act: pick ? () => showWelcome(pick) : () => S.closeSheet(),
      },
      met: {
        t: 'Walk with someone',
        m: 'Start or join a circle, or meet a friend and check in together',
        act: profile ? () => (window.scoopCircles ? window.scoopCircles.openIntro() : $('btnSocial').click()) : goSignIn,
      },
      coffee: {
        t: 'Check in for coffee',
        m: cafes ? `${cafes} café${cafes === 1 ? '' : 's'} on hexes walked in ${where}` : 'Check in with ☕ on a hex you walked',
        act: profile ? () => { S.closeSheet(); $('btnCheckin').click(); } : goSignIn,
      },
      left: {
        t: 'Leave a welcome for the next newcomer',
        m: 'A landmark on any hex',
        act: profile ? () => { S.closeSheet(); $('btnLandmark').click(); } : goSignIn,
      },
    };
  }

  async function openFirsts() {
    S.openSheet('firstsSheet');
    if (!firstsCache) fill($('firstsBody'), h('span', { class: 'fine' }, 'Loading…'));
    else renderFirsts(firstsCache);
    const pos = S.position();
    await Promise.all([loadFirsts(), pos ? loadPulse(pos.latlng) : null]);
    if (S.currentSheet() === 'firstsSheet') renderFirsts(firstsCache);
  }

  function renderFirsts(s) {
    const name = hoodName();
    const done = core.firstsDone(s);
    const next = core.nextFirst(s);
    const items = firstItems(s, name);
    const p = pulse && pulse.district === hood.id ? pulse : null;
    const stats = p ? [
      `${Number(p.explorers).toLocaleString()} explorer${Number(p.explorers) === 1 ? '' : 's'}`,
      `${Number(p.landmarks).toLocaleString()} landmark${Number(p.landmarks) === 1 ? '' : 's'}`,
      Number(p.cafes) ? `${p.cafes} café${Number(p.cafes) === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ') : null;
    fill($('firstsBody'), h('div', { class: 'stack' },
      h('div', { class: 'sheet-head' },
        h('div', { class: 'hood-head' },
          h('span', { class: 'hood-hex', 'aria-hidden': 'true' }),
          h('div', {},
            h('span', { class: 'title', dir: 'auto' }, next ? `Your first week in ${name || 'the neighbourhood'}` : `You're a ${name || 'neighbourhood'} local`),
            stats ? h('span', { class: 'sub' }, stats) : null)),
        h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'firsts-progress' },
        h('div', { class: 'top' }, h('b', {}, `${done} of ${core.FIRSTS.length} neighbourhood firsts`), h('span', {}, next ? 'Become a local' : 'Local ✓')),
        h('div', { class: 'progress-steps', 'aria-hidden': 'true' }, core.FIRSTS.map((k) => h('span', { class: s[k] ? 'on' : '' })))),
      h('div', { class: 'firsts' }, core.FIRSTS.map((k) => {
        const it = items[k];
        if (s[k]) {
          return h('div', { class: 'first done', 'aria-label': `${it.t}: done` }, h('span', { class: 'mark', 'aria-hidden': 'true' }, '✓'),
            h('div', {}, h('b', { dir: 'auto' }, it.t)));
        }
        const isNext = k === next;
        return h('button', { type: 'button', class: isNext ? 'first next' : 'first', onclick: it.act },
          h('span', { class: 'mark', 'aria-hidden': 'true' }, isNext ? '?' : h('i')),
          h('div', {}, h('b', { dir: 'auto' }, it.t), h('small', { dir: 'auto' }, it.m)),
          isNext ? h('span', { class: 'go' }, 'Go ›') : null);
      })),
      h('span', { class: 'fine' }, 'No deadline. Firsts stay open as long as you like.')));
  }

  /** In Me, until you're a local. */
  document.addEventListener('scoop:me-open', async () => {
    const s = await loadFirsts();
    const name = hoodName();
    const next = core.nextFirst(s);
    fill($('meFirsts'), next ? h('div', { class: 'list-card' },
      h('button', { class: 'list-row', onclick: openFirsts },
        h('span', { dir: 'auto' }, `Your first week in ${name || 'the neighbourhood'}`),
        h('span', { class: 'row-val accent' }, `${core.firstsDone(s)} of ${core.FIRSTS.length} firsts`),
        h('span', { class: 'chev' }, '›'))) : null);
  });

  // After a walk: the firsts it (or anything since) completed, and the local moment if it waited for the walk to end.
  document.addEventListener('scoop:summary', async () => {
    const pending = localPending;
    const shown = await celebrateFirsts();
    if (pending && !shown && S.currentSheet() === 'summarySheet') {
      setTimeout(() => showLocal(pending), window.scoopCelebrate && window.scoopCelebrate.reduced() ? 300 : 2600);
    }
  });

  // The first walk saved: a welcome to the neighbourhood, and where to go next.
  document.addEventListener('scoop:summary', async (e) => {
    if (!e.detail.first) return;
    const done = $('summaryDone');
    if (done) done.replaceWith(h('button', { class: 'btn', id: 'summaryDone', onclick: openFirsts }, 'Meet your neighbourhood'));
    const pos = S.position();
    if (pos) await loadPulse(pos.latlng, true);
    const box = $('summaryExtra');
    if (!box || !hood.name || S.currentSheet() !== 'summarySheet') return;
    const p = pulse && pulse.district === hood.id ? pulse : null;
    const near = nearbyCount();
    fill(box, h('div', { class: 'welcome-card' },
      h('span', { class: 'title', dir: 'auto' }, `Welcome to ${hood.name}`),
      p ? h('span', { class: 'sub' }, `You're its ${core.ordinal(Number(p.ordinal) || 1)} explorer.`) : null,
      near ? h('div', { class: 'welcome-pins' },
        h('span', { class: 'q', 'aria-hidden': 'true' }, Array.from({ length: Math.min(3, near) }, () => h('span', {}, '?'))),
        h('span', {}, near === 1
          ? 'A neighbour left a landmark within 5 minutes of here.'
          : `${near} neighbours left landmarks within 5 minutes of here.`)) : null));
  });

  // ---------- boot ----------

  updateIdentity();

  // Exposed for debugging and end-to-end tests.
  window.scoopSocial = { sb, sync, get profile() { return profile; } };

  // What circles.js builds on.
  window.scoopKit = {
    sb, check, fail, h, fill, sheetHead, avatar, nameOf, initialOf, fmtKm, distance, shareText, cancelled, PUBLIC_URL,
    uid, get profile() { return profile; }, get session() { return session; },
    openSignIn, hereCell, isHidden: (cell) => isHidden(cell), loadFriends, renewal,
    hood: () => hood, place: () => place, hoodName, districtOf, openFirsts, forgetFirsts: () => { firstsCache = null; }, loadFirsts,
    get homes() { return homes; },
    // Everyone's warmth layer (Settings, and the home panel's district tab).
    setCommunity: (on) => { communityOn = !!on; communityKey = ''; drawCommunity(); },
    pulse: () => pulse,
    reactBar, yourLandmarkCard,
    LANDMARK_MAX_ACCURACY,
  };
  document.dispatchEvent(new CustomEvent('scoop:kit', { detail: window.scoopKit }));
})();
