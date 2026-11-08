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
    // Pulled hexes are marked as on the server since version 2: pull
    // everything once more so earlier pulls get marked too.
    if (syncState.pullVersion !== 2) {
      delete syncState.pulledAt;
      syncState.pulledWalk = 0;
    }
    const first = !syncState.pulledAt;
    const since = first ? null : new Date(Date.parse(syncState.pulledAt) - PULL_OVERLAP_MS).toISOString();
    const walkAfter = first ? 0 : syncState.pulledWalk || 0;
    const [cellRows, walkRows] = await Promise.all([
      fetchMyCells(since),
      fetchAll(() => sb.from('walks').select('id, started_at, ended_at, km, new_cells').eq('user_id', uid()).gt('id', walkAfter), 'id'),
    ]);
    const valid = (c) => h3.isValidCell(c) && h3.getResolution(c) === S.BASE_RES;
    const got = core.mergeRemote(S, cellRows, walkRows, valid);
    // What came down is on the server already: never upload it back, so a
    // hex another device took off the server (its privacy zone) stays off.
    // Hexes inside this device's zones that another device uploaded come off
    // the server again.
    const hidden = [];
    for (const r of cellRows) {
      if (!valid(r.cell)) continue;
      if (isHidden(r.cell)) hidden.push(r.cell);
      else syncState.cells[r.cell] = core.pulledSig(r);
    }
    await removeFromServer(hidden);
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
    syncState.pullVersion = 2;
    saveSync();
    if (!got.cells && !got.warmed && !got.walks) return;
    S.saveNow();
    S.render();
    if (!got.cells && !got.walks) return; // only warmed-up hexes: the map shows it
    const what = [got.cells && plural(got.cells, 'new hex'), got.walks && plural(got.walks, 'walk')].filter(Boolean).join(', ');
    toast(`${first ? 'Restored from your account' : 'From your other devices'} · ${what}`, 4000);
  }

  /** Delete these hexes of yours, and your check-ins and landmarks on them, from the server. */
  async function removeFromServer(cells) {
    for (const batch of core.chunk(cells, 200)) {
      check(await sb.from('user_cells').delete().eq('user_id', uid()).in('cell', batch));
      check(await sb.from('checkins').delete().eq('user_id', uid()).in('cell', batch));
      check(await sb.from('landmarks').delete().eq('user_id', uid()).in('cell', batch));
      for (const c of batch) delete syncState.cells[c];
      saveSync();
    }
  }

  /** Remove anything now inside a privacy zone from the server, or upload what left one. */
  async function afterZonesChanged() {
    if (!profile) return;
    try {
      await removeFromServer(Object.keys(syncState.cells).filter(isHidden));
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

  /** Home areas ([{kind, name, rank, total, id}]) for the identity line and Me sheet. */
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
      sub: district && district.name ? `Home district · ${district.name}` : `@${profile.username}`,
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
  }

  function onProfileReady() {
    document.body.classList.add('signed-in');
    scheduleSync(500);
    acceptPendingInvite();
    loadCheckinMarkers();
    loadHomes();
    reloadLandmarks();
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
      fill($('meAreas'), homes.length ? h('div', { class: 'block' },
        h('span', { class: 'label' }, 'Your areas'),
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
    }, h('span', {}, 'Community map', h('small', {}, 'Hexes you and your friends explored. Tap one to see who got there first.')),
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
  /** Challenge sub-view: null (list), 'new', or a challenge row. */
  let chalView = null;

  $('btnSocial').addEventListener('click', () => {
    if (!profile) return openSignIn();
    chalView = null;
    renderSocial();
    S.openSheet('socialSheet');
  });

  function renderSocial() {
    if (!profile) return fill($('socialBody'));
    const panel = h('div', { class: 'stack' }, h('span', { class: 'fine' }, 'Loading…'));
    if (tab === 'challenges' && chalView) {
      fill($('socialBody'), h('div', { class: 'stack' }, panel));
    } else {
      fill($('socialBody'), h('div', { class: 'stack' },
        sheetHead('Friends'),
        segmented(h('div', { class: 'seg tabs', 'aria-label': 'Friends sections' }), TABS, tab, (v) => {
          tab = v;
          chalView = null;
          saveJSON(TAB_KEY, tab);
          renderSocial();
        }),
        panel));
    }
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

  function feedItem(item, urls) {
    const who = item.type === 'checkin' ? item.author : item.profiles;
    const mine = item.user_id === uid();
    const name = mine ? 'You' : nameOf(who);
    let text;
    let extra = [];
    if (item.type === 'walk') {
      text = `walked ${fmtKm(item.km)} km` + (item.new_cells ? ` · ${item.new_cells} new hex${item.new_cells === 1 ? '' : 'es'}` : '');
      extra = [kudosBar(item)];
    } else if (item.type === 'badge') {
      const b = core.BADGES[item.badge_key] || { icon: '🏅', label: item.badge_key };
      text = `earned ${b.icon} ${b.label}`;
    } else {
      const kind = core.CHECKIN_KINDS[item.kind];
      text = item.kind === 'meetup'
        ? (item.met_with ? ['met up with ', h('bdi', {}, item.met ? nameOf(item.met) : 'a friend'), ' 🤝'] : 'is up for a meetup 🤝')
        : `checked in · ${kind.icon} ${kind.label.toLowerCase()}`;
      extra = [
        item.note ? h('span', { class: 'feed-note', dir: 'auto' }, item.note) : null,
        urls[item.photo_path] ? h('img', { class: 'feed-photo', src: urls[item.photo_path], alt: item.note || 'Check-in photo', loading: 'lazy' }) : null,
        h('button', { class: 'link', onclick: () => { S.closeSheet(); map.setView(h3.cellToLatLng(item.cell), 17); } }, 'Show on map'),
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
      for (const item of page.items) list.append(feedItem(item, page.urls));
      if (page.items.length) before = page.items[page.items.length - 1].at;
      more.hidden = !page.more;
      more.disabled = false;
      if (!list.children.length) {
        list.append(h('span', { class: 'body' }, 'Nothing here yet. Add friends in the Friends tab, then go for a walk!'));
      }
    };
    more.addEventListener('click', () => load().catch(fail));
    await load();
    fill(panel, list, more);
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

  async function renewFriend(r) {
    try {
      const [res] = check(await sb.rpc('renew_friendship', { other: r.other.id }));
      toast(res.renewed ? `Renewed · friends with ${nameOf(r.other)} for 30 more days`
        : `Renewed on your side · waiting for ${nameOf(r.other)}`, 4000);
      renderSocial();
    } catch (err) {
      fail(err);
    }
  }

  /** Renewal chip: "21 days left", "Renew · 5 days left", "Waiting for them", "Renew — they did". */
  function renewal(r) {
    if (r.state === 'active') {
      return h('span', { class: 'chip status ok', role: 'note' }, `${daysLeft(r.expires)} days left`);
    }
    if (r.iRenewed) return h('span', { class: 'chip status quiet', role: 'note' }, 'Waiting for them');
    return h('button', { class: 'chip status warn', onclick: () => renewFriend(r) },
      r.theyRenewed ? 'Renew — they did' : r.state === 'lapsed' ? 'Renew' : `Renew · ${daysLeft(r.expires)} days left`);
  }

  async function renderFriends(panel) {
    const [rows, code, stats] = await Promise.all([
      loadFriends(), sb.rpc('my_invite_code').then(check), sb.rpc('friend_stats').then(check),
    ]);
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
            h('button', { class: 'link danger', 'aria-label': `Remove ${nameOf(p)}`, onclick: () => removeFriend(r) }, 'Remove'))),
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
      h('div', { class: 'invite' },
        h('div', {}, h('small', {}, 'Your invite code'), h('span', { class: 'code' }, code)),
        h('button', {
          class: 'btn sm',
          onclick: () => shareText('Scoop', 'Explore the city with me on Scoop!', `${PUBLIC_URL}?invite=${code}`)
            .catch((err) => { if (!cancelled(err)) fail(err); }),
        }, 'Share invite')),
      h('form', {
        class: 'inline-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const c = core.parseInvite(codeInput.value);
          if (!c) return toast("That doesn't look like an invite code");
          try {
            const [p] = check(await sb.rpc('send_friend_request', { code: c }));
            toast({
              accepted: `You're friends with ${nameOf(p)}`,
              renewing: `Renewed on your side · waiting for ${nameOf(p)}`,
            }[p.status] || `Request sent to ${nameOf(p)}`);
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
            h('button', { class: 'link', onclick: respond(r, false) }, 'Decline')))))) : null,
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
        'Friends see your map, walks, check-ins, scores and home district' + (me && me.district_name ? ` (${me.district_name})` : '') + '.'));
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
  /** @type {Map<string, {explorers:number, first_username:string}>} */
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
      if (map.getZoom() < 14) {
        communityLayer.clearLayers();
        communityKey = '';
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
      if (!cells8.length || cells8.length > 60) return;
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
            fillColor: S.COLORS.community, fillOpacity: Math.min(0.15 + 0.1 * r.explorers, 0.65),
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
      h('b', {}, `${r.explorers} explorer${r.explorers === 1 ? '' : 's'}`), h('br'),
      `First here: ${r.first_username}`)).openOn(map);
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
    const rows = check(await sb.rpc('area_leaderboard', { area: home.id, period: rankPrefs.period }));
    const mine = rows.find((r) => r.is_me);
    const total = rows.length ? rows[0].total : 0;
    const where = everyone ? '' : ` in ${home.name}`;
    fill(panel, controls,
      h('div', { class: 'panel tint sm' },
        h('span', { class: 'standing', dir: 'auto' }, mine
          ? `You're #${mine.rank} of ${Number(total).toLocaleString()}${everyone ? ' explorers' : where}`
          : `No points${where} yet`),
        h('span', { class: 'sub' }, mine
          ? `Top ${core.topPercent(mine.rank, total)}%` + (home.kind === 'district' ? ' · your home district' : '')
          : PERIOD_SUB[rankPrefs.period])),
      h('div', { class: 'rank-list' }, rows.map((r, i) => [
        i > 0 && r.rank > rows[i - 1].rank + 1 ? h('div', { class: 'rank-gap', 'aria-hidden': 'true' }, '…') : null,
        rankRow(r, { me: r.is_me, friend: r.is_friend, name: r.is_me ? myName : r.username ? nameOf(r) : null }),
      ])),
      h('span', { class: 'fine' }, "People you don't know show as Explorer. Points fade as hexes cool, so the board always reflects recent walking."));
  }

  // ---------- challenges ----------

  function challengeStatus(c) {
    const now = Date.now();
    const end = Date.parse(c.ends_at);
    if (end < now) return 'Finished';
    if (Date.parse(c.starts_at) > now) return 'Not started';
    const days = Math.ceil((end - now) / 86400000);
    return `${days} day${days === 1 ? '' : 's'} left`;
  }

  async function renderChallenges(panel) {
    if (chalView === 'new') return renderNewChallenge(panel);
    if (chalView) return renderChallengeDetail(panel, chalView);
    const rows = check(await sb.from('challenge_members')
      .select('status, challenges(id, title, starts_at, ends_at, creator)')
      .eq('user_id', uid()));
    const list = rows.filter((r) => r.challenges)
      .sort((a, b) => (a.challenges.ends_at < b.challenges.ends_at ? 1 : -1));
    fill(panel,
      h('button', { class: 'btn outline accent', onclick: () => { chalView = 'new'; renderSocial(); } }, 'New challenge'),
      list.map((r) => {
        const c = r.challenges;
        const invited = r.status === 'invited';
        return h('button', {
          class: 'chal-card',
          onclick: () => { chalView = c; renderSocial(); },
        },
        h('span', { class: 'top' }, h('b', { dir: 'auto' }, c.title), h('small', {}, `${invited ? 'Invited' : challengeStatus(c)} ›`)),
        h('span', { class: 'sub' }, invited ? 'Open it to join' : `${new Date(c.starts_at).toLocaleDateString()} – ${new Date(c.ends_at).toLocaleDateString()}`));
      }),
      h('span', { class: 'fine' }, 'Race your friends wherever they live. Each of you is ranked in your own district by the points you earn there ' +
        'during the challenge, and the best top % wins: 6th of 500 beats 3rd of 4.'));
  }

  async function renderChallengeDetail(panel, c) {
    const rows = check(await sb.rpc('challenge_standings', { cid: c.id }));
    const mine = rows.find((r) => r.user_id === uid());
    const joined = (r) => r.status === 'joined';
    const back = () => { chalView = null; renderSocial(); };
    const leave = async () => {
      const creator = c.creator === uid();
      if (creator) {
        const choice = await confirmDialog({
          title: 'Delete this challenge?',
          body: `"${c.title}" ends for everyone and its standings are gone. It can't be undone.`,
          confirm: 'Delete challenge',
        });
        if (choice !== 'confirm') return;
      }
      try {
        if (creator) check(await sb.from('challenges').delete().eq('id', c.id));
        else check(await sb.from('challenge_members').delete().eq('challenge_id', c.id).eq('user_id', uid()));
        back();
      } catch (err) {
        fail(err);
      }
    };
    fill(panel,
      h('button', { class: 'back', onclick: back }, '‹ Challenges'),
      h('div', { class: 'detail-head' },
        h('span', { class: 'detail-title', dir: 'auto' }, c.title),
        h('span', { class: 'sub', style: 'font-size:13px' },
          `${new Date(c.starts_at).toLocaleDateString()} – ${new Date(c.ends_at).toLocaleDateString()} · ${challengeStatus(c)}`)),
      mine && mine.status === 'invited' ? h('button', {
        class: 'btn',
        onclick: async () => {
          try {
            check(await sb.from('challenge_members').update({ status: 'joined' }).eq('challenge_id', c.id).eq('user_id', uid()));
            renderSocial();
          } catch (err) {
            fail(err);
          }
        },
      }, 'Join challenge') : null,
      h('div', { class: 'panel tint' },
        h('b', { style: 'font-size:14px' }, 'Best top % wins'),
        h('span', { class: 'card-note' }, 'Each of you is ranked in your own home district by points earned there. 6th of 500 (top 1.1%) beats 3rd of 4 (top 62.5%).')),
      h('div', { class: 'stack tight', style: 'gap:6px' }, rows.map((r) => {
        const me = r.user_id === uid();
        const on = joined(r);
        const has = on && Number(r.value) > 0;
        return h('div', { class: `chal-row${me ? ' me' : ''}${has && r.rank === 1 ? ' win' : ''}` },
          h('span', { class: 'pos' }, on ? String(r.rank) : '–'),
          h('div', { class: 'who' },
            h('span', { dir: 'auto' }, me ? `${nameOf(r)} (you)` : nameOf(r)),
            h('small', {}, on
              ? (r.district_name ? `${r.district_name} · #${r.district_rank ?? '–'} of ${r.district_total ?? '–'} · ${fmtPts(r.value)} pts` : 'No points yet')
              : 'Invited')),
          h('div', { class: 'top-pct' }, h('b', {}, has ? `${r.top_pct}%` : '–'), h('small', {}, 'top')));
      })),
      h('span', { class: 'card-note' }, 'Top % counts from the middle of your place, so 1st of 1 is top 50%. No points means last.'),
      h('button', { class: 'btn outline danger', onclick: leave },
        c.creator === uid() ? 'Delete challenge' : mine && mine.status === 'invited' ? 'Decline' : 'Leave challenge'));
  }

  async function renderNewChallenge(panel) {
    const friends = (await loadFriends()).filter(isFriend).map((r) => r.other);
    const title = h('input', { class: 'input', placeholder: 'Weekend loop', maxlength: '60', required: true, dir: 'auto' });
    let days = 7;
    const picked = new Set(friends.map((p) => p.id));
    const send = h('button', { class: 'btn', type: 'submit' }, 'Send invites');
    const valid = () => title.value.trim().length > 0 && picked.size > 0;
    const refresh = () => { send.disabled = !valid(); };
    title.addEventListener('input', refresh);
    const back = () => { chalView = null; renderSocial(); };
    fill(panel, h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!valid()) return;
        send.disabled = true;
        try {
          const start = new Date();
          const c = check(await sb.from('challenges').insert({
            title: title.value.trim(),
            starts_at: start.toISOString(), ends_at: new Date(+start + days * 86400000).toISOString(),
          }).select('id, title, starts_at, ends_at, creator').single());
          const invites = [...picked].map((id) => ({ challenge_id: c.id, user_id: id, status: 'invited' }));
          if (invites.length) check(await sb.from('challenge_members').insert(invites));
          chalView = c;
          renderSocial();
          toast(`Invites sent to ${invites.length} friend${invites.length === 1 ? '' : 's'}`);
        } catch (err) {
          fail(err);
          refresh();
        }
      },
    },
    h('button', { class: 'back', type: 'button', onclick: back }, '‹ Challenges'),
    h('span', { class: 'detail-title' }, 'New challenge'),
    h('label', { class: 'field' }, 'Name', title),
    h('div', { class: 'block', style: 'gap:6px' },
      h('span', { class: 'sublabel', style: 'font-size:12.5px' }, 'Length'),
      segmented(h('div', { class: 'seg', 'aria-label': 'Length' }),
        [1, 3, 7, 14, 30].map((d) => [d, `${d} day${d === 1 ? '' : 's'}`]), days, (v) => { days = v; })),
    h('div', { class: 'block', style: 'gap:6px' },
      h('span', { class: 'sublabel', style: 'font-size:12.5px' }, 'Invite friends'),
      friends.length
        ? friends.map((p) => {
          const row = h('button', {
            class: 'pick-row', type: 'button', role: 'checkbox', 'aria-checked': 'true',
            onclick: () => {
              if (picked.has(p.id)) picked.delete(p.id);
              else picked.add(p.id);
              row.setAttribute('aria-checked', String(picked.has(p.id)));
              row.querySelector('.tick').textContent = picked.has(p.id) ? '✓' : '';
              refresh();
            },
          }, h('span', { dir: 'auto' }, nameOf(p)), h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'));
          return row;
        })
        : h('span', { class: 'body' }, 'Add friends first to race them.')),
    send));
    refresh();
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
      return blocked('?', 'Walk this hex first', "Check-ins go on hexes you've walked. This one is still unexplored — walk through it and try again.",
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
          if (checkinKind !== 'meetup') toast(`${k.icon} Checked in · +${k.points} pts`);
          else toast(row.met_with ? '🤝 Meetup verified · +5 pts' : '🤝 Checked in · waiting for a friend to check in here');
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
  const LANDMARK_ALERT_HIDE_MS = 10 * 60000;
  const LANDMARK_CHECK_WINDOW_MS = 30 * 60000; // after being told, you can still check it off from afar
  const LANDMARK_ZOOM = 15;
  const LANDMARK_LIMIT = 25;                // keep in sync with landmark_limit() in the migration
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

  /** Load around you, or around the map when there's no GPS fix. */
  function reloadLandmarks() {
    if (!profile) {
      landmarksByCell = new Map();
      landmarksById = new Map();
      landmarkBlocks = new Set();
      drawLandmarks();
      return;
    }
    const pos = S.position();
    const at = pos ? pos.latlng : map.getCenter();
    landmarksLoadedAt = 0;
    loadLandmarks(blockOf(at.lat, at.lng));
  }

  function drawLandmarks() {
    landmarkLayer.clearLayers();
    for (const l of landmarksById.values()) {
      const kind = kindOf(l);
      const secret = !l.mine && !l.found_by_me;
      L.marker(h3.cellToLatLng(l.cell), {
        icon: L.divIcon({
          className: `landmark-pin${l.mine ? ' mine' : secret ? ' unfound' : ' found'}`,
          html: secret ? '?' : kind.icon,
          iconSize: [30, 30],
        }),
        title: secret ? 'A landmark · walk through this hex to check it' : l.title,
        zIndexOffset: 500,
      }).on('click', () => openLandmark(l)).addTo(landmarkLayer);
    }
    toggleLandmarks();
  }

  function toggleLandmarks() {
    const on = !!profile && map.getZoom() >= LANDMARK_ZOOM;
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
    const l = core.landmarkToAlert(here, landmarkAlerts);
    if (l) alertLandmark(l);
  }

  function alertLandmark(l) {
    landmarkAlerts[l.id] = Date.now();
    landmarkAlerts = core.pruneAlerted(landmarkAlerts);
    saveJSON(LANDMARK_ALERTS_KEY, landmarkAlerts);
    alertedLandmark = l;
    const kind = kindOf(l);
    const by = l.author ? `left by ${l.author}` : 'left by another explorer';
    $('landmarkAlertIcon').textContent = kind.icon;
    $('landmarkAlertTitle').textContent = l.title;
    $('landmarkAlertSub').textContent = `Landmark here · ${by} · +${core.LANDMARK_POINTS.found} pts`;
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
      Notifier.notifyLandmark({ id: l.id, title: `${kind.icon} ${l.title}`, text: `A landmark here, ${by}. Tap to check it for +${core.LANDMARK_POINTS.found} pts.` })
        .catch(() => {});
    }
  }

  function hideLandmarkAlert() {
    clearTimeout(landmarkAlertTimer);
    $('landmarkAlert').hidden = true;
    document.body.classList.remove('landmark-alert-on');
    alertedLandmark = null;
  }

  $('btnLandmarkCheck').addEventListener('click', () => {
    const l = alertedLandmark;
    hideLandmarkAlert();
    if (l) openLandmark(l);
  });
  $('btnLandmarkLater').addEventListener('click', hideLandmarkAlert);

  /** Opened from a landmark notification (Android). */
  function openLandmarkById(id) {
    const l = landmarksById.get(Number(id));
    if (l) {
      hideLandmarkAlert();
      openLandmark(l);
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

  async function openLandmark(l) {
    S.openSheet('landmarkSheet');
    if (!l.mine && !l.found_by_me && canCheck(l)) {
      fill($('landmarkBody'), h('span', { class: 'fine' }, 'Checking it off…'));
      try {
        const [r] = check(await sb.rpc('find_landmark', { landmark: l.id }));
        l.found_by_me = true;
        l.finds = Number(r.finds) || l.finds + 1;
        drawLandmarks();
        if (r.first_time) toast(`${kindOf(l).icon} Landmark found · +${core.LANDMARK_POINTS.found} pts · you're the ${core.ordinal(l.finds)} explorer to find it`, 4000);
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
    renderLandmark(l);
  }

  function renderLandmark(l) {
    const kind = kindOf(l);
    const secret = !l.mine && !l.found_by_me;
    const finds = l.finds === 1 ? 'Found by 1 explorer' : `Found by ${l.finds.toLocaleString()} explorers`;
    if (secret) {
      fill($('landmarkBody'), h('div', { class: 'stack' },
        sheetHead('A landmark'),
        h('div', { class: 'blocked' },
          h('div', { class: 'hex-badge quiet', 'aria-hidden': 'true' }, '?'),
          h('span', { class: 'card-title' }, 'Something is here'),
          h('span', { class: 'body' }, `Another explorer left a landmark on this hex. Walk through it to find out what it is. ${l.finds ? finds + ' so far.' : 'Nobody has found it yet.'}`)),
        h('button', { class: 'btn', 'data-close': true }, 'OK')));
      return;
    }
    const votes = (l.ups || l.downs) ? `👍 ${l.ups || 0} · 👎 ${l.downs || 0}` : null;
    fill($('landmarkBody'), h('div', { class: 'stack' },
      sheetHead(l.mine ? 'Your landmark' : 'Landmark found'),
      h('div', { class: 'landmark-card' },
        h('span', { class: 'emoji', 'aria-hidden': 'true' }, kind.icon),
        h('span', { class: 'card-title', dir: 'auto' }, l.title),
        h('span', { class: 'me-sub' }, [kind.label, l.mine ? 'left by you' : `left by ${l.author || 'an explorer'}`,
          core.timeAgo(Date.parse(l.created_at))].join(' · ')),
        l.note ? h('p', { class: 'note', dir: 'auto' }, l.note) : null,
        h('span', { class: 'fine' }, [l.finds ? finds : 'Nobody has found it yet', votes,
          l.mine && l.points != null ? `earned you ${fmtPts(l.points)} pts` : null].filter(Boolean).join(' · '))),
      l.mine && l.buried
        ? h('div', { class: 'panel tint sm' }, h('span', { class: 'body' },
          'Hidden: explorers who found it voted it down, so nobody else sees it or gets told about it.'))
        : null,
      l.mine ? null : voteBox(l),
      l.mine
        ? h('button', { class: 'btn outline danger', onclick: () => removeLandmark(l) }, 'Remove landmark')
        : h('button', { class: 'btn', 'data-close': true }, 'Done')));
  }

  /** Thumbs up or down, for explorers who found it. */
  function voteBox(l) {
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
        renderLandmark(l);
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
      h('span', { class: 'sublabel' }, l.my_vote ? 'Your vote · tap to change it' : 'Worth the stop? Your vote helps other explorers'),
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

  $('btnLandmark').addEventListener('click', () => {
    landmarkKind = null;
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
    if (!S.visited.has(cell)) {
      return blocked('?', 'Walk this hex first', "Landmarks go on hexes you've walked. This one is still unexplored — walk through it and try again.",
        'Start walk', () => S.startWalk(), body);
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
    const existing = mine.find((l) => l.cell === cell);
    const full = mine.length >= LANDMARK_LIMIT;

    const title = h('input', { class: 'input note', placeholder: 'Name it, e.g. "Rooftop view of the Nile"', maxlength: '60', dir: 'auto', 'aria-label': 'Title' });
    const note = h('textarea', { class: 'input', placeholder: 'What should people look for? (optional)', maxlength: '280', dir: 'auto', 'aria-label': 'Note' });
    const submit = h('button', { class: 'btn', type: 'submit', disabled: true }, 'Leave landmark');
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

    const form = existing
      ? h('div', { class: 'list-card' },
        h('button', { class: 'list-row', onclick: () => renderLandmark(existing) },
          h('span', { dir: 'auto' }, `${kindOf(existing).icon} ${existing.title}`),
          h('span', { class: 'row-val' }, 'Your landmark here'), h('span', { class: 'chev' }, '›')))
      : full
        ? h('span', { class: 'body' }, `You have ${LANDMARK_LIMIT} landmarks out. Remove one below to leave another.`)
        : h('form', {
          class: 'stack tight',
          onsubmit: async (e) => {
            e.preventDefault();
            if (!valid()) return;
            submit.disabled = true;
            try {
              await sync(); // the server only accepts landmarks in hexes it knows you walked
              check(await sb.from('landmarks')
                .insert({ cell, kind: landmarkKind, title: title.value.trim(), note: note.value.trim() || null }));
              toast(`${core.LANDMARK_KINDS[landmarkKind].icon} Landmark left · +${core.LANDMARK_POINTS.left} pts · explorers passing by will be told`, 4000);
              landmarkKind = null;
              reloadLandmarks();
              renderLeaveLandmark();
            } catch (err) {
              fail(err.code === '23505' ? new Error('You already have a landmark on this hex') : err);
              submit.disabled = !valid();
            }
          },
        }, kindGrid, title, note, submit);

    const area = Areas ? Areas.of(cell) : null;
    const district = area && area.district ? (Areas.info(area.district) || {}).name : null;
    fill($(body), h('div', { class: 'stack' },
      h('div', { class: 'stack tight', style: 'gap:2px' },
        h('div', { class: 'sheet-head' },
          h('span', { class: 'sheet-title' }, 'Leave a landmark'),
          h('button', { class: 'icon-btn sm', 'data-close': true, 'aria-label': 'Close' }, '✕')),
        h('span', { class: 'me-sub' }, [district, 'on this hex · explorers who pass through get told'].filter(Boolean).join(' · ')),
        h('span', { class: 'fine' }, `+${core.LANDMARK_POINTS.left} pts now, +${core.LANDMARK_POINTS.wasFound} each time someone finds it, +${core.LANDMARK_POINTS.upvoted} for each 👍.`)),
      form,
      await notificationRow(),
      mine.length ? h('div', { class: 'stack tight' },
        h('span', { class: 'label' }, `Your landmarks · ${mine.length}/${LANDMARK_LIMIT}`),
        h('div', { class: 'list-card' }, mine.map((l) => h('button', { class: 'list-row', onclick: () => renderLandmark(l) },
          h('span', { dir: 'auto' }, `${kindOf(l).icon} ${l.title}`),
          h('span', { class: l.finds && !l.buried ? 'row-val accent' : 'row-val' },
            l.buried ? 'hidden' : l.finds ? `found ${l.finds}×${l.ups ? ` · 👍 ${l.ups}` : ''}` : 'not found yet'),
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

  // ---------- boot ----------

  updateIdentity();

  // Exposed for debugging and end-to-end tests.
  window.scoopSocial = { sb, sync, get profile() { return profile; } };
})();
