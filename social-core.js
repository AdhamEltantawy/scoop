/* Scoop community: pure helpers shared by social.js and the unit tests
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

  /**
   * Cells that changed since the last sync, in the shape sync_cells() takes.
   * synced: { cell: visitsAlreadyUploaded }.
   */
  function syncDelta(visited, visitCount, synced, isHidden) {
    const out = [];
    for (const [c, t] of visited) {
      if (isHidden(c)) continue;
      const v = visitCount(c);
      if (synced[c] !== v) out.push({ c, t, v });
    }
    return out;
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
    CHECKIN_KINDS, BADGES, KUDOS,
    checkinPoints, regularBonus, streaks, compare, zoneFilter, syncDelta, chunk, validUsername, timeAgo, parseInvite,
  };
});
