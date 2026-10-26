/* Scoop community features, with no server: friends swap "Scoop files" through
 * the share sheet, and everything else (feed, scores, leaderboards, badges,
 * verified meetups, challenges, the community map) is worked out on the device
 * from those files. Also share cards and privacy zones.
 *
 * Talks to app.js only through window.scoop and `scoop:*` events.
 * A Scoop file holds hex ids (first visits rounded to the day), visit counts,
 * walk totals, check-ins and challenges — never GPS tracks — and nothing
 * inside a privacy zone.
 */
(() => {
  'use strict';

  const S = window.scoop;
  const core = window.ScoopCore;
  if (!S || !core || !window.h3) return;

  const { map, toast } = S;
  const $ = (id) => document.getElementById(id);

  const ME_KEY = 'scoop.me.v1';
  const CHECKINS_KEY = 'scoop.checkins.v1';
  const CHALLENGES_KEY = 'scoop.challenges.v1';
  const ZONES_KEY = 'scoop.zones.v1';
  const TAB_KEY = 'scoop.tab';
  const RANKS_KEY = 'scoop.ranks';
  const FRIEND_COLOR = '#4cc9f0';
  const COMMUNITY_COLOR = '#9b5de5';
  const parent8 = (c) => h3.cellToParent(c, 8);

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
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
  }
  /** Replace an element's children, skipping null/false (replaceChildren would print them). */
  function fill(el, ...kids) {
    el.replaceChildren();
    append(el, kids);
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
      return true;
    } catch (e) {
      toast('Could not save — storage full or blocked. Export a backup!');
      return false;
    }
  }

  function fail(err) {
    toast((err && err.message) || String(err), 4500);
  }

  const cancelled = (err) => /cancel|abort/i.test((err && (err.name + err.message)) || '');
  const distance = (a, b) => h3.greatCircleDistance([a.lat, a.lng], [b.lat, b.lng], h3.UNITS.m);
  const fmtKm = (km) => Number(km).toFixed(km >= 10 ? 1 : 2);
  const fmtVal = (v, metric) => `${metric === 'km' ? fmtKm(v) : Number(v).toLocaleString()} ${core.METRICS[metric]}`;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
  const localDay = (ms) => new Date(ms).toDateString();

  /** Tiny key-value store on IndexedDB, for friends' files and photos (too big for localStorage). */
  const idb = (() => {
    let opening = null;
    const open = () => opening || (opening = new Promise((resolve, reject) => {
      const req = indexedDB.open('scoop', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      });
    };
    return {
      get: (key) => run('readonly', (s) => s.get(key)),
      set: (key, value) => run('readwrite', (s) => s.put(value, key)),
      del: (key) => run('readwrite', (s) => s.delete(key)),
    };
  })();

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

  // ---------- local state ----------

  /** @type {{id:string, name:string}|null} */
  let me = loadJSON(ME_KEY, null);
  /** @type {{id:string, cell:string, kind:string, time:number, note:string, photo?:boolean}[]} */
  let checkins = loadJSON(CHECKINS_KEY, []);
  /** Challenges you made or were invited to; status is your own: 'joined' or 'invited'. */
  let challenges = loadJSON(CHALLENGES_KEY, []);
  /** @type {Map<string, object>} id -> person parsed from their latest Scoop file */
  const friends = new Map();

  const saveCheckins = () => saveJSON(CHECKINS_KEY, checkins);
  const saveChallenges = () => saveJSON(CHALLENGES_KEY, challenges);

  function myPerson() {
    const cells = new Map();
    for (const [c, t] of S.visited) cells.set(c, { t, v: S.visitCount(c) });
    return { id: me ? me.id : 'me', name: me ? me.name : 'You', me: true, cells, walks: S.walks, checkins };
  }
  const people = () => [myPerson(), ...friends.values()];
  const nameOf = (id) => (me && id === me.id ? me.name : friends.has(id) ? friends.get(id).name : null);

  // Your check-ins, name and challenges go into backups; friends' files don't
  // (they can send them again).
  S.registerBackup('social', {
    save: () => ({ me, checkins, challenges }),
    restore: (data) => {
      if (data.me && !me) { me = data.me; saveJSON(ME_KEY, me); }
      const known = new Set(checkins.map((c) => c.id));
      for (const c of data.checkins || []) if (!known.has(c.id)) checkins.push({ ...c, photo: false });
      saveCheckins();
      const knownCh = new Set(challenges.map((c) => c.id));
      for (const c of data.challenges || []) if (!knownCh.has(c.id)) challenges.push(c);
      saveChallenges();
      loadCheckinMarkers();
    },
  });

  document.addEventListener('scoop:cleared', () => {
    for (const c of checkins) if (c.photo) idb.del(`photo:${c.id}`).catch(() => {});
    checkins = [];
    saveCheckins();
    loadCheckinMarkers();
  });

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
    fill($('zoneList'), zones.map((z, i) => h('li', {},
      h('span', {}, `Zone ${i + 1}`),
      h('select', {
        'aria-label': `Zone ${i + 1} radius`,
        onchange: (e) => { z.r = Number(e.target.value); zonesChanged(); },
      }, [200, 300, 500, 800].map((r) => h('option', { value: String(r), selected: r === z.r }, `${r} m`))),
      h('button', { class: 'link', onclick: () => { S.closeSheet(); map.setView([z.lat, z.lng], 16); } }, 'Show'),
      h('button', { class: 'link danger', onclick: () => { zones.splice(i, 1); zonesChanged(); } }, 'Remove'),
    )));
    $('btnAddZone').disabled = zones.length >= 3;
  }

  $('btnAddZone').addEventListener('click', () => {
    const c = map.getCenter();
    zones.push({ lat: c.lat, lng: c.lng, r: 300 });
    zonesChanged();
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
    const display = new Set();
    for (const c of S.visited.keys()) if (!isHidden(c)) display.add(S.toDisplay(c));
    const shown = [...display].filter((c) => bounds.contains(h3.cellToLatLng(c)) && !hiddenDisplay(c));

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
    stats.forEach(([n, lbl], i) => {
      const x = 40 + colW * i + colW / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd166';
      ctx.font = '700 56px system-ui, sans-serif';
      ctx.fillText(n, x, 1150);
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

  // ---------- Scoop files: share yours, add friends' ----------

  async function shareMyFile() {
    if (!me) return toast('Set your name in Community first');
    const file = core.makeFriendFile({
      me,
      cells: [...S.visited].filter(([c]) => !isHidden(c)).map(([c, t]) => [c, t, S.visitCount(c)]),
      walks: S.walks,
      checkins: checkins.filter((c) => !isHidden(c.cell)),
      challenges: challenges.filter((c) => c.status === 'joined').map((c) => ({
        ...c, names: Object.fromEntries(c.members.map((m) => [m, nameOf(m) || c.names[m]]).filter(([, n]) => n)),
      })),
    });
    const slug = me.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'me';
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    try {
      await shareFile(blob, `scoop-${slug}-${new Date().toISOString().slice(0, 10)}.json`, `${me.name}'s Scoop`);
    } catch (err) {
      if (!cancelled(err)) fail(err);
    }
  }

  const friendFileInput = h('input', { type: 'file', accept: '.json,application/json', multiple: true, hidden: true });
  document.body.append(friendFileInput);
  friendFileInput.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const file of files) {
      try {
        const raw = JSON.parse(await file.text());
        const p = core.parseFriendFile(raw);
        if (me && p.id === me.id) throw new Error('that\'s your own Scoop file');
        const prev = friends.get(p.id);
        if (prev && prev.exported > p.exported) throw new Error(`you already have a newer file from ${p.name}`);
        await idb.set(`friend:${p.id}`, raw);
        await idb.set('friendIds', [...new Set([...friends.keys(), p.id])]);
        friends.set(p.id, p);
        const invites = mergeChallenges(p);
        toast(`${prev ? 'Updated' : 'Added'} ${p.name} · ${p.cells.size.toLocaleString()} hexes` +
          (invites ? ` · ${invites} challenge invite${invites === 1 ? '' : 's'}` : ''), 4000);
      } catch (err) {
        toast(`Skipped ${file.name}: ${err.message}`, 4500);
      }
    }
    friendsChanged();
  });

  /** Pick up challenges from a friend's file that include you. Returns new invites. */
  function mergeChallenges(p) {
    if (!me) return 0;
    let added = 0;
    for (const c of p.challenges) {
      if (c.creator === me.id || !c.members.includes(me.id)) continue;
      const mine = challenges.find((x) => x.id === c.id);
      if (mine) Object.assign(mine, { ...c, status: mine.status, names: { ...mine.names, ...c.names } });
      else {
        challenges.push({ ...c, status: 'invited' });
        added++;
      }
    }
    saveChallenges();
    return added;
  }

  async function loadFriends() {
    try {
      const ids = (await idb.get('friendIds')) || [];
      for (const id of ids) {
        const raw = await idb.get(`friend:${id}`);
        if (raw) friends.set(id, core.parseFriendFile(raw));
      }
    } catch (err) {
      // No IndexedDB (some private windows): friends just can't be kept.
    }
    friendsChanged();
  }

  async function removeFriend(id) {
    friends.delete(id);
    await idb.del(`friend:${id}`);
    await idb.set('friendIds', [...friends.keys()]);
    if (overlay && overlay.id === id) clearFriendOverlay();
    friendsChanged();
  }

  function friendsChanged() {
    communityCache = null;
    if (overlay && friends.has(overlay.id)) overlay = friends.get(overlay.id);
    S.render();
    loadCheckinMarkers();
    if (!$('communitySheet').hidden) renderCommunity();
  }

  // ---------- community sheet ----------

  let tab = loadJSON(TAB_KEY, 'feed');

  $('btnCommunity').addEventListener('click', () => {
    renderCommunity();
    S.openSheet('communitySheet');
  });
  $('btnCommunityClose').addEventListener('click', S.closeSheet);

  function renderCommunity() {
    if (!me) return renderNameSetup();
    const tabs = [['feed', 'Feed'], ['friends', 'Friends'], ['ranks', 'Ranks'], ['challenges', 'Challenges'], ['me', 'Me']];
    fill($('communityTabs'), tabs.map(([key, label]) => h('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(key === tab),
      onclick: () => { tab = key; saveJSON(TAB_KEY, tab); renderCommunity(); },
    }, label)));
    $('communityTabs').hidden = false;
    const panel = h('div', {});
    fill($('communityBody'), panel);
    const render = { feed: renderFeed, friends: renderFriends, ranks: renderRanks, challenges: renderChallenges, me: renderMe }[tab] || renderFeed;
    try {
      render(panel);
    } catch (err) {
      fill(panel, h('p', { class: 'fine' }, `Something went wrong: ${err.message}`));
    }
  }

  function renderNameSetup() {
    $('communityTabs').hidden = true;
    const name = h('input', { placeholder: 'Your name', maxlength: '40', required: true, autocomplete: 'nickname' });
    fill($('communityBody'), h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        me = { id: newId(), name: name.value.trim() };
        saveJSON(ME_KEY, me);
        tab = 'friends';
        renderCommunity();
      },
    },
    h('p', {}, 'Walk with friends: compare maps, check in at places, earn badges and race in challenges.'),
    h('p', { class: 'fine' }, 'There are no accounts and no servers. You and your friends swap Scoop files through ' +
      'WhatsApp, email or any app in the share sheet. A Scoop file holds your hexes, walk totals and check-ins — ' +
      'never your GPS tracks, and nothing inside your privacy zones.'),
    h('label', { class: 'field' }, h('span', {}, 'What should friends call you?'), name),
    h('button', { class: 'primary', type: 'submit' }, 'Continue')));
  }

  function sharePrompt(text) {
    return h('div', { class: 'invite' },
      h('div', {}, h('small', {}, text)),
      h('button', { class: 'primary', onclick: shareMyFile }, 'Share my Scoop file'));
  }

  // ---------- feed ----------

  async function photoUrl(id) {
    const blob = await idb.get(`photo:${id}`);
    return blob ? URL.createObjectURL(blob) : null;
  }

  function renderFeed(panel) {
    const everyone = people();
    const verified = core.meetupVerifier(everyone);
    const since = Date.now() - 60 * core.DAY;
    const items = [];
    for (const p of everyone) {
      for (const w of p.walks) if (w.start >= since) items.push({ type: 'walk', at: w.start, p, w });
      for (const c of p.checkins) if (c.time >= since) items.push({ type: 'checkin', at: c.time, p, c });
    }
    items.sort((a, b) => b.at - a.at);
    const list = h('ul', { class: 'list' });
    const more = h('button', { class: 'link', hidden: true }, 'Show more');
    let shown = 0;
    const page = () => {
      for (const item of items.slice(shown, shown + 30)) list.append(feedItem(item, verified));
      shown += 30;
      more.hidden = shown >= items.length;
    };
    more.addEventListener('click', page);
    page();
    fill(panel,
      friends.size ? null : sharePrompt('Add friends by swapping Scoop files — then their walks and check-ins show up here.'),
      items.length ? list : h('p', { class: 'fine' }, 'Nothing in the last 60 days yet. Go for a walk!'),
      more,
      friends.size ? h('p', { class: 'fine' }, 'Friends\' activity is as of the last Scoop file they sent you.') : null);
  }

  function feedItem({ type, at, p, w, c }, verified) {
    const who = h('b', {}, p.me ? 'You' : p.name);
    const when = h('time', {}, core.timeAgo(at));
    if (type === 'walk') {
      return h('li', { class: 'feed-item' }, who, ` walked ${fmtKm(w.km)} km`,
        w.newCells ? ` · ${w.newCells} new hex${w.newCells === 1 ? '' : 'es'}` : '', ' ', when);
    }
    const kind = core.CHECKIN_KINDS[c.kind];
    const what = c.kind === 'meetup'
      ? (verified(p, c) ? ' met up with a friend' : ' checked in for a meetup (not matched yet)')
      : ` checked in · ${kind.label.toLowerCase()}`;
    const img = p.me && c.photo ? h('img', { class: 'photo', alt: c.note || 'Check-in photo', hidden: true }) : null;
    if (img) photoUrl(c.id).then((url) => { if (url) { img.src = url; img.hidden = false; } }).catch(() => {});
    return h('li', { class: 'feed-item' },
      h('div', {}, `${kind.icon} `, who, what, ' ', when),
      c.note ? h('div', { class: 'note' }, c.note) : null,
      img,
      h('button', { class: 'link', onclick: () => { S.closeSheet(); map.setView(h3.cellToLatLng(c.cell), 17); } }, 'Show on map'));
  }

  // ---------- friends, map overlay and compare ----------

  function renderFriends(panel) {
    const list = [...friends.values()].sort((a, b) => a.name.localeCompare(b.name));
    fill(panel,
      sharePrompt('Send your Scoop file to friends. Send a new one whenever you want them to see your latest walks.'),
      h('button', { class: 'wide-btn', onclick: () => friendFileInput.click() }, 'Add a friend\'s Scoop file…'),
      h('p', { class: 'fine' }, 'Got a file in WhatsApp or email? Save it to your phone, then add it here. ' +
        'Adding a newer file from the same friend updates them.'),
      h('h3', {}, `Friends (${list.length})`),
      list.length
        ? h('ul', { class: 'list' }, list.map((p) => {
          const showing = overlay && overlay.id === p.id;
          return h('li', { class: 'person' },
            h('span', {}, h('b', {}, p.name),
              h('small', {}, ` ${p.cells.size.toLocaleString()} hexes · file from ${core.timeAgo(p.exported)}`)),
            h('button', {
              class: 'chip', 'aria-pressed': String(showing),
              onclick: () => { if (showing) clearFriendOverlay(); else showFriendOverlay(p); renderCommunity(); },
            }, showing ? 'Hide' : 'Compare'),
            h('button', {
              class: 'link danger',
              onclick: () => { if (confirm(`Remove ${p.name} and their data from this phone?`)) removeFriend(p.id).catch(fail); },
            }, 'Remove'));
        }))
        : h('p', { class: 'fine' }, 'No friends yet.'),
      h('h3', {}, 'Map layers'),
      h('label', { class: 'row' },
        h('span', {}, 'Community map', h('small', {}, 'Blocks explored by you and your friends. Tap a block to see who got there first.')),
        h('input', { type: 'checkbox', checked: communityOn, onchange: (e) => { communityOn = e.target.checked; S.render(); } })),
    );
  }

  map.createPane('friends').style.zIndex = '425';
  const friendLayer = L.layerGroup([], { pane: 'friends' }).addTo(map);
  /** The friend whose map is drawn over yours, or null. */
  let overlay = null;

  function showFriendOverlay(p) {
    overlay = p;
    S.closeSheet();
    S.render();
  }

  function clearFriendOverlay() {
    overlay = null;
    friendLayer.clearLayers();
    $('compareBar').hidden = true;
    document.body.classList.remove('comparing');
  }
  $('btnCompareClose').addEventListener('click', clearFriendOverlay);

  function drawFriendOverlay(myDisplay) {
    friendLayer.clearLayers();
    if (!overlay) return;
    const theirs = new Set([...overlay.cells.keys()].map(S.toDisplay));
    const bounds = map.getBounds().pad(0.5);
    const draw = [...theirs].filter((c) => bounds.contains(h3.cellToLatLng(c)));
    if (draw.length) {
      L.polygon(h3.cellsToMultiPolygon(draw, false), {
        pane: 'friends', color: FRIEND_COLOR, weight: 2, opacity: 0.95,
        fillColor: FRIEND_COLOR, fillOpacity: 0.16, interactive: false,
      }).addTo(friendLayer);
    }
    const cmp = core.compare(myDisplay, theirs);
    fill($('compareText'),
      h('b', {}, overlay.name), ` · ${cmp.both.toLocaleString()} shared · `,
      h('span', { class: 'you' }, `${cmp.onlyMine.toLocaleString()} only you`), ' · ',
      h('span', { class: 'them' }, `${cmp.onlyTheirs.toLocaleString()} only them`));
    $('compareBar').hidden = false;
    document.body.classList.add('comparing');
  }

  // ---------- community map (you + friends) ----------

  map.createPane('community').style.zIndex = '402';
  const communityLayer = L.layerGroup([], { pane: 'community' }).addTo(map);
  let communityOn = false;
  /** @type {Map<string, {explorers:number, first:string, firstAt:number}>|null} block -> stats */
  let communityCache = null;

  function communityCells() {
    if (communityCache) return communityCache;
    const blocks = new Map();
    for (const p of people()) {
      const firstIn = new Map();
      for (const [c, { t }] of p.cells) {
        const b = h3.cellToParent(c, 9);
        if (!firstIn.has(b) || t < firstIn.get(b)) firstIn.set(b, t);
      }
      for (const [b, t] of firstIn) {
        const s = blocks.get(b) || { explorers: 0, first: '', firstAt: Infinity };
        s.explorers++;
        if (t < s.firstAt) { s.firstAt = t; s.first = p.me ? 'You' : p.name; }
        blocks.set(b, s);
      }
    }
    communityCache = blocks;
    return blocks;
  }
  document.addEventListener('scoop:changed', () => { communityCache = null; });

  function drawCommunity() {
    communityLayer.clearLayers();
    if (!communityOn || map.getZoom() < 12) return;
    const bounds = map.getBounds().pad(0.3);
    for (const [cell, s] of communityCells()) {
      if (!bounds.contains(h3.cellToLatLng(cell))) continue;
      L.polygon(h3.cellToBoundary(cell), {
        pane: 'community', stroke: false, interactive: false,
        fillColor: COMMUNITY_COLOR, fillOpacity: Math.min(0.15 + 0.12 * s.explorers, 0.65),
      }).addTo(communityLayer);
    }
  }

  map.on('click', (e) => {
    if (!communityOn) return;
    const s = communityCells().get(h3.latLngToCell(e.latlng.lat, e.latlng.lng, 9));
    if (!s) return;
    L.popup().setLatLng(e.latlng).setContent(h('div', {},
      h('b', {}, `${s.explorers} explorer${s.explorers === 1 ? '' : 's'}`), h('br'),
      `First here: ${s.first} (${new Date(s.firstAt).toLocaleDateString()})`)).openOn(map);
  });

  document.addEventListener('scoop:render', (e) => {
    drawFriendOverlay(e.detail.display);
    drawCommunity();
  });

  // ---------- leaderboard ----------

  const rankPrefs = loadJSON(RANKS_KEY, { period: 'week', metric: 'score' });

  function renderRanks(panel) {
    const select = (key, options) => h('select', {
      'aria-label': key,
      onchange: (e) => { rankPrefs[key] = e.target.value; saveJSON(RANKS_KEY, rankPrefs); renderCommunity(); },
    }, options.map(([v, label]) => h('option', { value: v, selected: rankPrefs[key] === v }, label)));
    const everyone = people();
    const verified = core.meetupVerifier(everyone);
    const since = rankPrefs.period === 'week' ? core.weekStart() : null;
    const rows = core.rank(everyone.map((p) => ({
      p, name: p.me ? `${p.name} (you)` : p.name, value: core.stats(p, { since, verified })[rankPrefs.metric],
    })));
    fill(panel,
      h('div', { class: 'filters' },
        select('period', [['week', 'This week'], ['all', 'All time']]),
        select('metric', [['score', 'Score'], ['hexes', 'New hexes'], ['km', 'Distance']])),
      h('ol', { class: 'list ranks' }, rows.map((r) => h('li', { class: r.p.me ? 'me' : '' },
        h('span', { class: 'rank' }, String(r.rank)),
        h('span', { class: 'who' }, r.name),
        h('span', { class: 'val' }, fmtVal(r.value, rankPrefs.metric))))),
      friends.size ? null : sharePrompt('Swap Scoop files with friends to compete with them here.'),
      h('p', { class: 'fine' },
        'Score: 1 point per new street hex, bonus points for hexes you keep returning to (all-time only), ' +
        'plus check-ins — photo 3, coffee or food 2, meeting a friend 5. Friends count as of their last Scoop file.'),
    );
  }

  // ---------- challenges ----------

  map.createPane('challenge').style.zIndex = '403';
  const challengeLayer = L.layerGroup([], { pane: 'challenge' }).addTo(map);
  let openChallenge = null;
  let creatingChallenge = false;

  function challengeStatus(c) {
    const now = Date.now();
    if (c.end < now) return 'Finished';
    if (c.start > now) return 'Not started';
    const days = Math.ceil((c.end - now) / core.DAY);
    return `${days} day${days === 1 ? '' : 's'} left`;
  }

  function renderChallenges(panel) {
    if (creatingChallenge) return renderNewChallenge(panel);
    const c = openChallenge && challenges.find((x) => x.id === openChallenge);
    if (c) return renderChallengeDetail(panel, c);
    const list = [...challenges].sort((a, b) => b.end - a.end);
    const setStatus = (ch, status) => () => {
      if (status) ch.status = status;
      else challenges = challenges.filter((x) => x !== ch);
      saveChallenges();
      renderCommunity();
    };
    fill(panel,
      h('button', { class: 'primary', onclick: () => { creatingChallenge = true; renderCommunity(); } }, 'New challenge'),
      list.length
        ? h('ul', { class: 'list' }, list.map((ch) => h('li', { class: 'person' },
          h('span', {}, h('b', {}, ch.title),
            h('small', {}, ` ${core.METRICS[ch.metric]} · ${challengeStatus(ch)}` +
              (ch.status === 'invited' ? ` · from ${ch.names[ch.creator] || nameOf(ch.creator) || 'a friend'}` : ''))),
          ch.status === 'invited' ? h('button', { class: 'chip', onclick: setStatus(ch, 'joined') }, 'Join') : null,
          ch.status === 'invited'
            ? h('button', { class: 'link', onclick: setStatus(ch, null) }, 'Decline')
            : h('button', { class: 'link', onclick: () => { openChallenge = ch.id; renderCommunity(); } }, 'Open'))))
        : h('p', { class: 'fine' }, 'Race your friends: most new hexes, distance or score in a set time — optionally in one part of town.'),
    );
  }

  function renderChallengeDetail(panel, c) {
    const everyone = people();
    const verified = core.meetupVerifier(everyone);
    const byId = new Map(everyone.map((p) => [p.id, p]));
    const until = Math.min(c.end, Date.now());
    const scored = [];
    const waiting = [];
    for (const id of c.members) {
      const p = byId.get(id);
      if (!p) { waiting.push(c.names[id] || 'a friend'); continue; }
      const value = c.start > Date.now() ? 0
        : core.stats(p, { since: c.start, until, area: c.area, parent8, verified })[c.metric];
      scored.push({ p, name: p.me ? `${p.name} (you)` : p.name, value });
    }
    challengeLayer.clearLayers();
    fill(panel,
      h('button', { class: 'link', onclick: () => { openChallenge = null; challengeLayer.clearLayers(); renderCommunity(); } }, '‹ All challenges'),
      h('h3', {}, c.title),
      h('p', { class: 'fine' }, `${core.METRICS[c.metric]} · ${new Date(c.start).toLocaleDateString()} – ${new Date(c.end).toLocaleDateString()} · ${challengeStatus(c)}`,
        c.area ? ' · limited to an area' : ''),
      h('ol', { class: 'list ranks' }, core.rank(scored).map((r) => h('li', { class: r.p.me ? 'me' : '' },
        h('span', { class: 'rank' }, String(r.rank)),
        h('span', { class: 'who' }, r.name),
        h('span', { class: 'val' }, fmtVal(r.value, c.metric))))),
      waiting.length ? h('p', { class: 'fine' }, `Waiting for a Scoop file from: ${waiting.join(', ')}`) : null,
      sharePrompt('Everyone sees standings from the files they have. Send your Scoop file so friends get the challenge and your latest score.'),
      c.area ? h('button', {
        class: 'wide-btn',
        onclick: () => {
          const area = L.polygon(h3.cellsToMultiPolygon(c.area, false), {
            pane: 'challenge', color: COMMUNITY_COLOR, weight: 3, dashArray: '8 6', fillOpacity: 0.05, interactive: false,
          }).addTo(challengeLayer);
          S.closeSheet();
          map.fitBounds(area.getBounds(), { padding: [30, 30] });
        },
      }, 'Show area on map') : null,
      h('button', {
        class: 'link danger',
        onclick: () => {
          if (!confirm(c.creator === me.id ? 'Delete this challenge?' : 'Leave this challenge?')) return;
          challenges = challenges.filter((x) => x.id !== c.id);
          saveChallenges();
          openChallenge = null;
          renderCommunity();
        },
      }, c.creator === me.id ? 'Delete challenge' : 'Leave challenge'),
    );
  }

  function renderNewChallenge(panel) {
    const list = [...friends.values()];
    const title = h('input', { placeholder: 'Weekend hex hunt', maxlength: '60', required: true });
    const metric = h('select', {}, [['hexes', 'Most new hexes'], ['km', 'Longest distance'], ['score', 'Highest score']]
      .map(([v, l]) => h('option', { value: v }, l)));
    const days = h('select', {}, [1, 3, 7, 14, 30].map((d) => h('option', { value: String(d), selected: d === 7 }, `${d} day${d === 1 ? '' : 's'}`)));
    const area = h('input', { type: 'checkbox' });
    const picks = list.map((p) => ({ p, box: h('input', { type: 'checkbox', checked: true }) }));
    fill(panel, h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        let areaCells = null;
        if (area.checked) {
          const b = map.getBounds();
          areaCells = h3.polygonToCells([
            [b.getSouth(), b.getWest()], [b.getNorth(), b.getWest()],
            [b.getNorth(), b.getEast()], [b.getSouth(), b.getEast()],
          ], 8, false);
          if (!areaCells.length || areaCells.length > 400) return toast('Zoom the map to the area you want first');
        }
        const start = Date.now();
        const members = [me.id, ...picks.filter((x) => x.box.checked).map((x) => x.p.id)];
        const c = {
          id: newId(), creator: me.id, title: title.value.trim(), metric: metric.value,
          start, end: start + Number(days.value) * core.DAY, area: areaCells, members,
          names: Object.fromEntries(members.map((m) => [m, nameOf(m)])), status: 'joined',
        };
        challenges.push(c);
        saveChallenges();
        creatingChallenge = false;
        openChallenge = c.id;
        renderCommunity();
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Name'), title),
    h('label', { class: 'row' }, h('span', {}, 'Goal'), metric),
    h('label', { class: 'row' }, h('span', {}, 'Length'), days),
    h('label', { class: 'row' }, h('span', {}, 'Only count hexes in the area on the map now', h('small', {}, 'Distance counts everywhere')), area),
    h('h3', {}, 'Invite'),
    picks.length
      ? picks.map((x) => h('label', { class: 'row' }, h('span', {}, x.p.name), x.box))
      : h('p', { class: 'fine' }, 'Add friends first to race them — or race yourself.'),
    h('button', { class: 'primary', type: 'submit' }, 'Start challenge'),
    h('button', { class: 'link', type: 'button', onclick: () => { creatingChallenge = false; renderCommunity(); } }, 'Cancel')));
  }

  // ---------- me: name, score, streak, badges ----------

  function renderMe(panel) {
    const p = myPerson();
    const verified = core.meetupVerifier(people());
    const earned = core.badges(p, verified);
    const all = core.stats(p, { verified });
    const streak = core.streaks(S.walks.map((w) => w.start));
    const name = h('input', { value: me.name, maxlength: '40', required: true });
    fill(panel,
      h('div', { class: 'me-stats' },
        h('div', {}, h('b', {}, all.score.toLocaleString()), h('small', {}, 'score')),
        h('div', {}, h('b', {}, `${streak.current}🔥`), h('small', {}, 'day streak')),
        h('div', {}, h('b', {}, String(streak.longest)), h('small', {}, 'best streak')),
        h('div', {}, h('b', {}, `${earned.size}/${Object.keys(core.BADGES).length}`), h('small', {}, 'badges'))),
      h('p', { class: 'fine' }, `Score: ${all.hexes.toLocaleString()} hexes + ${all.repeat.toLocaleString()} for repeat visits + ${all.checkinPts.toLocaleString()} from check-ins.`),
      h('h3', {}, 'Badges'),
      h('ul', { class: 'badges' }, Object.entries(core.BADGES).map(([key, b]) => h('li', {
        class: earned.has(key) ? 'earned' : '', title: b.desc,
      }, h('span', { class: 'icon' }, b.icon), h('span', {}, b.label), h('small', {}, b.desc)))),
      h('h3', {}, 'Your name'),
      h('form', {
        class: 'inline',
        onsubmit: (e) => {
          e.preventDefault();
          if (!name.value.trim()) return;
          me.name = name.value.trim();
          saveJSON(ME_KEY, me);
          toast('Saved — friends see it in your next Scoop file');
        },
      }, name, h('button', { type: 'submit' }, 'Save')),
      sharePrompt('Export backup (in the menu) includes your check-ins and name. Friends\' files aren\'t backed up — ask them to resend.'),
    );
  }

  // ---------- check-ins ----------

  const checkinLayer = L.layerGroup().addTo(map);

  function loadCheckinMarkers() {
    checkinLayer.clearLayers();
    const since = Date.now() - 30 * core.DAY;
    for (const p of people()) {
      for (const c of p.checkins) {
        if (c.time < since) continue;
        const kind = core.CHECKIN_KINDS[c.kind];
        L.marker(h3.cellToLatLng(c.cell), {
          icon: L.divIcon({ className: `checkin-pin${p.me ? ' mine' : ''}`, html: kind.icon, iconSize: [30, 30] }),
          title: `${p.me ? 'You' : p.name}: ${kind.label}`,
        }).bindPopup(() => {
          const img = h('img', { class: 'popup-photo', alt: '', hidden: true });
          if (p.me && c.photo) photoUrl(c.id).then((url) => { if (url) { img.src = url; img.hidden = false; } }).catch(() => {});
          return h('div', {},
            h('b', {}, p.me ? 'You' : p.name), ` · ${kind.label}`, h('br'),
            c.note ? [c.note, h('br')] : null,
            h('small', {}, core.timeAgo(c.time)), img);
        }).addTo(checkinLayer);
      }
    }
    toggleCheckinMarkers();
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
    if (!cell) return fill(body, h('p', {}, 'Waiting for your location…'));
    if (!S.visited.has(cell)) {
      return fill(body, h('p', {}, 'Walk through this hex first — you can only check in where you\'ve explored.'));
    }
    const note = h('input', { placeholder: 'Add a note (optional)', maxlength: '140' });
    const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    const photoHint = h('small', {});
    const kinds = h('div', { class: 'kinds', role: 'radiogroup' });
    const drawKinds = () => {
      fill(kinds, Object.entries(core.CHECKIN_KINDS).map(([key, k]) => h('button', {
        type: 'button', class: 'kind', role: 'radio', 'aria-checked': String(key === checkinKind),
        onclick: () => { checkinKind = key; drawKinds(); },
      }, h('span', { class: 'icon' }, k.icon), k.label, h('small', {}, `+${k.points}`))));
      photoHint.textContent = checkinKind === 'photo' ? 'Required' : 'Optional';
      if (checkinKind === 'meetup') photoHint.textContent += ' — the meetup counts once a friend\'s Scoop file shows them checking in here within 30 minutes';
    };
    drawKinds();
    const submit = h('button', { class: 'primary', type: 'submit' }, 'Check in');
    fill(body,
      isHidden(cell) ? h('p', { class: 'fine' }, 'This hex is inside a privacy zone: the check-in stays on this phone and isn\'t put in your Scoop file.') : null,
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          const file = photo.files[0];
          if (checkinKind === 'photo' && !file) return toast('Add a photo first');
          const now = Date.now();
          if (checkins.some((c) => c.cell === cell && c.kind === checkinKind && localDay(c.time) === localDay(now))) {
            return toast('You already checked in like that here today');
          }
          submit.disabled = true;
          try {
            const c = { id: newId(), cell, kind: checkinKind, time: now, note: note.value.trim(), photo: false };
            if (file) {
              await idb.set(`photo:${c.id}`, await compressPhoto(file));
              c.photo = true;
            }
            checkins.push(c);
            if (!saveCheckins()) {
              checkins.pop();
              return;
            }
            S.closeSheet();
            const k = core.CHECKIN_KINDS[checkinKind];
            const verified = core.meetupVerifier(people());
            if (checkinKind !== 'meetup') toast(`${k.icon} Checked in · +${k.points} points`);
            else toast(verified(myPerson(), c) ? '🤝 Meetup matched · +5 points' : '🤝 Checked in — it counts once your friend\'s file shows them here too');
            loadCheckinMarkers();
          } catch (err) {
            fail(err);
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

  /** Downscale to at most 1280 px and re-encode as JPEG (also drops EXIF location). */
  async function compressPhoto(file) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  }

  // ---------- boot ----------

  loadCheckinMarkers();
  loadFriends();

  // Exposed for debugging and end-to-end tests.
  window.scoopSocial = {
    friends, shareMyFile,
    get me() { return me; }, get checkins() { return checkins; }, get challenges() { return challenges; },
  };
})();
