/* Scoop community: pure helpers shared by social.js and the unit tests
 * (tests/social-core.test.mjs). No DOM, no storage, no network.
 *
 * Everything social is computed on the device. Friends swap "Scoop files"
 * (see makeFriendFile / parseFriendFile), and scores, badges, verified
 * meetups and challenge standings are worked out from whatever files you have.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScoopCore = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const DAY = 86400000;
  const MEETUP_WINDOW_MS = 30 * 60000;
  const FILE_APP = 'scoop-friend';

  const CHECKIN_KINDS = {
    photo: { icon: '📷', label: 'Photo', points: 3 },
    coffee: { icon: '☕', label: 'Coffee', points: 2 },
    food: { icon: '🍽️', label: 'Food', points: 2 },
    meetup: { icon: '🤝', label: 'Meet a friend', points: 5 },
  };

  const BADGES = {
    first_walk: { icon: '👟', label: 'First steps', desc: 'Record your first walk' },
    hex_100: { icon: '⬡', label: 'Explorer', desc: '100 street hexes' },
    hex_1000: { icon: '🗺️', label: 'Cartographer', desc: '1,000 street hexes' },
    hex_10000: { icon: '🌍', label: 'Pathfinder', desc: '10,000 street hexes' },
    marathon: { icon: '🏅', label: 'Marathon', desc: 'Walk 42.2 km in total' },
    km_500: { icon: '🚶', label: 'Long haul', desc: 'Walk 500 km in total' },
    streak_7: { icon: '🔥', label: 'On a roll', desc: 'Walk 7 days in a row' },
    streak_30: { icon: '🌋', label: 'Unstoppable', desc: 'Walk 30 days in a row' },
    regular: { icon: '🏠', label: 'Regular', desc: 'Walk through one hex 10 times' },
    first_meetup: { icon: '🤝', label: 'Meet-up', desc: 'Check in with a friend' },
    coffee_10: { icon: '☕', label: 'Coffee crawl', desc: '10 coffee check-ins' },
    photo_10: { icon: '📷', label: 'Photographer', desc: '10 photo check-ins' },
  };

  const METRICS = { score: 'pts', hexes: 'hexes', km: 'km' };

  function checkinPoints(kind, verified) {
    if (kind === 'meetup') return verified ? CHECKIN_KINDS.meetup.points : 0;
    return CHECKIN_KINDS[kind] ? CHECKIN_KINDS[kind].points : 0;
  }

  /** Bonus for a hex you keep coming back to: 1 at 2 visits, 2 at 4, 3 at 8… */
  function regularBonus(visits) {
    return visits > 1 ? Math.floor(Math.log2(visits)) : 0;
  }

  /** Current and longest run of consecutive local days with a walk. */
  function streaks(walkStarts, now = Date.now()) {
    const dayOf = (ms) => {
      const d = new Date(ms);
      return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
    };
    const days = [...new Set(walkStarts.map(dayOf))].sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    for (let i = 0; i < days.length; i++) {
      run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    // A streak is still alive if you walked today or yesterday.
    const last = days[days.length - 1];
    const current = last !== undefined && dayOf(now) - last <= 1 ? run : 0;
    return { current, longest };
  }

  /** Monday 00:00 local time of the week containing `now`. */
  function weekStart(now = Date.now()) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }

  /** Overlap between two sets of (display) cells. */
  function compare(mine, theirs) {
    let both = 0;
    for (const c of mine) if (theirs.has(c)) both++;
    return { both, onlyMine: mine.size - both, onlyTheirs: theirs.size - both };
  }

  /**
   * Returns cell => true when the cell's centre is inside a privacy zone.
   * zones: [{ lat, lng, r }] with r in metres.
   */
  function zoneFilter(zones, cellToLatLng, distance) {
    if (!zones || !zones.length) return () => false;
    return (cell) => {
      const [lat, lng] = cellToLatLng(cell);
      return zones.some((z) => distance({ lat, lng }, z) <= z.r);
    };
  }

  function timeAgo(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d} d ago`;
    return new Date(ms).toLocaleDateString();
  }

  // ---------- Scoop files ----------

  /**
   * The file you send to friends. First visits are rounded to the day, so the
   * file doesn't say at what time you were where. Callers drop privacy-zone
   * cells and check-ins before passing them in.
   *   cells: iterable of [cell, firstVisitedMs, visits]
   *   walks: [{ start, end, km, newCells }]
   *   checkins: [{ id, cell, kind, time, note }]
   */
  function makeFriendFile({ me, cells, walks, checkins, challenges, now = Date.now() }) {
    return {
      app: FILE_APP,
      version: 1,
      id: me.id,
      name: me.name,
      exported: now,
      cells: [...cells].map(([c, t, v]) => [c, Math.floor(t / DAY) * DAY, v]),
      walks: walks.map((w) => [w.start, w.end, +(+w.km || 0).toFixed(3), w.newCells || 0]),
      checkins: checkins.map((c) => [c.id, c.cell, c.kind, c.time, c.note || '']),
      challenges: challenges.map((c) => ({
        id: c.id, creator: c.creator, title: c.title, metric: c.metric,
        start: c.start, end: c.end, area: c.area || null, members: c.members, names: c.names,
      })),
    };
  }

  const CELL_RE = /^8a[0-9a-f]{13}$/;
  const AREA_RE = /^88[0-9a-f]{13}$/;
  const ID_RE = /^[0-9a-z-]{8,40}$/i;
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const text = (x, max) => String(x == null ? '' : x).slice(0, max);

  function parseChallenge(c) {
    if (!c || !ID_RE.test(c.id) || !ID_RE.test(c.creator)) return null;
    if (!METRICS[c.metric] || !num(c.start) || !num(c.end) || c.end <= c.start || c.end - c.start > 92 * DAY) return null;
    const members = Array.isArray(c.members) ? c.members.filter((m) => ID_RE.test(m)).slice(0, 50) : [];
    const area = Array.isArray(c.area) ? c.area.filter((a) => AREA_RE.test(a)).slice(0, 400) : null;
    const names = {};
    for (const m of members) if (c.names && c.names[m]) names[m] = text(c.names[m], 40);
    return {
      id: c.id, creator: c.creator, title: text(c.title, 60) || 'Challenge', metric: c.metric,
      start: c.start, end: c.end, area: area && area.length ? area : null, members, names,
    };
  }

  /** Validate a Scoop file and turn it into a person. Throws on anything else. */
  function parseFriendFile(data) {
    if (!data || data.app !== FILE_APP) {
      throw new Error(data && data.app === 'scoop' ? 'That\'s a backup, not a Scoop file' : 'Not a Scoop file');
    }
    if (!ID_RE.test(data.id)) throw new Error('This Scoop file has no valid id');
    const cells = new Map();
    for (const row of Array.isArray(data.cells) ? data.cells.slice(0, 500000) : []) {
      if (!Array.isArray(row) || !CELL_RE.test(row[0]) || !num(row[1])) continue;
      cells.set(row[0], { t: row[1], v: Math.max(1, Math.floor(num(row[2]) ? row[2] : 1)) });
    }
    const walks = [];
    for (const w of Array.isArray(data.walks) ? data.walks.slice(0, 100000) : []) {
      if (!Array.isArray(w) || !num(w[0]) || !num(w[1]) || !num(w[2]) || w[2] < 0 || w[2] > 300) continue;
      walks.push({ start: w[0], end: w[1], km: w[2], newCells: num(w[3]) ? Math.max(0, w[3]) : 0 });
    }
    const checkins = [];
    for (const c of Array.isArray(data.checkins) ? data.checkins.slice(0, 20000) : []) {
      if (!Array.isArray(c) || !CELL_RE.test(c[1]) || !CHECKIN_KINDS[c[2]] || !num(c[3])) continue;
      checkins.push({ id: text(c[0], 40), cell: c[1], kind: c[2], time: c[3], note: text(c[4], 140) });
    }
    const challenges = (Array.isArray(data.challenges) ? data.challenges.slice(0, 50) : [])
      .map(parseChallenge).filter(Boolean);
    return {
      id: data.id,
      name: text(data.name, 40).trim() || 'Friend',
      exported: num(data.exported) ? data.exported : Date.now(),
      cells, walks, checkins, challenges,
    };
  }

  // ---------- scores ----------

  /**
   * Returns (person, checkin) => true when a meetup check-in is matched by
   * someone else's meetup check-in at the same hex within 30 minutes.
   */
  function meetupVerifier(people) {
    const byCell = new Map();
    for (const p of people) {
      for (const c of p.checkins) {
        if (c.kind !== 'meetup') continue;
        if (!byCell.has(c.cell)) byCell.set(c.cell, []);
        byCell.get(c.cell).push({ person: p.id, time: c.time });
      }
    }
    return (person, c) => c.kind === 'meetup' && (byCell.get(c.cell) || [])
      .some((o) => o.person !== person.id && Math.abs(o.time - c.time) <= MEETUP_WINDOW_MS);
  }

  /**
   * Totals for one person between `since` and `until` (null = open), limited to
   * an area of resolution-8 cells when given. Repeat-visit bonuses only count
   * for all-time totals, because visits aren't dated.
   */
  function stats(person, { since = null, until = null, area = null, parent8 = null, verified = () => false } = {}) {
    const inTime = (t) => (since === null || t >= since) && (until === null || t < until);
    const areaSet = area ? new Set(area) : null;
    const inArea = (cell) => !areaSet || areaSet.has(parent8(cell));
    const allTime = since === null && until === null;
    let hexes = 0;
    let repeat = 0;
    for (const [cell, { t, v }] of person.cells) {
      if (!inArea(cell)) continue;
      if (inTime(t)) hexes++;
      if (allTime) repeat += regularBonus(v);
    }
    let checkinPts = 0;
    for (const c of person.checkins) {
      if (inTime(c.time) && inArea(c.cell)) checkinPts += checkinPoints(c.kind, verified(person, c));
    }
    let km = 0;
    for (const w of person.walks) if (inTime(w.start)) km += w.km;
    return { hexes, repeat, checkinPts, km: +km.toFixed(2), score: hexes + repeat + checkinPts };
  }

  function badges(person, verified = () => false) {
    let maxVisits = 0;
    for (const { v } of person.cells.values()) maxVisits = Math.max(maxVisits, v);
    const km = person.walks.reduce((a, w) => a + w.km, 0);
    const count = (kind) => person.checkins.filter((c) => c.kind === kind).length;
    const longest = streaks(person.walks.map((w) => w.start)).longest;
    const n = person.cells.size;
    const earned = {
      first_walk: person.walks.length >= 1,
      hex_100: n >= 100,
      hex_1000: n >= 1000,
      hex_10000: n >= 10000,
      marathon: km >= 42.195,
      km_500: km >= 500,
      streak_7: longest >= 7,
      streak_30: longest >= 30,
      regular: maxVisits >= 10,
      first_meetup: person.checkins.some((c) => verified(person, c)),
      coffee_10: count('coffee') >= 10,
      photo_10: count('photo') >= 10,
    };
    return new Set(Object.keys(earned).filter((k) => earned[k]));
  }

  /** Rank people by a value, ties sharing a rank. */
  function rank(rows) {
    const sorted = [...rows].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    let prev = null;
    let r = 0;
    return sorted.map((row, i) => {
      if (row.value !== prev) r = i + 1;
      prev = row.value;
      return { ...row, rank: r };
    });
  }

  return {
    DAY, CHECKIN_KINDS, BADGES, METRICS, FILE_APP,
    checkinPoints, regularBonus, streaks, weekStart, compare, zoneFilter, timeAgo,
    makeFriendFile, parseFriendFile, meetupVerifier, stats, badges, rank,
  };
});
