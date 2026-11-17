/* Scoop home panel: two reasons to walk, every time you open the app.
 *
 * Signed in, in a known district, the card on top of the map shows your
 * district (how warm it is against its 80% weekly goal, your share, how many
 * neighbours keep it warm) and, if you're in one, your circle (km together
 * against its goal, its streak, the next walk). Switching tabs switches the
 * map's warmth layer. Your own hexes, points and km² move to Me. Signed out
 * or outside a district, the card stays the stats it always was.
 */
(() => {
  'use strict';

  const S = window.scoop;
  const kit = window.scoopKit;
  const core = window.ScoopCore;
  if (!S || !kit || !core || !window.h3) return;

  const { sb, check, h, fill, avatar } = kit;
  const $ = (id) => document.getElementById(id);
  const FACE_KEY = 'scoop.homeFace.v1';
  const WARMTH_REFRESH_MS = 5 * 60000;
  const COOL_NEAR_METERS = 800;
  const DAY = 86400000;

  let face = 'place';
  try { face = localStorage.getItem(FACE_KEY) === 'people' ? 'people' : 'place'; } catch (e) { /* place */ }
  /** district_warmth() for your home district, plus which district it is. */
  let warmth = null;
  let warmthAt = 0;
  let loading = false;

  function homeDistrict() {
    const d = kit.homes.find((a) => a.kind === 'district');
    if (d && d.id && d.name) return { id: d.id, name: d.name };
    const here = kit.hood();
    return here && here.id ? { id: here.id, name: here.name } : null;
  }

  const circles = () => (window.scoopCircles ? window.scoopCircles.circles : []);

  async function loadWarmth(force = false) {
    if (!kit.profile || loading) return;
    const d = homeDistrict();
    if (!d) { render(); return; }
    if (!force && warmth && warmth.district.id === d.id && Date.now() - warmthAt < WARMTH_REFRESH_MS) { render(); return; }
    loading = true;
    try {
      const [r] = check(await sb.rpc('district_warmth', { district: d.id }));
      warmth = { ...r, district: d };
      ['hexes', 'warm', 'pct', 'mine_warm', 'mine_week', 'explorers'].forEach((k) => { warmth[k] = Number(warmth[k]) || 0; });
      warmthAt = Date.now();
    } catch (err) {
      // Offline: keep what we had (or the old stats card).
    } finally {
      loading = false;
    }
    render();
  }

  /** Days until the week's Sunday-night finish. */
  function daysToSunday() {
    const now = new Date();
    const sunday = new Date(now);
    sunday.setDate(now.getDate() + ((7 - now.getDay()) % 7));
    sunday.setHours(23, 59, 0, 0);
    return Math.max(0, Math.ceil((sunday - now) / DAY));
  }

  /** Your hexes near you that are cooling (walked 30–60 days ago). */
  function coolingNear() {
    const pos = S.position();
    if (!pos) return [];
    const now = Date.now();
    const out = [];
    for (const [cell, t] of S.lastSeen) {
      const age = now - t;
      if (age < 30 * DAY || age > 60 * DAY) continue;
      const [lat, lng] = h3.cellToLatLng(cell);
      if (kit.distance(pos.latlng, { lat, lng }) <= COOL_NEAR_METERS) out.push(cell);
    }
    return out;
  }

  function showCells(cells) {
    const pts = cells.map((c) => h3.cellToLatLng(c));
    if (pts.length) S.map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 17 });
  }

  function setFace(f) {
    face = f;
    try { localStorage.setItem(FACE_KEY, f); } catch (e) { /* fine */ }
    // The map follows: the district tab shows everyone's warmth you can see.
    kit.setCommunity(f === 'place');
    render();
  }

  function placeFace(w) {
    const youShare = w.hexes ? Math.round((w.mine_warm / w.hexes) * 100) : 0;
    const others = Math.max(0, w.pct - youShare);
    const isNew = S.walks.length < 3;
    return h('div', { class: 'home-face' },
      h('div', { class: 'home-big' }, h('b', {}, `${w.pct}%`), h('span', {}, `warm · goal ${core.WARMTH_GOAL}% by Sunday`)),
      h('div', { class: 'home-bar', role: 'img', 'aria-label': `${w.pct}% warm, ${youShare}% from you` },
        h('span', { class: 'shared', style: `width:${others}%` }), h('span', { class: 'you', style: `width:${youShare}%` }),
        h('i', { class: 'goal', style: `left:${core.WARMTH_GOAL}%` })),
      h('div', { class: 'home-line' },
        h('span', {}, h('b', {}, `You: ${w.mine_week.toLocaleString()} hex${w.mine_week === 1 ? '' : 'es'} this week`), isNew ? ' · new here' : ''),
        h('span', {}, h('b', {}, w.explorers.toLocaleString()), ` neighbour${w.explorers === 1 ? '' : 's'}`)));
  }

  function peopleFace(c) {
    const done = c.week_km > 0;
    const pct = Math.min(100, (c.week_km / c.goal_km) * 100);
    const weekNo = done ? Math.max(1, c.streak) : c.streak + 1;
    return h('div', { class: 'home-face' },
      h('div', { class: 'home-people' },
        h('span', { class: 'avatars' }, c.members.slice(0, 5).map((m) => avatar(m.name, m.me ? 'me sm' : 'friend sm'))),
        h('span', { class: 'sub' }, done ? `Week ${weekNo} done ✓` : `Week ${weekNo} · nobody’s walked yet`)),
      h('div', { class: 'home-bar', role: 'img', 'aria-label': `${Math.round(pct)}% of the weekly goal` },
        h('span', { class: 'together', style: `width:${pct}%` })),
      h('div', { class: 'home-line' },
        h('span', {}, h('b', {}, `${Math.round(c.week_km * 10) / 10}`), ` of ${c.goal_km} km together`),
        h('span', {}, done ? `Circle streak · ${c.streak} week${c.streak === 1 ? '' : 's'}`
          : c.next ? `First walk · ${new Date(c.next.starts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'No walk booked')));
  }

  /** One line under the panel: something to go and do. */
  function banner(w, c) {
    if (face === 'people' && c) {
      if (!c.next) {
        return bannerRow('🤝', 'Same time next week?', `${core.circleSchedule(c.weekday, c.at_time)} · ${c.meet_label || c.district_name || ''}`,
          'Book', async () => {
            try {
              check(await sb.rpc('book_next', { circle: c.id }));
              await window.scoopCircles.reload();
            } catch (err) {
              kit.fail(err);
            }
          });
      }
      const others = core.whoIsIn(c.next.people, kit.uid());
      return bannerRow('🤝', `${c.name} · ${core.walkWhen(c.next.starts) || new Date(c.next.starts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`,
        others.length ? `${core.nameList(others)} ${others.length === 1 ? 'is' : 'are'} in` : 'Say if you’re coming',
        'Open', () => window.scoopCircles.openIntro());
    }
    const cooling = coolingNear();
    if (cooling.length) {
      return bannerRow('🔥', `${cooling.length} of your hexes near you are cooling`, 'Walk them this week to warm them back up', 'Show', () => showCells(cooling));
    }
    if (w.pct < core.WARMTH_GOAL) {
      const days = daysToSunday();
      return bannerRow('🏁', `${w.district.name} is ${core.WARMTH_GOAL - w.pct} points off its goal`,
        `${days} day${days === 1 ? '' : 's'} left`, null, null);
    }
    return bannerRow('🏁', `${w.district.name} is past its goal`, 'Keep it warm through Sunday night', null, null);
  }

  function bannerRow(icon, title, sub, cta, act) {
    return h('div', { class: 'home-banner' },
      h('span', { class: 'icon', 'aria-hidden': 'true' }, icon),
      h('div', {}, h('b', { dir: 'auto' }, title), sub ? h('small', { dir: 'auto' }, sub) : null),
      cta ? h('button', { class: 'btn sm', onclick: act }, cta) : null);
  }

  function render() {
    const panel = $('homePanel');
    if (!panel) return;
    const w = warmth && kit.profile ? warmth : null;
    document.body.classList.toggle('home-on', !!w);
    if (!w) {
      fill(panel);
      return;
    }
    const c = circles()[0] || null;
    if (face === 'people' && !c) face = 'place';
    const tab = (f, label, cls) => h('button', {
      type: 'button', class: `home-tab ${cls}`, 'aria-pressed': String(face === f), onclick: () => setFace(f),
    }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { dir: 'auto' }, label));
    fill(panel,
      h('div', { class: 'home-tabs', role: 'group', 'aria-label': 'Home' },
        tab('place', w.district.name, 'tab-place'),
        c ? tab('people', c.name, 'tab-people') : null),
      face === 'people' && c ? peopleFace(c) : placeFace(w),
      banner(w, c));
  }

  document.addEventListener('scoop:profile', (e) => {
    if (!e.detail.profile) { warmth = null; render(); return; }
    setTimeout(() => loadWarmth(true), 1500); // after your home district is known
  });
  document.addEventListener('scoop:circles', render);
  document.addEventListener('scoop:walk-stop', () => setTimeout(() => loadWarmth(true), 5000));
  // GPS fixes come every second or so: look again at most once a minute.
  let lastFixLook = 0;
  document.addEventListener('scoop:fix', () => {
    if (Date.now() - lastFixLook < 60000) return;
    lastFixLook = Date.now();
    loadWarmth(false);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadWarmth(false); });
  setInterval(() => { if (!document.hidden) loadWarmth(false); }, WARMTH_REFRESH_MS);
  if (kit.profile) loadWarmth(true);
})();
