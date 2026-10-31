/* Scoop: pure helpers shared by app.js, social.js and the unit tests
 * (tests/social-core.test.mjs). No DOM, no network.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScoopCore = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Keep in sync with checkin_points() in the Supabase migration.
  const CHECKIN_KINDS = {
    photo: { icon: '📷', label: 'Photo', points: 3 },
    coffee: { icon: '☕', label: 'Coffee', points: 2 },
    food: { icon: '🍽️', label: 'Food', points: 2 },
    meetup: { icon: '🤝', label: 'Meet a friend', points: 5 },
  };

  // Keep in sync with award_badges() in the Supabase migration.
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

  const KUDOS = ['👏', '🔥', '❤️', '👣'];

  function checkinPoints(kind, verified) {
    if (kind === 'meetup') return verified ? CHECKIN_KINDS.meetup.points : 0;
    return CHECKIN_KINDS[kind] ? CHECKIN_KINDS[kind].points : 0;
  }

  /** Bonus for a hex you keep coming back to: 1 at 2 visits, 2 at 4, 3 at 8… */
  function regularBonus(visits) {
    return visits > 1 ? Math.floor(Math.log2(visits)) : 0;
  }

  // ---------- heat and hex scores ----------
  // Keep in sync with heat() and hex_value() in the Supabase migration.

  const DAY_MS = 86400000;
  const HALF_LIFE_DAYS = 30;

  /** How warm a hex is: 1 right after a visit, halving every 30 days. 0 if never visited. */
  function heat(lastVisit, now = Date.now()) {
    if (!lastVisit) return 0;
    return Math.pow(0.5, Math.max(0, now - lastVisit) / (HALF_LIFE_DAYS * DAY_MS));
  }

  /** What a fully warm hex is worth: 1, plus the regular bonus for repeat visits. */
  function hexValue(visits) {
    return visits >= 1 ? 1 + regularBonus(visits) : 0;
  }

  function hexScore(visits, lastVisit, now = Date.now()) {
    return hexValue(visits) * heat(lastVisit, now);
  }

  /**
   * Points for walking through a hex at `now`: it's back to full value, so you
   * earn whatever it had cooled off, plus any rise in its regular bonus.
   */
  function visitGain(oldVisits, oldLastVisit, newVisits, now) {
    return Math.max(0, hexValue(newVisits) - hexScore(oldVisits, oldLastVisit, now));
  }

  // ---------- edge band ----------

  // A GPS fix only unlocks a hex when it's inside the hex shrunk around its
  // centre to 90% of the area, so wobble along a street doesn't unlock the
  // hex next door.
  const CORE_SCALE = Math.sqrt(0.9);

  /** Ray casting on [x, y] points. */
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /**
   * True when [lat, lng] is in the core of the hex with this centre and boundary
   * (both [lat, lng]). Uses a local flat projection, fine at hex scale.
   */
  function inCore(lat, lng, centre, boundary, scale = CORE_SCALE) {
    const k = Math.cos((centre[0] * Math.PI) / 180);
    const ring = boundary.map(([la, ln]) => [(ln - centre[1]) * k, la - centre[0]]);
    return inRing(((lng - centre[1]) * k) / scale, (lat - centre[0]) / scale, ring);
  }

  // ---------- official areas (OpenStreetMap admin boundaries) ----------

  const CITY_TAG = /^(city|town|municipality)$/;

  /**
   * Pick country, city and district from the admin boundaries containing a
   * point (Overpass is_in results: [{ id, tags }]). Admin levels mean different
   * things per country, so:
   *  - country: admin_level 2
   *  - city: a level 4–8 boundary tagged as a city/town/municipality (deepest
   *    first), else level 8, else the deepest of levels 4–7
   *  - district: the first level below the city, down to level 10
   * Returns { country, city, district }, each { id: 'r123', name, level } or null.
   */
  function pickAreas(relations) {
    const admin = relations
      .filter((r) => r.tags && r.tags.boundary === 'administrative' && /^\d+$/.test(r.tags.admin_level || ''))
      .map((r) => ({ id: 'r' + r.id, name: r.tags['name:en'] || r.tags.name || `#${r.id}`, level: Number(r.tags.admin_level), tags: r.tags }));
    const pick = (r) => (r ? { id: r.id, name: r.name, level: r.level } : null);
    const country = admin.find((r) => r.level === 2);
    const cityish = admin.filter((r) => r.level >= 4 && r.level <= 8).sort((a, b) => b.level - a.level);
    const city = cityish.find((r) => CITY_TAG.test(r.tags.place || '') || CITY_TAG.test(r.tags.border_type || '')) ||
      cityish.find((r) => r.level === 8) || cityish[0];
    const floor = city ? city.level : 2;
    const district = admin.filter((r) => r.level > floor && r.level <= 10).sort((a, b) => a.level - b.level)[0];
    return { country: pick(country), city: pick(city), district: pick(district) };
  }

  /** Douglas–Peucker on [lat, lng] points; keeps both ends. tol in degrees. */
  function simplifyLine(points, tol) {
    if (points.length <= 2) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ay, ax] = points[a];
      const [by, bx] = points[b];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let worst = -1;
      let at = -1;
      for (let i = a + 1; i < b; i++) {
        const [py, px] = points[i];
        let d;
        if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
        else {
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
        }
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > tol * tol) {
        keep[at] = 1;
        stack.push([a, at], [at, b]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  /**
   * Point in a boundary given as its member ways ([[lat, lng], …] each), in any
   * order. Even–odd crossings over all segments, so the ways don't need to be
   * stitched into rings, and holes and exclaves just work.
   */
  function inWays(lat, lng, ways) {
    let inside = false;
    for (const w of ways) {
      for (let i = 1; i < w.length; i++) {
        const [yi, xi] = w[i];
        const [yj, xj] = w[i - 1];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  /** [south, west, north, east] around a boundary's ways. */
  function waysBox(ways) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const w of ways) {
      for (const [lat, lng] of w) {
        if (lat < box[0]) box[0] = lat;
        if (lng < box[1]) box[1] = lng;
        if (lat > box[2]) box[2] = lat;
        if (lng > box[3]) box[3] = lng;
      }
    }
    return box;
  }

  /** Current and longest run of consecutive local days with a walk. */
  function streaks(walkStarts, now = Date.now()) {
    const dayOf = (ms) => {
      const d = new Date(ms);
      return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    };
    const days = [...new Set(walkStarts.map(dayOf))].sort((a, b) => a - b);
    let longest = 0;
    let run = 0;
    for (let i = 0; i < days.length; i++) {
      run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    // A streak is still alive if you walked today or yesterday.
    const today = dayOf(now);
    const last = days[days.length - 1];
    const current = last !== undefined && today - last <= 1 ? run : 0;
    return { current, longest };
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

  /** What was uploaded for a cell, to spot changes. */
  function cellSig(x) {
    return `${x.v}|${x.l}|${x.a ? x.a.join(',') : ''}`;
  }

  /**
   * Cells that changed since the last sync, in the shape sync_cells() takes:
   * { c, t: first visit, l: last visit, v: visits, a: [country, city, district] | undefined }.
   * synced: { cell: cellSig of what was uploaded }. areaOf(cell) returns the
   * area ids or null when not looked up yet.
   */
  function syncDelta(visited, visitCount, lastSeen, areaOf, synced, isHidden) {
    const out = [];
    for (const [c, t] of visited) {
      if (isHidden(c)) continue;
      const a = areaOf(c);
      const x = { c, t, l: lastSeen.get(c) || t, v: visitCount(c) };
      if (a) x.a = [a.country || '', a.city || '', a.district || ''];
      if (synced[c] !== cellSig(x)) out.push(x);
    }
    return out;
  }

  /** Top x% from a rank among n people, counting from the middle of your place. */
  function topPercent(rank, total) {
    return total > 0 ? Math.round(((rank - 0.5) / total) * 1000) / 10 : 100;
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function validUsername(name) {
    return /^[a-z0-9_]{3,20}$/.test(name);
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

  /** Pull an invite code out of a pasted link or code. */
  function parseInvite(text) {
    const m = String(text || '').match(/(?:invite=)?([0-9a-f]{8})\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  return {
    CHECKIN_KINDS, BADGES, KUDOS, DAY_MS, HALF_LIFE_DAYS, CORE_SCALE,
    checkinPoints, regularBonus, heat, hexValue, hexScore, visitGain, inRing, inCore,
    pickAreas, simplifyLine, inWays, waysBox,
    streaks, compare, zoneFilter, cellSig, syncDelta, topPercent, chunk, validUsername, timeAgo, parseInvite,
  };
});
