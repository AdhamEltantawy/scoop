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

test('sync delta sends new and revisited cells only', () => {
  const visited = new Map([['a', 1], ['b', 2], ['c', 3], ['home', 4]]);
  const counts = { a: 1, b: 3, c: 1, home: 1 };
  const delta = core.syncDelta(visited, (c) => counts[c], { a: 1, b: 2 }, (c) => c === 'home');
  assert.deepEqual(delta, [{ c: 'b', t: 2, v: 3 }, { c: 'c', t: 3, v: 1 }]);
});

test('chunk, usernames and invites', () => {
  assert.deepEqual(core.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(core.validUsername('walker_42'), true);
  assert.equal(core.validUsername('No Caps'), false);
  assert.equal(core.parseInvite('https://x.github.io/scoop/?invite=ab12cd34'), 'AB12CD34');
  assert.equal(core.parseInvite(' 0f0f0f0f '), '0F0F0F0F');
  assert.equal(core.parseInvite('hello'), null);
});
