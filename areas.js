/* Scoop official areas: tags each street hex with the country, city and
 * district it's in, using OpenStreetMap's administrative boundaries. The
 * boundaries are never drawn; they're only used to give each area its own
 * scores and leaderboards (see social.js).
 *
 * Lookups go to the Overpass API only when the community features need them
 * (signed in), and only for hexes no cached boundary covers: Overpass is asked
 * which areas contain one point (rounded to ~10 m), then the smallest area's
 * outline is downloaded once, simplified and kept on the device. Every later
 * hex inside it is tagged without any network request.
 */
(() => {
  'use strict';

  const core = window.ScoopCore;
  if (!core || !window.h3) return;

  const KEY = 'scoop.areas.v1';
  const OVERPASS = (window.SCOOP_CONFIG || {}).overpassUrl || 'https://overpass-api.de/api/interpreter';
  const SIMPLIFY_DEG = 0.00008;   // ~9 m
  const REQUEST_GAP_MS = 1100;    // be gentle with the free Overpass servers
  const MAX_REQUESTS = 12;        // per resolve() call; the rest waits for the next sync
  const COARSE_RES = 7;           // country-only places are cached per ~5 km² cell

  /**
   * areas: id -> { name, level, kind: 'country' | 'city' | 'district' }
   * combos: ['country|city|district', …]; cells and coarse map to an index.
   * shapes: [{ id, combo, box, ways }]; noShape: ids whose outline couldn't be used
   */
  const empty = () => ({ v: 1, areas: {}, combos: [], cells: {}, coarse: {}, shapes: [], noShape: {} });
  let db = load();

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.v === 1) return Object.assign(empty(), d);
    } catch (e) {
      // start over
    }
    return empty();
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(db));
      } catch (e) {
        // Storage full: lookups just happen again next time.
      }
    }, 500);
  }

  function comboIndex(combo) {
    let i = db.combos.indexOf(combo);
    if (i < 0) {
      db.combos.push(combo);
      i = db.combos.length - 1;
    }
    return i;
  }

  /** { country, city, district } ids for a hex, or null if not known yet. */
  function of(cell) {
    const i = db.cells[cell];
    if (i === undefined) return null;
    const [country, city, district] = db.combos[i].split('|');
    return { country: country || null, city: city || null, district: district || null };
  }

  /** Tag a hex from cached outlines. True if it worked. */
  function lookupLocal(cell) {
    if (db.cells[cell] !== undefined) return true;
    const [lat, lng] = h3.cellToLatLng(cell);
    for (const s of db.shapes) {
      const b = s.box;
      if (lat < b[0] || lat > b[2] || lng < b[1] || lng > b[3]) continue;
      if (core.inWays(lat, lng, s.ways)) {
        db.cells[cell] = s.combo;
        return true;
      }
    }
    const coarse = db.coarse[h3.cellToParent(cell, COARSE_RES)];
    if (coarse !== undefined) {
      db.cells[cell] = coarse;
      return true;
    }
    return false;
  }

  async function overpass(query) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`Area lookup failed (${res.status})`);
    return res.json();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Ask Overpass which areas contain this hex, then cache the smallest one's outline. */
  async function lookupRemote(cell) {
    const [lat, lng] = h3.cellToLatLng(cell).map((x) => Math.round(x * 1e4) / 1e4);
    const found = await overpass(
      `[out:json][timeout:25];is_in(${lat},${lng})->.a;rel(pivot.a)["boundary"="administrative"]["admin_level"];out tags;`);
    const picked = core.pickAreas(found.elements || []);
    for (const kind of ['country', 'city', 'district']) {
      const a = picked[kind];
      if (a) db.areas[a.id] = { name: a.name, level: a.level, kind };
    }
    const combo = comboIndex([picked.country, picked.city, picked.district].map((a) => (a ? a.id : '')).join('|'));
    // The point lookup is authoritative for this hex, even if a simplified
    // outline we already have says otherwise (right on a border).
    db.cells[cell] = combo;
    const smallest = picked.district || picked.city;
    if (!smallest) {
      db.coarse[h3.cellToParent(cell, COARSE_RES)] = combo;
      return;
    }
    if (db.shapes.some((s) => s.id === smallest.id)) return;
    if (db.noShape[smallest.id]) {
      db.coarse[h3.cellToParent(cell, 8)] = combo;
      return;
    }
    await sleep(REQUEST_GAP_MS);
    try {
      const geo = await overpass(`[out:json][timeout:60];rel(${smallest.id.slice(1)});out geom;`);
      const rel = (geo.elements || [])[0];
      const ways = ((rel && rel.members) || [])
        .filter((m) => m.type === 'way' && Array.isArray(m.geometry))
        .map((m) => core.simplifyLine(m.geometry.map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5)]), SIMPLIFY_DEG));
      if (!ways.length) throw new Error('no outline');
      db.shapes.push({ id: smallest.id, combo, box: core.waysBox(ways), ways });
    } catch (e) {
      // Outline too big or missing: tag nearby hexes (~0.7 km²) from this lookup instead.
      if (e.message === 'no outline') db.noShape[smallest.id] = true;
      db.coarse[h3.cellToParent(cell, 8)] = combo;
    }
  }

  let running = null;

  /**
   * Tag as many of these hexes as possible. Resolves when done or when it gave
   * up for now (offline, or too many lookups in one go); call again later.
   * Returns how many hexes are still untagged.
   */
  function resolve(cells) {
    if (running) return running;
    running = (async () => {
      let todo = [...cells].filter((c) => !lookupLocal(c));
      let requests = 0;
      try {
        while (todo.length && requests < MAX_REQUESTS && navigator.onLine !== false) {
          if (requests) await sleep(REQUEST_GAP_MS);
          requests++;
          await lookupRemote(todo[0]);
          todo = todo.filter((c) => !lookupLocal(c));
        }
      } catch (e) {
        // Try again on the next sync.
      } finally {
        save();
        running = null;
      }
      return todo.length;
    })();
    return running;
  }

  /** Names for area ids we know about. */
  function info(id) {
    return db.areas[id] || null;
  }

  function clear() {
    db = empty();
    save();
  }

  window.scoopAreas = { of, resolve, info, clear, all: () => db.areas };
})();
