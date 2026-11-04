import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../social-core.js');
const h3 = require('../vendor/h3-js.umd.js');

const DAY = 86400000;

test('check-in points match the server', () => {
  assert.equal(core.checkinPoints('photo'), 3);
  assert.equal(core.checkinPoints('coffee'), 2);
  assert.equal(core.checkinPoints('meetup', false), 0);
  assert.equal(core.checkinPoints('meetup', true), 5);
  assert.equal(core.checkinPoints('nope'), 0);
});

test('regular bonus grows with log2 of visits', () => {
  assert.deepEqual([1, 2, 3, 4, 8, 10].map(core.regularBonus), [0, 1, 1, 2, 3, 3]);
});

test('streaks count consecutive days and expire after a missed day', () => {
  const now = new Date(2026, 9, 26, 12).getTime();
  const starts = [now - 5 * DAY, now - 2 * DAY, now - DAY, now - DAY + 3600000, now];
  assert.deepEqual(core.streaks(starts, now), { current: 3, longest: 3 });
  assert.deepEqual(core.streaks(starts, now + 2 * DAY), { current: 0, longest: 3 });
  assert.deepEqual(core.streaks([], now), { current: 0, longest: 0 });
});

test('compare counts overlap', () => {
  assert.deepEqual(core.compare(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd', 'e'])),
    { both: 2, onlyMine: 1, onlyTheirs: 2 });
});

test('privacy zones hide cells near home', () => {
  const home = { lat: 52.52, lng: 13.405 };
  const near = h3.latLngToCell(home.lat, home.lng, 10);
  const far = h3.latLngToCell(52.53, 13.405, 10); // ~1.1 km north
  const dist = (a, b) => h3.greatCircleDistance([a.lat, a.lng], [b.lat, b.lng], 'm');
  const hidden = core.zoneFilter([{ ...home, r: 300 }], h3.cellToLatLng, dist);
  assert.equal(hidden(near), true);
  assert.equal(hidden(far), false);
  assert.equal(core.zoneFilter([], h3.cellToLatLng, dist)(near), false);
});

test('sync delta sends new, revisited and newly tagged cells only', () => {
  const visited = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['home', 5]]);
  const counts = { a: 1, b: 3, c: 1, d: 1, home: 1 };
  const last = new Map([['a', 1], ['b', 20], ['c', 3], ['d', 4]]);
  const areas = { d: { country: 'r1', city: null, district: 'r9' } };
  const synced = { a: '1|1|', b: '2|2|', d: '1|4|' };
  const delta = core.syncDelta(visited, (c) => counts[c], last, (c) => areas[c] || null, synced, (c) => c === 'home');
  assert.deepEqual(delta, [
    { c: 'b', t: 2, l: 20, v: 3 },
    { c: 'c', t: 3, l: 3, v: 1 },
    { c: 'd', t: 4, l: 4, v: 1, a: ['r1', '', 'r9'] },
  ]);
  assert.equal(core.cellSig(delta[2]), '1|4|r1,,r9');
});

test('top percent counts from the middle of your place', () => {
  assert.equal(core.topPercent(6, 500), 1.1);
  assert.equal(core.topPercent(3, 4), 62.5);
  assert.equal(core.topPercent(1, 1), 50);
  assert.equal(core.topPercent(1, 0), 100);
});

test('chunk, usernames and invites', () => {
  assert.deepEqual(core.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(core.validUsername('walker_42'), true);
  assert.equal(core.validUsername('No Caps'), false);
  assert.equal(core.parseInvite('https://x.github.io/scoop/?invite=ab12cd34'), 'AB12CD34');
  assert.equal(core.parseInvite(' 0f0f0f0f '), '0F0F0F0F');
  assert.equal(core.parseInvite('hello'), null);
});

test('heat halves every 30 days', () => {
  const t0 = Date.UTC(2026, 0, 1);
  assert.equal(core.heat(t0, t0), 1);
  assert.equal(core.heat(t0, t0 + 30 * DAY), 0.5);
  assert.equal(core.heat(t0, t0 + 60 * DAY), 0.25);
  assert.equal(core.heat(t0 + DAY, t0), 1, 'a visit in the future counts as just now');
  assert.equal(core.heat(0, t0), 0, 'never visited');
});

test('hex value and score: 1 per hex plus the regular bonus, faded by heat', () => {
  assert.deepEqual([0, 1, 2, 4, 8].map(core.hexValue), [0, 1, 2, 3, 4]);
  const t0 = Date.UTC(2026, 0, 1);
  assert.equal(core.hexScore(4, t0, t0 + 30 * DAY), 1.5);
});

test('walking through a hex earns back what it cooled off', () => {
  const t0 = Date.UTC(2026, 0, 1);
  assert.equal(core.visitGain(0, 0, 1, t0), 1, 'new hex');
  assert.equal(core.visitGain(1, t0, 2, t0), 1, 'same day: only the regular bonus');
  assert.equal(core.visitGain(2, t0, 3, t0 + 30 * DAY), 1, 'cooled to half of 2, back to 2');
  assert.equal(core.visitGain(3, t0, 4, t0 + 30 * DAY), 2, 'and the bonus rises at 4 visits');
});

test('edge band: only the inner 90% of a hex unlocks it', () => {
  const cell = h3.latLngToCell(52.52, 13.405, 10);
  const centre = h3.cellToLatLng(cell);
  const boundary = h3.cellToBoundary(cell);
  const toward = (f) => [centre[0] + (boundary[0][0] - centre[0]) * f, centre[1] + (boundary[0][1] - centre[1]) * f];
  assert.equal(core.inCore(...centre, centre, boundary), true, 'centre');
  assert.equal(core.inCore(...toward(0.9), centre, boundary), true, '90% of the way to a corner');
  assert.equal(core.inCore(...toward(0.97), centre, boundary), false, 'right by the corner');
  // The band covers about 10% of the hex's area.
  let inside = 0;
  let total = 0;
  for (let i = -40; i <= 40; i++) {
    for (let j = -40; j <= 40; j++) {
      const lat = centre[0] + (i / 40) * 0.0012;
      const lng = centre[1] + (j / 40) * 0.0018;
      if (h3.latLngToCell(lat, lng, 10) !== cell) continue;
      total++;
      if (core.inCore(lat, lng, centre, boundary)) inside++;
    }
  }
  assert.ok(Math.abs(inside / total - 0.9) < 0.02, `core share ${inside / total}`);
});

const rel = (id, level, extra = {}) => ({ id, tags: { boundary: 'administrative', admin_level: String(level), name: `L${level}`, ...extra } });

test('areas: city is the tagged city, district the next level down', () => {
  // Berlin-like: state that is a city, boroughs at 9, localities at 10.
  const berlin = core.pickAreas([rel(1, 2), rel(2, 4, { place: 'city' }), rel(3, 9), rel(4, 10)]);
  assert.deepEqual([berlin.country.id, berlin.city.id, berlin.district.id], ['r1', 'r2', 'r3']);
  // No city tags: level 8 is the city.
  const plain = core.pickAreas([rel(1, 2), rel(5, 4), rel(6, 6), rel(7, 8), rel(8, 10)]);
  assert.deepEqual([plain.city.id, plain.district.id], ['r7', 'r8']);
  // No level 8: the deepest of 4–7.
  const shallow = core.pickAreas([rel(1, 2), rel(5, 4), rel(6, 6), rel(9, 7)]);
  assert.deepEqual([shallow.city.id, shallow.district], ['r9', null]);
  // Not administrative, or no levels at all.
  assert.deepEqual(core.pickAreas([{ id: 3, tags: { boundary: 'postal_code', admin_level: '8' } }]),
    { country: null, city: null, district: null });
  assert.equal(core.pickAreas([rel(1, 2, { 'name:en': 'Egypt', name: 'مصر' })]).country.name, 'Egypt');
});

test('areas: point in a boundary made of unordered ways, with a hole', () => {
  // A 2×2 square split into two ways in reverse order, with a small square hole.
  const outer = [[[0, 0], [0, 2], [2, 2]], [[0, 0], [2, 0], [2, 2]]];
  const hole = [[[0.9, 0.9], [0.9, 1.1], [1.1, 1.1], [1.1, 0.9], [0.9, 0.9]]];
  const ways = [...outer, ...hole];
  assert.equal(core.inWays(0.5, 0.5, ways), true);
  assert.equal(core.inWays(1, 1, ways), false, 'in the hole');
  assert.equal(core.inWays(3, 1, ways), false, 'outside');
  assert.deepEqual(core.waysBox(ways), [0, 0, 2, 2]);
});

test('areas: simplify drops points within tolerance and keeps the ends', () => {
  const line = [[0, 0], [0.00001, 1], [0, 2], [1, 3], [0, 4]];
  assert.deepEqual(core.simplifyLine(line, 0.001), [[0, 0], [0, 2], [1, 3], [0, 4]]);
  assert.deepEqual(core.simplifyLine([[0, 0], [1, 1]], 1), [[0, 0], [1, 1]]);
});

test('trend buckets by day, week (from Monday) and month', () => {
  const now = new Date(2026, 9, 29, 15).getTime(); // Thursday 29 Oct 2026
  const at = (m, d, h = 12) => new Date(2026, m, d, h).getTime();
  const events = [
    { t: at(9, 29), v: 2 }, { t: at(9, 29, 1), v: 1 }, // today
    { t: at(9, 26), v: 5 },                         // Monday this week
    { t: at(9, 25), v: 7 },                         // Sunday last week
    { t: at(8, 30), v: 4 },                         // September
    { t: at(0, 1), v: 100 },                        // too old for any view
  ];
  const days = core.trendBuckets(events, 'day', 7, now);
  assert.deepEqual(days.map((b) => b.value), [0, 0, 7, 5, 0, 0, 3]);
  assert.equal(days[6].start, new Date(2026, 9, 29).getTime());
  const weeks = core.trendBuckets(events, 'week', 3, now);
  assert.deepEqual(weeks.map((b) => b.value), [0, 7, 8]);
  assert.equal(weeks[2].start, new Date(2026, 9, 26).getTime());
  const months = core.trendBuckets(events, 'month', 3, now);
  assert.deepEqual(months.map((b) => b.value), [0, 4, 15]);
  assert.equal(months[0].start, new Date(2026, 7, 1).getTime());
});

test('local badges follow walks, hexes, distance, streaks and repeat visits', () => {
  const none = { walks: 0, hexes: 0, km: 0, longestStreak: 0, maxVisits: 0 };
  assert.deepEqual([...core.localBadges(none)], []);
  const some = core.localBadges({ walks: 3, hexes: 150, km: 50, longestStreak: 7, maxVisits: 10 });
  assert.deepEqual([...some].sort(), ['first_walk', 'hex_100', 'marathon', 'regular', 'streak_7']);
  for (const key of some) assert.ok(core.BADGES[key].glyph, key);
});

test('districts: smallest containing district wins, bad features are skipped', () => {
  const sq = (id, name, s, w, n, e) => ({ type: 'Feature', properties: { id, name },
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
  const ds = core.parseDistricts({ type: 'FeatureCollection', features: [
    sq('r900000000001', 'Big', 0, 0, 10, 10),
    sq('r900000000002', 'Small', 2, 2, 4, 4),
    sq('r123', 'Not ours', 0, 0, 10, 10),
    sq('r900000000003', '', 0, 0, 10, 10),
    { type: 'Feature', properties: { id: 'r900000000004', name: 'No shape' }, geometry: null },
  ] });
  assert.deepEqual(ds.map((d) => d.name), ['Big', 'Small']);
  assert.equal(core.districtAt(3, 3, ds).name, 'Small');
  assert.equal(core.districtAt(8, 8, ds).name, 'Big');
  assert.equal(core.districtAt(11, 8, ds), null);
  assert.deepEqual(core.parseDistricts(null), []);
});

test('districts: Cairo landmarks land in the right district', async () => {
  const { readFileSync } = await import('node:fs');
  const ds = core.parseDistricts(JSON.parse(readFileSync(new URL('../districts.geojson', import.meta.url), 'utf8')));
  const ids = ds.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  const at = (lat, lng) => (core.districtAt(lat, lng, ds) || {}).name;
  const places = [
    [30.0626, 31.2197, 'Zamalek'],         // Mohamed Mazhar St
    [30.0459, 31.2243, 'Zamalek'],         // Cairo Tower (Gezira)
    [30.0444, 31.2357, 'Downtown'],        // Tahrir Square
    [30.0389, 31.2325, 'Garden City'],     // US Embassy
    [30.0273, 31.2297, 'Manial'],          // Manial Palace
    [29.9598, 31.2581, 'Maadi'],           // Maadi metro
    [29.9600, 31.3082, 'Zahraa al-Maadi'], // Zahraa al-Maadi Area 3
    [29.9769, 31.3185, 'New Maadi'],
    [30.0866, 31.3302, 'Heliopolis'],      // Baron Palace
    [30.0730, 31.3460, 'Nasr City'],       // City Stars
    [30.0630, 31.4940, 'Rehab'],           // inside New Cairo, smaller wins
    [30.0300, 31.4700, 'New Cairo'],
    [30.0720, 31.2840, 'Abbasiya'],        // Abbasiya Square
    [30.0384, 31.2120, 'Dokki'],           // Dokki metro
    [30.0560, 31.2010, 'Mohandessin'],     // Gameat el Dewal
    [29.9792, 31.1342, 'Giza / Haram'],    // Pyramids
    [30.0070, 30.9730, '6th of October'],  // Mall of Arabia
  ];
  for (const [lat, lng, name] of places) assert.equal(at(lat, lng), name, `${lat},${lng}`);
  assert.equal(at(31.2001, 29.9187), undefined, 'Alexandria has none (yet)');
});

test('districts: names in districts.geojson match the ones migrations seed', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const seeded = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL(f, dir), 'utf8');
    for (const [, id, name] of sql.matchAll(/\('(r9\d{11})', 'district', '((?:[^']|'')*)'/g)) seeded[id] = name.replace(/''/g, "'");
  }
  const geo = JSON.parse(readFileSync(new URL('../districts.geojson', import.meta.url), 'utf8'));
  const own = Object.fromEntries(geo.features.map((f) => [f.properties.id, f.properties.name]));
  assert.deepEqual(own, seeded, 'add a migration that upserts new or renamed districts');
});

test('mergeRemote restores hexes and walks without losing local data', () => {
  const local = {
    visited: new Map([['a', 5000]]),
    visits: new Map([['a', 3]]),
    lastSeen: new Map([['a', 9000]]),
    walks: [{ start: 5000, end: 6000, km: 1, newCells: 1, points: 2 }],
  };
  const iso = (ms) => new Date(ms).toISOString();
  const got = core.mergeRemote(local, [
    { cell: 'a', first_visited: iso(1000), last_visited: iso(2000), visits: 2 },
    { cell: 'b', first_visited: iso(3000), last_visited: iso(8000), visits: 4 },
    { cell: 'bad', first_visited: iso(3000), last_visited: iso(3000), visits: 1 },
  ], [
    { started_at: iso(5000), ended_at: iso(6000), km: '1.000', new_cells: 1 },
    { started_at: iso(1000), ended_at: iso(2000), km: '2.500', new_cells: 7 },
  ], (c) => c !== 'bad');
  assert.deepEqual(got, { cells: 1, warmed: 1, walks: 1 }); // 'a' got an earlier first visit
  assert.equal(local.visited.get('a'), 1000);  // earliest first visit wins
  assert.equal(local.visits.get('a'), 3);      // local count was higher
  assert.equal(local.lastSeen.get('a'), 9000); // local last visit was later
  assert.equal(local.visited.get('b'), 3000);
  assert.equal(local.visits.get('b'), 4);
  assert.equal(local.lastSeen.get('b'), 8000);
  assert.ok(!local.visited.has('bad'));
  assert.deepEqual(local.walks.map((w) => [w.start, w.km, w.newCells]), [[1000, 2.5, 7], [5000, 1, 1]]);
  assert.equal(local.walks[1].points, 2);
});

test('readyToUpload: hexes in own districts do not wait for OSM', () => {
  const cutoff = 1000;
  assert.equal(core.readyToUpload({ l: 5000, a: ['r1', 'r2', 'r3'] }, cutoff), true);           // fully tagged
  assert.equal(core.readyToUpload({ l: 5000, a: ['', '', 'r900000000012'] }, cutoff), true);    // own district only
  assert.equal(core.readyToUpload({ l: 5000, a: ['', '', 'r123'] }, cutoff), false);            // OSM district, no country
  assert.equal(core.readyToUpload({ l: 5000 }, cutoff), false);                                 // nothing known, recent
  assert.equal(core.readyToUpload({ l: 500 }, cutoff), true);                                   // waited long enough
});

test('mergeRemote picks up hexes walked again on another device', () => {
  const iso = (ms) => new Date(ms).toISOString();
  const local = {
    visited: new Map([['a', 1000], ['b', 1000]]),
    visits: new Map([['a', 1], ['b', 2]]),
    lastSeen: new Map([['a', 1000], ['b', 5000]]),
    walks: [],
  };
  const got = core.mergeRemote(local, [
    { cell: 'a', first_visited: iso(1000), last_visited: iso(7000), visits: 2 }, // walked again on the phone
    { cell: 'b', first_visited: iso(1000), last_visited: iso(5000), visits: 2 }, // unchanged
  ], []);
  assert.deepEqual(got, { cells: 0, warmed: 1, walks: 0 });
  assert.equal(local.visits.get('a'), 2);
  assert.equal(local.lastSeen.get('a'), 7000);
});
