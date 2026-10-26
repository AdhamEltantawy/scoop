import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../social-core.js');
const h3 = require('../vendor/h3-js.umd.js');

const DAY = 86400000;
const A = '8a1f1d48945ffff';
const B = '8a1f1d489457fff';
const PARIS = '8a1fb466249ffff';

function person(id, { cells = [], walks = [], checkins = [] } = {}) {
  return {
    id, name: id,
    cells: new Map(cells.map(([c, t, v]) => [c, { t, v }])),
    walks: walks.map(([start, km]) => ({ start, end: start + 3600000, km, newCells: 0 })),
    checkins: checkins.map(([cell, kind, time], i) => ({ id: `${id}-${i}`, cell, kind, time, note: '' })),
  };
}

test('check-in points and repeat bonus', () => {
  assert.equal(core.checkinPoints('photo'), 3);
  assert.equal(core.checkinPoints('coffee'), 2);
  assert.equal(core.checkinPoints('meetup', false), 0);
  assert.equal(core.checkinPoints('meetup', true), 5);
  assert.deepEqual([1, 2, 3, 4, 8, 10].map(core.regularBonus), [0, 1, 1, 2, 3, 3]);
});

test('streaks count consecutive days and expire after a missed day', () => {
  const now = new Date(2026, 9, 26, 12).getTime();
  const starts = [now - 5 * DAY, now - 2 * DAY, now - DAY, now - DAY + 3600000, now];
  assert.deepEqual(core.streaks(starts, now), { current: 3, longest: 3 });
  assert.deepEqual(core.streaks(starts, now + 2 * DAY), { current: 0, longest: 3 });
  assert.deepEqual(core.streaks([], now), { current: 0, longest: 0 });
});

test('week starts on Monday at midnight', () => {
  const sunday = new Date(2026, 9, 25, 15).getTime();
  assert.equal(core.weekStart(sunday), new Date(2026, 9, 19).getTime());
  assert.equal(core.weekStart(new Date(2026, 9, 19, 0, 0, 1).getTime()), new Date(2026, 9, 19).getTime());
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

test('Scoop files round-trip and round first visits to the day', () => {
  const t = Date.UTC(2026, 9, 20, 17, 42);
  const file = core.makeFriendFile({
    me: { id: 'aaaaaaaa-1111', name: 'Alice' },
    cells: [[A, t, 3]],
    walks: [{ start: t, end: t + 60000, km: 1.23456, newCells: 1 }],
    checkins: [{ id: 'c1', cell: A, kind: 'coffee', time: t, note: 'flat white' }],
    challenges: [{ id: 'ch-000001', creator: 'aaaaaaaa-1111', title: 'Hunt', metric: 'hexes', start: t, end: t + 7 * DAY, members: ['aaaaaaaa-1111', 'bbbbbbbb-2222'], names: { 'bbbbbbbb-2222': 'Bob' } }],
    now: t,
  });
  const p = core.parseFriendFile(JSON.parse(JSON.stringify(file)));
  assert.equal(p.name, 'Alice');
  assert.deepEqual(p.cells.get(A), { t: Date.UTC(2026, 9, 20), v: 3 });
  assert.equal(p.walks[0].km, 1.235);
  assert.equal(p.checkins[0].note, 'flat white');
  assert.equal(p.challenges[0].names['bbbbbbbb-2222'], 'Bob');
});

test('parsing rejects other files and drops bad rows', () => {
  assert.throws(() => core.parseFriendFile({ app: 'scoop', cells: {} }), /backup/);
  assert.throws(() => core.parseFriendFile({ hello: 1 }), /Not a Scoop file/);
  const p = core.parseFriendFile({
    app: 'scoop-friend', id: 'bbbbbbbb-2222', name: '<b>Bob</b>',
    cells: [[A, 1, 2], ['not-a-cell', 1, 1], [B]],
    walks: [[1, 2, 3, 0], [1, 2, 5000, 0]],
    checkins: [['x', A, 'coffee', 5, 'hi'], ['y', A, 'teleport', 5, '']],
    challenges: [{ id: 'ch-000001', creator: 'bbbbbbbb-2222', metric: 'km', start: 0, end: 365 * DAY, members: [] }],
  });
  assert.equal(p.name, '<b>Bob</b>'); // shown with textContent, never as HTML
  assert.deepEqual([...p.cells.keys()], [A]);
  assert.equal(p.walks.length, 1);
  assert.equal(p.checkins.length, 1);
  assert.equal(p.challenges.length, 0, 'challenges longer than 92 days are dropped');
});

test('meetups are verified by someone else checking in nearby in time', () => {
  const t = Date.now();
  const alice = person('alice', { checkins: [[A, 'meetup', t]] });
  const bob = person('bob', { checkins: [[A, 'meetup', t + 20 * 60000]] });
  const carol = person('carol', { checkins: [[A, 'meetup', t + 2 * 3600000]] });
  const verified = core.meetupVerifier([alice, bob, carol]);
  assert.equal(verified(alice, alice.checkins[0]), true);
  assert.equal(verified(bob, bob.checkins[0]), true);
  assert.equal(verified(carol, carol.checkins[0]), false);
  assert.equal(core.meetupVerifier([alice])(alice, alice.checkins[0]), false);
});

test('stats add hexes, repeat visits and check-ins, with time and area limits', () => {
  const t = Date.now();
  const p = person('alice', {
    cells: [[A, t - 10 * DAY, 3], [B, t, 1], [PARIS, t, 8]],
    walks: [[t - 10 * DAY, 2], [t, 3.5]],
    checkins: [[A, 'coffee', t], [B, 'photo', t - 10 * DAY], [A, 'meetup', t]],
  });
  const all = core.stats(p);
  // 3 hexes + repeat (1 + 0 + 3) + coffee 2 + photo 3 + unverified meetup 0
  assert.deepEqual(all, { hexes: 3, repeat: 4, checkinPts: 5, km: 5.5, score: 12 });
  const week = core.stats(p, { since: t - DAY });
  assert.deepEqual(week, { hexes: 2, repeat: 0, checkinPts: 2, km: 3.5, score: 4 });
  const berlin = core.stats(p, { area: [h3.cellToParent(A, 8)], parent8: (c) => h3.cellToParent(c, 8) });
  assert.equal(berlin.hexes, 2);
  assert.equal(core.stats(p, { verified: () => true }).checkinPts, 10);
});

test('badges', () => {
  const t = Date.now();
  const cells = Array.from({ length: 100 }, (_, i) => [h3.latLngToCell(52.5, 13.4 + i * 0.002, 10), t, i === 0 ? 10 : 1]);
  const p = person('alice', { cells, walks: [[t, 43]], checkins: [[cells[0][0], 'meetup', t]] });
  const got = core.badges(p, () => true);
  for (const b of ['first_walk', 'hex_100', 'marathon', 'regular', 'first_meetup']) assert.ok(got.has(b), b);
  assert.ok(!got.has('hex_1000'));
  assert.ok(!core.badges(p).has('first_meetup'));
});

test('rank shares places on ties', () => {
  const r = core.rank([{ name: 'b', value: 5 }, { name: 'a', value: 9 }, { name: 'c', value: 5 }]);
  assert.deepEqual(r.map((x) => [x.name, x.rank]), [['a', 1], ['b', 2], ['c', 2]]);
});
