-- Behaviour and row level security tests for the social schema.
-- Run with scripts/test-db.sh. Any failed check aborts with an error.

\set ON_ERROR_STOP 1
set client_min_messages = warning;

create schema test;
grant usage on schema test to anon, authenticated;

create function test.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAILED: %', msg; end if;
end $$;

-- Runs `sql` as the current role and fails unless it raises an error.
create function test.throws(sql text, msg text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FAILED (expected an error): %', msg;
exception when others then
  if sqlerrm like 'FAILED (expected an error)%' then raise; end if;
end $$;

-- Epoch milliseconds for now() minus some interval, for sync_cells payloads.
create function test.ms(ago interval default '0'::interval) returns bigint language sql stable as $$
  select (extract(epoch from now() - ago) * 1000)::bigint
$$;
grant execute on all functions in schema test to anon, authenticated;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.com'),
  ('00000000-0000-0000-0000-00000000000d', 'dave@example.com');

-- Areas: country r1, city r2, districts r10 (Zamalek) and r20 (Maadi).
-- Zamalek street hexes Z1–Z6, Maadi M1:
--   Z1 8a3e6281ba1ffff  Z2 8a3e6281ba17fff  Z3 8a3e6281baaffff
--   Z4 8a3e6281baf7fff  Z5 8a3e6281bae7fff  Z6 8a3e6281ba0ffff  M1 8a3e628c24cffff
create temp table areas_json as select '[
  {"id": "r1", "kind": "country", "name": "Egypt", "level": 2},
  {"id": "r2", "kind": "city", "name": "Cairo", "level": 4},
  {"id": "r10", "kind": "district", "name": "Zamalek", "level": 6},
  {"id": "r20", "kind": "district", "name": "Maadi", "level": 6}
]'::jsonb as a;
grant select on areas_json to authenticated;

-- ---------- scoring helpers ----------
select test.ok(public.h3_to_parent('8a1f1d48945ffff', 8) = '881f1d4895fffff', 'res 8 parent matches h3-js');
select test.ok(public.h3_to_parent('8a1f1d48945ffff', 9) = '891f1d48947ffff', 'res 9 parent matches h3-js');
select test.ok(array[public.hex_value(0), public.hex_value(1), public.hex_value(2), public.hex_value(3),
  public.hex_value(4), public.hex_value(8)] = array[0, 1, 2, 2, 3, 4], 'hex value: 1 plus floor(log2(visits))');
select test.ok(public.heat(now() - interval '30 days', now()) = 0.5, 'heat halves in 30 days');
select test.ok(public.heat(now() + interval '1 day', now()) = 1, 'a future visit counts as now');
select test.ok(public.heat(null, now()) = 0, 'never visited');

-- ---------- profiles ----------
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.profiles (id, username, display_name) values (auth.uid(), 'alice', 'Alice');
select test.throws($$ select invite_code from public.profiles $$, 'invite codes are not readable');
select test.ok(public.my_invite_code() ~ '^[0-9A-F]{8}$', 'own invite code available via RPC');
select test.throws($$ insert into public.profiles (id, username) values ('00000000-0000-0000-0000-00000000000b', 'mallory') $$,
  'cannot create a profile for someone else');
select test.throws($$ update public.profiles set invite_code = 'AAAAAAAA' $$, 'cannot change invite code');
select test.throws($$ insert into public.profiles (id, username, leaderboard_public) values (auth.uid(), 'x', true) $$,
  'public profiles are gone');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into public.profiles (id, username) values (auth.uid(), 'bob');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
insert into public.profiles (id, username) values (auth.uid(), 'carol');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
insert into public.profiles (id, username) values (auth.uid(), 'dave');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select count(*) from public.profiles) = 1, 'stranger sees only their own profile');

-- ---------- cells ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
-- Z1 three visits, Z2 last walked 30 days ago, Z3 today.
select test.ok(public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e6281ba1ffff', 't', test.ms('60 days'), 'l', test.ms(), 'v', 3, 'a', '["r1","r2","r10"]'::jsonb),
  jsonb_build_object('c', '8a3e6281ba17fff', 't', test.ms('60 days'), 'l', test.ms('30 days'), 'v', 1, 'a', '["r1","r2","r10"]'::jsonb),
  jsonb_build_object('c', '8a3e6281baaffff', 't', test.ms(), 'a', '["r1","r2","r10"]'::jsonb)
), (select a from areas_json)) = 3, 'sync inserts cells');
select test.ok((select string_agg(name, ',' order by id) from public.areas where id !~ '^r9') = 'Egypt,Zamalek,Cairo,Maadi', 'area names stored');
-- Scoop's own districts are seeded by migration and can't be renamed by a sync.
select test.ok((select name from public.areas where id = 'r900000000001') = 'Zamalek', 'own districts are seeded');
select public.sync_cells('[]'::jsonb,
  '[{"id": "r900000000001", "kind": "district", "name": "Hacked", "level": 10},
    {"id": "r900000000099", "kind": "district", "name": "Made up", "level": 10}]'::jsonb);
select test.ok((select name from public.areas where id = 'r900000000001') = 'Zamalek'
    and not exists (select 1 from public.areas where id = 'r900000000099'), 'syncs cannot rename or invent own districts');
-- An older copy from another device doesn't move anything back.
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e6281ba1ffff', 't', test.ms('90 days'), 'l', test.ms('90 days'), 'v', 2)));
reset role;
select test.ok((select visits = 3 and first_visited < now() - interval '89 days' and last_visited > now() - interval '1 minute'
    and district = 'r10' from public.user_cells where cell = '8a3e6281ba1ffff'),
  'sync keeps max visits, earliest first visit, latest last visit and known areas');
set role authenticated;
select test.throws($$ select public.sync_cells('[{"c": "891f1d48947ffff", "t": 1760000000000}]') $$, 'only res-10 cells');
select test.throws($$ select public.sync_cells('[{"c": "8a3e6281ba1ffff", "t": 1760000000000, "a": ["x", "", ""]}]') $$,
  'area ids are checked');
select test.throws($$ insert into public.user_cells (user_id, cell, first_visited, last_visited) values (auth.uid(), '8a1fb466249ffff', now(), now()) $$,
  'no direct inserts into user_cells');
select test.throws($$ select last_visited from public.user_cells $$, 'last visits are not readable, even your own');
select test.throws($$ select first_visited from public.user_cells $$, 'first visits are not readable');
select test.throws($$ select * from public.score_events $$, 'score log is not readable');
select test.ok((select count(*) from public.my_cells()) = (select count(*) from public.user_cells where user_id = auth.uid()),
  'my_cells returns all your own hexes');
select test.ok((select bool_and(m.first_visited is not null and m.last_visited >= m.first_visited) from public.my_cells() m),
  'with their visit dates');
select test.ok(not exists (select 1 from public.my_cells() m
  where not exists (select 1 from public.user_cells o where o.user_id = auth.uid() and o.cell = m.cell)),
  'and never anyone else''s');
select test.ok((select count(*) from public.my_cells((select min(cell) from public.my_cells()))) =
  (select count(*) from public.my_cells()) - 1, 'paged by cell');
-- Other devices fetch only what changed since they last looked.
select set_config('test.mark', clock_timestamp()::text, false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e6281ba1ffff', 't', test.ms('90 days'), 'l', test.ms('90 days'), 'v', 2)));
select test.ok((select count(*) from public.my_cells('', current_setting('test.mark')::timestamptz)) = 0,
  'an upload that changes nothing is not a change');
reset role;
update public.user_cells set visits = visits + 1 where user_id = auth.uid() and cell = '8a3e6281baaffff';
update public.user_cells set visits = visits - 1 where user_id = auth.uid() and cell = '8a3e6281baaffff';
update public.user_cells set district = district where user_id = auth.uid();
set role authenticated;
select test.ok((select array_agg(cell) from public.my_cells('', current_setting('test.mark')::timestamptz)) = array['8a3e6281baaffff'],
  'my_cells(since) returns only hexes changed since then');
select test.ok((select count(*) from public.my_cells('', null)) = (select count(*) from public.my_cells()), 'no since: everything');
select test.throws($$ select synced_at from public.user_cells $$, 'change times are not readable either');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e628c24cffff', 't', test.ms(), 'v', 8, 'a', '["r1","r2","r20"]'::jsonb),
  jsonb_build_object('c', '8a3e6281ba1ffff', 't', test.ms(), 'a', '["r1","r2","r10"]'::jsonb)));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e6281baf7fff', 't', test.ms(), 'a', '["r1","r2","r10"]'::jsonb),
  jsonb_build_object('c', '8a3e6281bae7fff', 't', test.ms(), 'a', '["r1","r2","r10"]'::jsonb)));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e6281ba0ffff', 't', test.ms(), 'a', '["r1","r2","r10"]'::jsonb)));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select count(*) from public.user_cells) = 2, 'not yet friends: only own cells visible');

-- ---------- friendships ----------
reset role;
create temp table codes as select username, invite_code from public.profiles;
grant select on codes to authenticated;
set role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.throws($$ select public.send_friend_request('NOPE1234') $$, 'unknown code rejected');
select test.ok((select status from public.send_friend_request((select invite_code from codes where username = 'bob'))) = 'pending',
  'request is pending');
select test.throws($$ insert into public.friendships (requester, addressee, status) values (auth.uid(), '00000000-0000-0000-0000-00000000000c', 'accepted') $$,
  'cannot insert friendships directly');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok(exists (select 1 from public.profiles where username = 'alice'), 'requester profile visible while pending');
select test.ok((select count(*) from public.user_cells) = 2, 'pending: still only own cells');
select public.respond_friend_request('00000000-0000-0000-0000-00000000000a', true);
select test.ok((select count(*) from public.user_cells) = 5, 'friends: alice cells visible to bob');
select test.ok((select expires_at between now() + interval '29 days' and now() + interval '31 days' from public.friendships),
  'a friendship lasts a month');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select count(*) from public.user_cells) = 1, 'stranger sees only own cells');

-- ---------- walks and kudos ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.walks (started_at, ended_at, km, new_cells) values (now() - interval '1 hour', now(), 3.2, 3);
select test.throws($$ insert into public.walks (user_id, started_at, ended_at, km) values ('00000000-0000-0000-0000-00000000000b', now(), now(), 1) $$,
  'cannot add walks for someone else');
select test.ok(exists (select 1 from public.badges where badge_key = 'first_walk'), 'first walk badge awarded');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into public.kudos (walk_id, emoji) select id, '🔥' from public.walks;
select test.ok((select count(*) from public.kudos) = 1, 'friend can give kudos');
select test.ok(exists (select 1 from public.badges where user_id = '00000000-0000-0000-0000-00000000000a'), 'friend badges visible');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select count(*) from public.walks) = 0, 'stranger sees no walks');
reset role;
create temp table alice_walk as select id from public.walks limit 1;
grant select on alice_walk to authenticated;
set role authenticated;
select test.throws($$ insert into public.kudos (walk_id) select id from alice_walk $$, 'stranger cannot give kudos');

-- ---------- scores fade ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
-- alice: Z1 worth 2 at full heat, Z2 worth 1 at half heat, Z3 worth 1 = 3.5
select test.ok((select value from public.leaderboard('now') where username = 'alice') = 3.5,
  'current score fades hexes by heat');
-- This week: Z1 (2) and Z3 (1) earned today; Z2 a month ago.
select test.ok((select value from public.leaderboard('week') where username = 'alice') = 3,
  'week score counts points earned this week');
-- Walking Z2 again: back to full and worth 2 now, from 0.5: earns 1.5.
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e6281ba17fff', 't', test.ms('60 days'), 'l', test.ms(), 'v', 2)));
select test.ok((select value from public.leaderboard('now') where username = 'alice') = 5, 'revisit warms the hex back up');
select test.ok((select value from public.leaderboard('week') where username = 'alice') = 4.5, 'and earns what it had cooled off');
-- Re-sending the same data earns nothing.
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e6281ba17fff', 't', test.ms('60 days'), 'l', test.ms('1 minute'), 'v', 2)));
select test.ok((select value from public.leaderboard('week') where username = 'alice') = 4.5, 'syncing again is free');
select test.ok((select array_agg(username order by username) from public.leaderboard('now')) = array['alice', 'bob'],
  'friends leaderboard has only self and friends');
select test.throws($$ select public.score_now(auth.uid(), null) $$, 'internal score helper not callable');
select test.throws($$ select public.leaderboard('all') $$, 'unknown period');

-- ---------- check-ins ----------
select test.throws($$ insert into public.checkins (cell, kind) values ('8a1fb466249ffff', 'coffee') $$,
  'cannot check in to an unvisited hex');
insert into public.checkins (cell, kind, note) values ('8a3e6281ba1ffff', 'coffee', 'flat white');
select test.throws($$ insert into public.checkins (cell, kind) values ('8a3e6281ba1ffff', 'coffee') $$,
  'one check-in per kind, hex and day');
select test.throws($$ insert into public.checkins (cell, kind) values ('8a3e6281ba1ffff', 'photo') $$,
  'photo check-in needs a photo');
select test.throws($$ insert into public.checkins (cell, kind, photo_path) values ('8a3e6281baaffff', 'photo', '00000000-0000-0000-0000-00000000000b/x.jpg') $$,
  'photo must be in own folder');
insert into public.checkins (cell, kind, photo_path)
  values ('8a3e6281baaffff', 'photo', '00000000-0000-0000-0000-00000000000a/one.jpg');
insert into public.checkins (cell, kind) values ('8a3e6281ba1ffff', 'meetup');
select test.ok((select met_with from public.checkins where kind = 'meetup') is null, 'meetup unverified until a friend checks in');
select test.throws($$ update public.checkins set met_with = '00000000-0000-0000-0000-00000000000b' $$,
  'cannot verify a meetup yourself');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into public.checkins (cell, kind) values ('8a3e6281ba1ffff', 'meetup');
select test.ok((select count(*) from public.checkins where kind = 'meetup' and met_with is not null) = 2,
  'friend meetup verifies both check-ins');
select test.ok((select count(*) from public.badges where badge_key = 'first_meetup') = 2, 'both get the meetup badge');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
-- alice: 5 from hexes + coffee 2 + photo 3 + meetup 5
select test.ok((select value from public.leaderboard('now') where username = 'alice') = 15, 'check-ins add to the score');
reset role;
update public.checkins set created_at = now() - interval '30 days' where kind = 'coffee';
set role authenticated;
select test.ok((select value from public.leaderboard('now') where username = 'alice') = 14, 'check-ins fade too');
select test.ok((select value from public.leaderboard('week') where username = 'alice') = 12.5,
  'week counts check-ins made this week');

-- ---------- areas ----------
-- Zamalek now: alice 14, bob 1 + meetup 5 = 6, dave 2, carol 1.
select test.ok((select array_agg(coalesce(username, '?') order by rank) from public.area_leaderboard('r10')) = array['alice', 'bob', '?', '?'],
  'area leaderboard names only you and your friends');
select test.ok((select bool_and(user_id is null and display_name is null and not is_friend and not is_me)
    from public.area_leaderboard('r10') where rank > 2), 'strangers are anonymous');
select test.ok((select max(total) from public.area_leaderboard('r10')) = 4, 'and counted');
select test.ok((select value from public.area_leaderboard('r2') where is_me) = 14, 'city board covers its districts');
select test.ok((select array_agg(coalesce(username, '?') || ':' || value order by rank, username) from public.area_leaderboard(null))
    = array['alice:14.00', 'bob:10.00', '?:2.00', '?:1.00'], 'everyone board: everybody with points, wherever they walk; strangers anonymous');
select test.ok((select value from public.area_leaderboard(null, 'week') where is_me) = (select value from public.leaderboard('week') where username = 'alice'),
  'everyone board by week');
select test.ok((select array_agg(kind || ':' || name || ':' || rank || '/' || total order by kind) from public.my_areas())
    = array['city:Cairo:1/4', 'country:Egypt:1/4', 'district:Zamalek:1/4'], 'my home areas and my place in them');
select test.ok((select district_name || ' ' || district_rank || '/' || district_total from public.friend_stats() where username = 'bob')
    = 'Maadi 1/1', 'friends see each other''s home district: where they score most');
select test.ok((select count(*) from public.friend_stats()) = 2, 'friend stats cover you and your friends only');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select array_agg(cell) from public.collective_map(array['883e6281bbfffff'])) = array['8a3e6281ba0ffff'],
  'community map: a stranger sees only their own hexes');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select explorers from public.collective_map(array['883e6281bbfffff']) where cell = '8a3e6281ba1ffff') = 2,
  'community map counts friends exploring the same hex');

-- ---------- challenges: percentile in your own district ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.challenges (title, starts_at, ends_at) values ('October', now() - interval '1 hour', now() + interval '7 days');
insert into public.challenge_members (challenge_id, user_id) select id, '00000000-0000-0000-0000-00000000000b' from public.challenges;
select test.throws($$ insert into public.challenge_members (challenge_id, user_id) select id, '00000000-0000-0000-0000-00000000000c' from public.challenges $$,
  'can only invite friends');
select test.throws($$ insert into public.challenges (title, ends_at, area_cells) values ('x', now() + interval '1 day', '{}') $$,
  'challenge areas are official districts now');
reset role;
create temp table the_challenge as select id from public.challenges limit 1;
grant select on the_challenge to authenticated;
set role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
update public.challenge_members set status = 'joined' where user_id = auth.uid();
-- Today in Zamalek: alice 1st of 4 (top 12.5%). In Maadi bob earns more
-- points (4) but is 1st of 1 (top 50%). Alice wins.
select test.ok((select array_agg(username || ' ' || district_name || ' ' || district_rank || '/' || district_total || ' ' || top_pct order by rank)
    from public.challenge_standings((select id from the_challenge)))
  = array['alice Zamalek 1/4 12.5', 'bob Maadi 1/1 50.0'], 'best percentile in your own district wins');
select test.ok((select value from public.challenge_standings((select id from the_challenge)) where username = 'bob') = 4,
  'standings show raw points too');
select test.throws($$ update public.challenge_members set challenge_id = 999 $$, 'cannot move a membership');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.throws($$ select * from public.challenge_standings((select id from the_challenge)) $$, 'outsiders cannot see standings');
select test.ok((select count(*) from public.challenges) = 0, 'outsiders cannot see challenges');

-- ---------- photo storage ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into storage.objects (bucket_id, name) values ('checkin-photos', '00000000-0000-0000-0000-00000000000a/one.jpg');
select test.throws($$ insert into storage.objects (bucket_id, name) values ('checkin-photos', '00000000-0000-0000-0000-00000000000b/x.jpg') $$,
  'cannot upload into another user''s folder');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select count(*) from storage.objects) = 1, 'friend can read photos');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select count(*) from storage.objects) = 0, 'stranger cannot read photos');

-- ---------- monthly renewal ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.throws($$ select public.renew_friendship('00000000-0000-0000-0000-00000000000b') $$, 'too early to renew');
reset role;
update public.friendships set expires_at = now() + interval '2 days';
set role authenticated;
select test.ok((select waiting_for_them from public.renew_friendship('00000000-0000-0000-0000-00000000000b')),
  'renewing alone waits for the other side');
select test.ok((select requester_renewed and not addressee_renewed from public.friendships), 'renewal is recorded');
select test.ok((select expires_at < now() + interval '3 days' from public.friendships), 'not extended yet');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select renewed from public.renew_friendship('00000000-0000-0000-0000-00000000000a')), 'both renewed');
select test.ok((select expires_at > now() + interval '31 days' and not requester_renewed and not addressee_renewed from public.friendships),
  'another month on top of the days left');

-- Lapsed: no longer friends, but either can renew for 30 days.
reset role;
update public.friendships set expires_at = now() - interval '1 day';
set role authenticated;
select test.ok((select count(*) from public.user_cells) = 2, 'lapsed: friend''s hexes hidden');
select test.ok((select count(*) from public.leaderboard('now')) = 1, 'lapsed: off the friends leaderboard');
select test.ok((select count(*) from storage.objects) = 0, 'lapsed: photos hidden');
select test.ok(exists (select 1 from public.profiles where username = 'alice'), 'lapsed: still listed, to renew');
select test.ok((select status from public.send_friend_request((select invite_code from codes where username = 'alice'))) = 'renewing',
  'adding a lapsed friend again renews');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.ok((select renewed from public.renew_friendship('00000000-0000-0000-0000-00000000000b')), 'renewed after lapsing');
select test.ok((select count(*) from public.user_cells) = 5, 'friends again');

-- Lapsed more than 30 days ago: start over with an invite code.
reset role;
update public.friendships set expires_at = now() - interval '40 days';
set role authenticated;
select test.throws($$ select public.renew_friendship('00000000-0000-0000-0000-00000000000b') $$, 'too late to renew');
select test.ok((select status from public.send_friend_request((select invite_code from codes where username = 'bob'))) = 'pending',
  'a fresh request instead');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select public.respond_friend_request('00000000-0000-0000-0000-00000000000a', true);
select test.ok((select count(*) from public.user_cells) = 5, 'friends once more');

-- ---------- own districts: country and city filled in by the server ----------
-- New Cairo hexes N1–N3: 8a3e62ba3877fff 8a3e62ba382ffff 8a3e62ba380ffff
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e62ba3877fff', 't', test.ms(), 'a', '["", "", "r900000000012"]'::jsonb)));
reset role;
select test.ok((select country is null and district = 'r900000000012' from public.user_cells where cell = '8a3e62ba3877fff'),
  'own-district hexes upload before their country is known');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e62ba382ffff', 't', test.ms(), 'a', '["r1", "r2", "r900000000012"]'::jsonb)));
reset role;
select test.ok((select country = 'r1' and city = 'r2' from public.user_cells where cell = '8a3e62ba3877fff'),
  'a fully tagged upload teaches the server where the district is, and re-tags earlier hexes');
select test.ok(not exists (select 1 from public.score_events where district = 'r900000000012' and (country = '' or city = ''))
    and (select sum(points) from public.score_events where district = 'r900000000012'
      and user_id = '00000000-0000-0000-0000-00000000000c' and country = 'r1' and city = 'r2') = 1,
  'and moves their points into the country and city');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e62ba380ffff', 't', test.ms(), 'a', '["", "", "r900000000012"]'::jsonb)));
reset role;
select test.ok((select country = 'r1' and city = 'r2' from public.user_cells where cell = '8a3e62ba380ffff'),
  'later own-district hexes get their country and city straight away');
-- Rehab hexes R1–R3: 8a3e62b166f7fff 8a3e62b166affff 8a3e62b1668ffff
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e62b166f7fff', 't', test.ms(), 'a', '["", "", "r900000000013"]'::jsonb)));
reset role;
select test.ok((select country = 'r1' and city = 'r2' from public.user_cells where cell = '8a3e62b166f7fff'),
  'a district nobody tagged yet borrows from another in the same governorate');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e62b166affff', 't', test.ms(), 'a', '["r1", "r77", "r900000000013"]'::jsonb)));
reset role;
select test.ok((select city = 'r77' from public.user_cells where cell = '8a3e62b166f7fff')
    and (select sum(points) from public.score_events where user_id = '00000000-0000-0000-0000-00000000000c'
      and district = 'r900000000013' and city = 'r77') = 1
    and not exists (select 1 from public.score_events where district = 'r900000000013' and city <> 'r77'),
  'its own answer replaces the borrowed one, for hexes and points');
set role authenticated;
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e62b1668ffff', 't', test.ms(), 'a', '["r1", "r55", "r900000000013"]'::jsonb)));
reset role;
select test.ok((select city = 'r77' from public.user_cells where cell = '8a3e62b1668ffff')
    and (select city = 'r2' from public.user_cells where cell = '8a3e62ba3877fff'),
  'after that each own district keeps one city');
set role authenticated;
select test.throws($$ select * from public.area_parents $$, 'area parents are not readable');
select test.throws($$ select public.apply_area_parents(array['r900000000012']) $$, 'nor callable');

-- ---------- landmarks ----------
-- alice (Z1–Z3) and bob are friends; carol is a stranger to both.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
-- Any hex you're standing in, walked or not (the app checks you're there).
insert into public.landmarks (cell, kind, title) values ('8a1fb466249ffff', 'view', 'Never walked');
select test.ok((select count(*) from public.my_landmarks() where title = 'Never walked') = 1,
  'can leave a landmark on a hex you haven''t walked');
delete from public.landmarks where title = 'Never walked';
select test.throws($$ insert into public.landmarks (cell, kind, title) values ('8a3e6281ba1ffff', 'castle', 'Nope') $$,
  'kind is checked');
select test.throws($$ insert into public.landmarks (cell, kind, title) values ('8a3e6281ba1ffff', 'view', '   ') $$,
  'a title is needed');
insert into public.landmarks (cell, kind, title, note) values ('8a3e6281ba1ffff', 'view', '  Nile view ', '  Best at sunset ');
insert into public.landmarks (cell, kind, title) values ('8a3e6281ba1ffff', 'art', 'Again'), ('8a3e6281ba1ffff', 'food', 'And again');
select test.ok((select count(*) from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba1ffff', 7)]) where cell = '8a3e6281ba1ffff') = 3,
  'several landmarks on one hex');
select test.throws($$ insert into public.landmarks (cell, kind, title) values ('8a3e6281ba1ffff', 'gem', 'One more') $$,
  'at most 3 landmarks of yours per hex');
delete from public.landmarks where title in ('Again', 'And again');
select test.throws($$ insert into public.landmarks (user_id, cell, kind, title)
  values ('00000000-0000-0000-0000-00000000000b', '8a3e6281baaffff', 'art', 'Forged') $$, 'cannot leave one as someone else');
select test.ok((select title = 'Nile view' and note = 'Best at sunset' from public.landmarks), 'title and note are trimmed');
select test.ok((select author = 'Alice' and mine and finds = 0 from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba1ffff', 7)])),
  'your own landmark shows up near you');
select test.ok((select count(*) from public.landmarks_near(array[public.h3_to_parent('8a1fb466249ffff', 7)])) = 0,
  'only landmarks in the blocks asked for');
select test.throws($$ select public.find_landmark((select id from public.landmarks)) $$, 'cannot find your own landmark');
reset role;
create temp table the_landmark as select id from public.landmarks;
grant select on the_landmark to authenticated;
-- The limit: fill alice up with landmarks on hexes she walked.
insert into public.user_cells (user_id, cell, first_visited, last_visited)
  select '00000000-0000-0000-0000-00000000000a', '8a3e6281b' || lpad(to_hex(i), 2, '0') || '7fff', now(), now()
  from generate_series(1, 30) i on conflict do nothing;
set role authenticated;
insert into public.landmarks (cell, kind, title)
  select '8a3e6281b' || lpad(to_hex(i), 2, '0') || '7fff', 'gem', 'Spot ' || i from generate_series(1, 24) i;
select test.throws($$ insert into public.landmarks (cell, kind, title) values ('8a3e6281b1e7fff', 'gem', 'One too many') $$,
  'at most 25 landmarks out at once');
delete from public.landmarks where title like 'Spot %';
select test.ok((select count(*) from public.my_landmarks()) = 1, 'deleting your own landmarks');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select count(*) from public.landmarks) = 0, 'other explorers'' landmarks are not readable directly');
select test.ok((select author is null and not mine and not found_by_me and title = 'Nile view'
    from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba1ffff', 7)])),
  'strangers see the landmark but not who left it');
select test.ok((select finds = 1 and first_time from public.find_landmark((select id from the_landmark))), 'finding a landmark');
select test.ok((select finds = 1 and not first_time from public.find_landmark((select id from the_landmark))), 'finding it again counts once');
select test.ok((select found_by_me and finds = 1 from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba1ffff', 7)])),
  'found shows up near you');
select test.throws($$ select * from public.landmark_finds $$, 'finds are not readable directly');
select test.throws($$ insert into public.landmark_finds (landmark_id, user_id) values ((select id from the_landmark), auth.uid()) $$,
  'no direct finds');
delete from public.landmarks where id = (select id from the_landmark);
select test.throws($$ select public.find_landmark(-1) $$, 'finding a landmark that is gone');
select test.throws($$ select * from public.landmarks_near(array_fill('873e6281bffffff'::text, array[51])) $$, 'too many blocks');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select author = 'Alice' from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba1ffff', 7)])),
  'friends see who left it');
select public.find_landmark((select id from the_landmark));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.ok((select finds = 2 and last_found is not null from public.my_landmarks()), 'the author sees how many found it');
select test.ok(exists (select 1 from public.landmarks where id = (select id from the_landmark)),
  'a stranger could not delete it');

-- Points: leave +3, find +2, found +1 for the author. alice's 24 removed landmarks earned nothing.
reset role;
select test.ok((select sum(points) from public.landmark_points where user_id = '00000000-0000-0000-0000-00000000000a') = 5
    and (select sum(points) from public.landmark_points where user_id = '00000000-0000-0000-0000-00000000000c') = 2
    and (select sum(points) from public.landmark_points where user_id = '00000000-0000-0000-0000-00000000000b') = 2,
  'leaving and finding landmarks earn points');
select test.ok(abs(public.score_now('00000000-0000-0000-0000-00000000000c', null)
    - (select sum(public.hex_value(visits) * public.heat(last_visited, now())) from public.user_cells
       where user_id = '00000000-0000-0000-0000-00000000000c') - 2) < 0.01,
  'landmark points count in the score');
select test.ok(public.score_gained('00000000-0000-0000-0000-00000000000c', now() - interval '1 hour', null, 'r10') >= 2
    and not exists (select 1 from public.landmark_points p
      where p.user_id = '00000000-0000-0000-0000-00000000000c' and public.landmark_points_in(p, 'r20')),
  'in the landmark''s district');
select test.ok(exists (select 1 from public.everyone_ranking(now() - interval '1 hour', null)
    where user_id = '00000000-0000-0000-0000-00000000000c' and value >= 2), 'and on this week''s boards');

-- Votes: only finders, up or down, changeable. A thumbs up is a point for the author.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select test.throws($$ select public.vote_landmark((select id from the_landmark), 1) $$, 'find it before voting');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.throws($$ select public.vote_landmark((select id from the_landmark), 0) $$, 'up or down only');
select test.ok((select ups = 1 and downs = 0 from public.vote_landmark((select id from the_landmark), 1)), 'thumbs up');
select test.ok((select my_vote = 1 and ups = 1 from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba1ffff', 7)])),
  'your vote shows near you');
reset role;
select test.ok((select sum(points) from public.landmark_points where user_id = '00000000-0000-0000-0000-00000000000a') = 6,
  'a thumbs up gives the author a point');
set role authenticated;
select test.ok((select ups = 0 and downs = 1 from public.vote_landmark((select id from the_landmark), -1)), 'changing your vote');
reset role;
select test.ok((select sum(points) from public.landmark_points where user_id = '00000000-0000-0000-0000-00000000000a') = 5,
  'and the point goes again');
-- Voted down enough: hidden from everyone but the author.
set role authenticated;
select test.throws($$ insert into public.landmark_points (user_id, cell, reason, points)
  values (auth.uid(), '8a3e6281ba1ffff', 'left', 100) $$, 'no direct points');
select test.throws($$ select * from public.landmark_points $$, 'points are not readable directly');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select public.find_landmark((select id from the_landmark));
select public.vote_landmark((select id from the_landmark), -1);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select downs = 3 from public.vote_landmark((select id from the_landmark), -1)), 'three downs');
select test.ok((select count(*) from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba1ffff', 7)])) = 0,
  'a landmark voted down is hidden');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.ok((select buried and downs = 3 from public.my_landmarks()), 'the author still sees it, marked hidden');
select test.ok((select count(*) from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba1ffff', 7)])) = 1,
  'and near them');
-- Removing a landmark takes back its author's points; finders keep theirs.
insert into public.landmarks (cell, kind, title) values ('8a3e6281ba17fff', 'art', 'Mural');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select public.find_landmark((select id from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba17fff', 7)]) where title = 'Mural'));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
delete from public.landmarks where title = 'Mural';
reset role;
select test.ok((select sum(points) from public.landmark_points where user_id = '00000000-0000-0000-0000-00000000000a') = 6
    and (select sum(points) from public.landmark_points where user_id = '00000000-0000-0000-0000-00000000000c') = 4,
  'removing a landmark takes back the author''s points only');
-- On a hex its author never walked, the points still count where the hex is
-- (from other explorers' tags for it).
delete from public.user_cells where user_id = '00000000-0000-0000-0000-00000000000d' and cell = '8a3e6281ba1ffff';
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
insert into public.landmarks (cell, kind, title) values ('8a3e6281ba1ffff', 'food', 'Kiosk');
reset role;
select test.ok((select public.landmark_points_in(p, 'r10') and not public.landmark_points_in(p, 'r20')
    from public.landmark_points p where p.user_id = '00000000-0000-0000-0000-00000000000d' and p.reason = 'left'),
  'landmark points on an unwalked hex count in its district');
select test.ok(exists (select 1 from public.area_ranking('r10', now() - interval '1 hour', null)
    where user_id = '00000000-0000-0000-0000-00000000000d'), 'and on its district board');
delete from public.landmarks where title = 'Kiosk';
set role authenticated;

-- ---------- belonging: welcome landmarks, area pulse, firsts ----------
-- alice walked Z1–Z3 in Zamalek (r10).
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.landmarks (cell, kind, title, welcome) values ('8a3e6281ba17fff', 'food', 'Koshary, no sign', true);
select test.ok((select welcome from public.landmarks_near(array[public.h3_to_parent('8a3e6281ba17fff', 7)])
    where title = 'Koshary, no sign'), 'a landmark can welcome newcomers');
select test.ok((select welcome from public.my_landmarks() where title = 'Koshary, no sign'), 'and its author sees that');
select test.ok((select not welcome from public.my_landmarks() where title = 'Nile view'),
  'landmarks are not welcomes unless asked');
create temp table pulse_alice as
  select * from public.area_pulse('r10', array[public.h3_to_parent('8a3e6281ba17fff', 7)]);
select test.ok((select exists (select 1 from jsonb_array_elements(pins) p
    where p->>'cell' = '8a3e6281ba17fff' and (p->>'welcome')::boolean) from pulse_alice), 'pins show where landmarks are');
select test.ok((select not exists (select 1 from jsonb_array_elements(pins) p
    where p->>'cell' = '8a3e6281ba1ffff') from pulse_alice), 'but not landmarks voted down');
select test.ok((select not exists (select 1 from jsonb_array_elements(pins) p, jsonb_object_keys(p) k
    where k not in ('cell', 'ups', 'welcome')) from pulse_alice), 'and nothing else about them');
select test.ok((select explorers = 0 and landmarks = 0 and cafes = 0 and ordinal = 1 and jsonb_array_length(pins) >= 1
    from public.area_pulse(null, array[public.h3_to_parent('8a3e6281ba17fff', 7)])), 'no district: only pins');
select test.throws($$ select * from public.area_pulse('zamalek', '{}') $$, 'district ids are checked');
select test.throws($$ select * from public.area_pulse('r10', array['8a3e6281ba17fff']) $$, 'blocks are resolution 7');
select test.throws($$ select * from public.area_pulse('r10', array_fill('873e6281bffffff'::text, array[8])) $$,
  'at most 7 blocks');
select test.ok((select walked and left_one and home is null from public.my_firsts()),
  'your neighbourhood firsts (home waits until you choose one)');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select found from public.my_firsts()), 'finding a landmark is a first');

reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
create temp table pulse_anon as
  select * from public.area_pulse('r10', array[public.h3_to_parent('8a3e6281ba17fff', 7)]);
select test.throws($$ select * from public.my_firsts() $$, 'anon has no firsts');
reset role;
select test.ok((select a.explorers = b.explorers and a.landmarks = b.landmarks and a.pins = b.pins from pulse_anon a, pulse_alice b),
  'anyone can see the pulse, signed in or not');
select test.ok((select ordinal = (select count(distinct user_id) from public.user_cells where district = 'r10') + 1 from pulse_anon),
  'signed out, you would be the next explorer');
select test.ok((select ordinal = (select n from (
    select user_id, row_number() over (order by min(first_visited), user_id) as n
    from public.user_cells where district = 'r10' group by user_id) x
    where user_id = '00000000-0000-0000-0000-00000000000a') from pulse_alice),
  'an explorer of the district gets their place in it, by when they first walked there');
select test.ok((select explorers = (select count(*) from (select user_id from public.user_cells where district = 'r10'
    group by user_id having max(last_visited) >= now() - interval '60 days') x) from pulse_alice),
  'explorers are the people who walked there lately');
select test.ok((select landmarks = 1 from pulse_alice), 'landmarks in the district, not counting hidden ones');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
delete from public.landmarks where title = 'Koshary, no sign';

-- ---------- circles ----------
-- alice starts one; bob and dave join with its code; carol asks to come along as a guest.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.throws($$ select public.create_circle(' ', 4, '18:00', 'Africa/Cairo', '8a3e6281ba1ffff') $$, 'a circle needs a name');
select test.throws($$ select public.create_circle('X', 4, '25:00', 'Africa/Cairo', '8a3e6281ba1ffff') $$, 'times are checked');
select test.throws($$ select public.create_circle('X', 7, '18:00', 'Africa/Cairo', '8a3e6281ba1ffff') $$, 'days are checked');
select test.throws($$ select public.create_circle('X', 4, '18:00', 'Mars/Olympus', '8a3e6281ba1ffff') $$, 'time zones are checked');
select test.throws($$ select public.create_circle('X', 4, '18:00', 'Africa/Cairo', 'nowhere') $$, 'meeting points are checked');
create temp table the_circle as
  select public.create_circle('  Thursday Walkers ', 4, '18:00', 'Africa/Cairo', '8a3e6281ba1ffff', 'Corniche steps') as id;
create temp table circle_view as select * from public.my_circles();
select test.ok((select name = 'Thursday Walkers' and role = 'owner' and district = 'r10' and district_name = 'Zamalek'
    and not guests and goal_km = 30 and jsonb_array_length(members) = 1 from circle_view),
  'starting a circle: you own it, in the meeting point''s district, and guests are off');
select test.ok((select extract(dow from (next->>'starts_at')::timestamptz at time zone 'Africa/Cairo') = 4
    and to_char((next->>'starts_at')::timestamptz at time zone 'Africa/Cairo', 'HH24:MI') = '18:00'
    and (next->>'starts_at')::timestamptz > now() from circle_view),
  'its first walk is booked for the next Thursday at 18:00, Cairo time');
select test.throws($$ select * from public.circles $$, 'circles are not readable directly');
select test.throws($$ select * from public.session_people $$, 'nor who is on a walk');
select test.throws($$ insert into public.circle_members (circle_id, user_id) values ((select id from the_circle), auth.uid()) $$,
  'no joining without the code');
create temp table circle_session as select (next->>'id')::bigint as id, code from circle_view;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok(not exists (select 1 from public.circles_near('r10')), 'circles are not listed unless they welcome guests');
select test.throws($$ select public.ask_to_join((select id from circle_session)) $$, 'and take no guests');
select test.throws($$ select public.rsvp((select id from circle_session), 'in') $$, 'strangers cannot answer for a walk');
select test.throws($$ select * from public.my_circle((select id from the_circle)) $$, 'nor see the circle');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select public.update_circle((select id from the_circle), 'Thursday Walkers', 4, '18:00', 'Africa/Cairo', '8a3e6281ba1ffff',
  'Corniche steps', 30, true);
select test.ok((select next->>'id' from public.my_circles())::bigint = (select id from circle_session),
  'changing only the guests setting keeps the booked walk');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select size = 1 and weekday = 4 and at_time = '18:00' and asked is null from public.circles_near('r10')),
  'welcoming guests: listed by size and schedule');
select test.ok(not exists (select 1 from public.circles_near('r20')), 'only in its own district');
select public.ask_to_join((select id from circle_session));
select test.ok((select not approved and circle_name is null and meet_cell is null and people is null from public.my_guest_walks()),
  'until the owner says yes, a guest knows only the schedule');
select test.ok((select asked = 'asked' from public.circles_near('r10')), 'and sees they asked');
select set_config('realtime.topic', 'circle-session:' || (select id from circle_session), false);
select test.throws($$ insert into realtime.messages (topic, event) values (realtime.topic(), 'hexes') $$,
  'a guest waiting for an answer cannot join the live walk');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select id from public.join_circle(lower((select code from circle_session)))) = (select id from the_circle),
  'joining with the code');
select public.join_circle((select code from circle_session));
select test.ok((select jsonb_array_length(members) = 2 and role = 'member' from public.my_circles()), 'joining twice is joining once');
select test.ok((select not exists (select 1 from jsonb_array_elements(next->'people') p where p->>'name' = 'carol')
    from public.my_circles()), 'only the owner sees guests who asked');
select test.throws($$ select public.update_circle((select id from the_circle), 'Mine now', 4, '18:00', 'Africa/Cairo',
  '8a3e6281ba1ffff', null, 30, true) $$, 'only the owner changes the circle');
select test.throws($$ select public.answer_guest((select id from circle_session), '00000000-0000-0000-0000-00000000000c', true) $$,
  'or answers guests');
select public.rsvp((select id from circle_session), 'out');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select public.join_circle((select code from circle_session));

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.ok((select exists (select 1 from jsonb_array_elements(next->'people') p where p->>'name' = 'carol' and not (p->>'approved')::boolean)
    and exists (select 1 from jsonb_array_elements(next->'people') p where p->>'name' = 'bob' and p->>'rsvp' = 'out')
    from public.my_circles()), 'the owner sees who asked and who can''t make it');
select test.ok((select bool_and(m ? 'walked_week') and not bool_or(m ? 'last_walk')
    from public.my_circles(), jsonb_array_elements(members) m), 'members see whether each walked this week, not when');
select public.answer_guest((select id from circle_session), '00000000-0000-0000-0000-00000000000c', true);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select approved and circle_name = 'Thursday Walkers' and meet_cell = '8a3e6281ba1ffff'
    and people = array['Alice', 'bob', 'dave'] from public.my_guest_walks()),
  'once approved, a guest sees the circle, where to meet and first names');
select test.ok((select count(*) from realtime.messages) = 0, 'and can read the live walk');
insert into realtime.messages (topic, event) values (realtime.topic(), 'hexes');
select test.throws($$ select public.circle_check_in((select id from circle_session), '8a3e6281ba17fff') $$,
  'no checking in days before the walk');

-- The walk is about to start.
reset role;
update public.circle_sessions set starts_at = now() + interval '10 minutes' where id = (select id from circle_session);
set role authenticated;
select test.throws($$ select public.circle_check_in((select id from circle_session), '8a3e628c24cffff') $$,
  'check in at the meeting point, not across town');
select test.ok((select count(*) = 1 from public.circle_check_in((select id from circle_session), '8a3e6281ba17fff')),
  'a guest checks in at the meeting point, on a hex they never walked');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select test.ok((select count(*) = 2 from public.circle_check_in((select id from circle_session), '8a3e6281baaffff')),
  'then a member');
reset role;
select test.ok((select count(*) = 2 and bool_and(met_with is not null) from public.checkins
    where kind = 'meetup' and user_id in ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d')),
  'two on the walk checked in: a verified meetup each, though they aren''t friends');
select test.ok(not public.are_friends('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d'),
  'walking together doesn''t make you friends');
set role authenticated;
select test.ok((select met from public.my_firsts()), 'walking with someone is a first');
select public.log_circle_walk((select id from circle_session), now(), 2.1, 12);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.throws($$ select public.log_circle_walk((select id from circle_session), now(), 1, 1) $$,
  'check in before walking together');
select test.throws($$ select public.circle_kudos_toggle((select id from circle_session), '00000000-0000-0000-0000-00000000000d', true) $$,
  'kudos are for people who walked together');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select public.log_circle_walk((select id from circle_session), now(), 1.9, 9);
select public.circle_kudos_toggle((select id from circle_session), '00000000-0000-0000-0000-00000000000d', true);
select test.throws($$ select public.circle_kudos_toggle((select id from circle_session), auth.uid(), true) $$, 'no kudos to yourself');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select test.ok((select count(*) = 2 and sum(hexes) = 21 and bool_or(me and kudos = 1) and bool_and(circle_name = 'Thursday Walkers')
    from public.circle_walk((select id from circle_session))), 'the circle walk: who came, what each walked, kudos');
select test.ok((select week_km = 4 and streak = 1 from public.my_circles()), 'this week counts, and its km go to the goal');

-- Booking next week, and changing the day.
create temp table booked as select public.book_next((select id from the_circle)) as t;
select test.ok((select t > now() and extract(dow from t at time zone 'Africa/Cairo') = 4
    and to_char(t at time zone 'Africa/Cairo', 'HH24:MI') = '18:00' from booked), 'same time next week, booked');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select public.update_circle((select id from the_circle), 'Thursday Walkers', 6, '07:00', 'Africa/Cairo', '8a3e6281ba1ffff',
  null, 30, false);
reset role;
select test.ok(exists (select 1 from public.circle_sessions where id = (select id from circle_session)),
  'a new day keeps a walk people already checked in to');
select test.ok((select count(*) = 1 and bool_and(extract(dow from starts_at at time zone 'Africa/Cairo') = 6)
    from public.circle_sessions where circle_id = (select id from the_circle) and starts_at > now() + interval '1 hour'),
  'and moves the walks ahead to the new day');

-- The streak: weeks with two or more together; one missed week a month is forgiven.
create temp table streak_circles (n int, id bigint);
insert into public.circles (name, meet_cell, weekday, at_time, tz, created_at)
  values ('S1', '8a3e6281ba1ffff', 1, '09:00', 'UTC', date_trunc('week', now() at time zone 'UTC') at time zone 'UTC' - interval '21 days'),
         ('S2', '8a3e6281ba1ffff', 1, '09:00', 'UTC', date_trunc('week', now() at time zone 'UTC') at time zone 'UTC' - interval '21 days');
insert into streak_circles select 1, id from public.circles where name = 'S1';
insert into streak_circles select 2, id from public.circles where name = 'S2';
create function test.walked(circle bigint, weeks_ago int) returns void language sql as $$
  with s as (insert into public.circle_sessions (circle_id, starts_at)
    values (circle, date_trunc('week', now() at time zone 'UTC') at time zone 'UTC' - weeks_ago * interval '7 days' + interval '1 hour')
    returning id)
  insert into public.session_people (session_id, user_id, checked_in_at)
  select s.id, u, now() from s, unnest(array['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000d']::uuid[]) u
$$;
-- S1: this week, last week, missed one, the week before.
select test.walked((select id from streak_circles where n = 1), w) from unnest(array[0, 1, 3]) w;
select test.ok((select weeks = 3 from public.circle_streak((select id from streak_circles where n = 1))),
  'a missed week is forgiven');
-- S2: this week, two missed, the week before.
select test.walked((select id from streak_circles where n = 2), w) from unnest(array[0, 3]) w;
select test.ok((select weeks = case when date_trunc('month', date_trunc('week', now() at time zone 'UTC') - interval '7 days')
      = date_trunc('month', date_trunc('week', now() at time zone 'UTC') - interval '14 days') then 1 else 2 end
    from public.circle_streak((select id from streak_circles where n = 2))),
  'two missed weeks in one month end the streak');
delete from public.circles where name in ('S1', 'S2');

-- A circle is in its meeting point's district, never its owner's home (alice's is Zamalek).
-- 8a3e628c24dffff and 8a3e628c24effff: nobody has walked them. M1: bob tagged it Maadi.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
create temp table d_circles as select
  public.create_circle('D1', 1, '09:00', 'UTC', '8a3e628c24dffff', null, 30, true, 'r20') as looked_up,
  public.create_circle('D2', 1, '09:00', 'UTC', '8a3e628c24dffff', null, 30, true, 'zamalek') as unknown;
reset role;
select test.ok((select district from public.circles where id = (select looked_up from d_circles)) = 'r20',
  'a circle on an unwalked hex is in the district the app looked up for it');
select test.ok((select district is null from public.circles where id = (select unknown from d_circles)),
  'with no district to go on it has none, not its owner''s home');
set role authenticated;
select test.ok(not exists (select 1 from public.circles_near('r10') where id = (select unknown from d_circles)),
  'so it isn''t listed for guests in the owner''s district');
select public.update_circle((select unknown from d_circles), 'D2', 1, '09:00', 'UTC', '8a3e628c24cffff', null, 30, true, 'r10');
select public.update_circle((select looked_up from d_circles), 'D1', 1, '09:00', 'UTC', '8a3e628c24dffff', null, 30, true);
reset role;
select test.ok((select district from public.circles where id = (select unknown from d_circles)) = 'r20',
  'moving the meeting point moves the circle to the district walkers tagged there, over the app''s lookup');
select test.ok((select district from public.circles where id = (select looked_up from d_circles)) = 'r20',
  'a circle that stays put keeps its district when the app can''t tell');
set role authenticated;
select public.update_circle((select looked_up from d_circles), 'D1', 1, '09:00', 'UTC', '8a3e628c24effff', null, 30, true);
reset role;
select test.ok((select district is null from public.circles where id = (select looked_up from d_circles)),
  'one moved somewhere nobody can tell has no district');
delete from public.circles where id in (select looked_up from d_circles union select unknown from d_circles);

-- Leaving: the longest-standing member takes over; the last one out takes the circle.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select public.leave_circle((select id from the_circle));
select test.ok(not exists (select 1 from public.my_circles()), 'leaving a circle');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select role = 'owner' and jsonb_array_length(members) = 2 from public.my_circles()),
  'the next member takes over from an owner who leaves');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select public.leave_circle((select id from the_circle));
-- (bob deletes his account below: the circle goes with its last member)
reset role;
delete from public.checkins where kind = 'meetup'
  and user_id in ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d');
select set_config('realtime.topic', '', false);

-- ---------- belonging: home, matchups, open challenges, reactions, invites ----------
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
create temp table warmth as select * from public.district_warmth('r10');
reset role;
select test.ok((select w.hexes = (select count(distinct cell) from public.user_cells where district = 'r10')
    and w.warm = (select count(*) from (select cell from public.user_cells where district = 'r10'
      group by cell having max(last_visited) >= now() - interval '60 days') x)
    and w.pct = round(100.0 * w.warm / w.hexes)
    and w.mine_warm = (select count(*) from public.user_cells where user_id = '00000000-0000-0000-0000-00000000000a'
      and district = 'r10' and last_visited >= now() - interval '60 days')
    from warmth w), 'district warmth: hexes walked by anyone in the last 60 days, and yours');
set role authenticated;
select test.throws($$ select * from public.district_warmth('zamalek') $$, 'district ids are checked');

create temp table matchup as select * from public.district_matchup('r10');
select test.ok((select rival is not null and rival <> 'r10' and pct between 0 and 100 and ends_at > now() from matchup),
  'a district gets a rival in its city for the week');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select test.ok((select rival = 'r10' from public.district_matchup((select rival from matchup))), 'and its rival is paired back');
select test.ok((select rival from public.district_matchup('r10')) = (select rival from matchup), 'the pairing stays for the week');
select test.throws($$ select * from public.district_matchups $$, 'pairings are not readable directly');

reset role;
create temp table open_challenge as select public.add_area_challenge('r10', 'Warm Z1 and Z2', 'Two hexes by the river', 'cells', null,
  array['8a3e6281ba1ffff', '8a3e6281ba17fff']) as id;
grant select on open_challenge to authenticated;
select public.add_area_challenge('r10', 'Over already', null, 'warmth', 50, null, now() - interval '10 days', now() - interval '1 day');
select public.add_area_challenge('r20', 'Elsewhere', null, 'landmarks');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.throws($$ select public.add_area_challenge('r10', 'Mine', null, 'warmth', 50) $$, 'only admins add open challenges');
select test.ok((select count(*) = 1 and bool_and(title = 'Warm Z1 and Z2' and not joined and members = 0 and progress = 1)
    from public.area_challenges_for('r10')), 'the challenges running in a district, with how far along they are');
select public.join_area_challenge((select id from open_challenge), true);
select test.ok((select joined and members = 1 from public.area_challenges_for('r10')), 'joining one');
select public.join_area_challenge((select id from open_challenge), false);
select test.ok((select not joined and members = 0 from public.area_challenges_for('r10')), 'and leaving it');

-- Reactions: alice and bob are friends; carol isn't.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
create temp table bob_checkin as select id::text as item from public.checkins
  where user_id = '00000000-0000-0000-0000-00000000000b' order by id limit 1;
select public.react('checkin', (select item from bob_checkin), '🔥');
select public.react('badge', '00000000-0000-0000-0000-00000000000b:first_meetup', '👏');
select test.throws($$ select public.react('checkin', (select id::text from public.checkins
  where user_id = auth.uid() limit 1), '🔥') $$, 'no kudos to yourself');
select test.throws($$ select public.react('badge', '00000000-0000-0000-0000-00000000000b:hex_10000', '👏') $$, 'only on things that exist');
select test.throws($$ select public.react('checkin', (select item from bob_checkin), '💩') $$, 'the four kudos only');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.throws($$ select public.react('checkin', (select item from bob_checkin), '👏') $$, 'kudos are for friends');
select test.ok(not exists (select 1 from public.reactions_for('checkin', array[(select item from bob_checkin)])),
  'and strangers don''t see them');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select n = 1 and emoji = '🔥' and not mine from public.reactions_for('checkin', array[(select item from bob_checkin)])),
  'reactions on a check-in');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select public.react('checkin', (select item from bob_checkin), '❤️');
select test.ok((select count(*) = 1 and bool_and(emoji = '❤️' and mine) from public.reactions_for('checkin', array[(select item from bob_checkin)])),
  'one reaction each: picking another changes it');
select public.react('checkin', (select item from bob_checkin), null);
select test.ok(not exists (select 1 from public.reactions_for('checkin', array[(select item from bob_checkin)])), 'and it can be taken back');

-- Your landmark was found: when, never by whom (vote totals are public, so a name would give a vote away).
create temp table finds_feed as select * from public.landmark_finds_feed(now() + interval '1 minute');
reset role;
select test.ok((select count(*) = (select count(*) from public.landmark_finds f join public.landmarks l on l.id = f.landmark_id
        where l.user_id = '00000000-0000-0000-0000-00000000000a') and count(*) > 0 and bool_or(title = 'Nile view')
    from finds_feed), 'your feed shows every find of your landmarks');
select test.ok(not exists (select 1 from information_schema.columns c
    where c.table_name = 'finds_feed' and c.column_name not in ('landmark_id', 'kind', 'title', 'found_at')),
  'and never who found it');
set role authenticated;
select test.throws($$ select public.react('find', '1:00000000-0000-0000-0000-00000000000b', '👣') $$, 'finds take no kudos');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok(not exists (select 1 from public.landmark_finds_feed(now() + interval '1 minute') x
    where x.landmark_id in (select landmark_id from finds_feed)), 'nobody else''s');

-- Personal invite codes.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.landmarks (cell, kind, title, welcome) values ('8a3e6281baaffff', 'food', 'Corner café', true);
select test.ok((select code is null and landmark_title = 'Corner café' from public.new_invite(false)),
  'no code until you share one, but you see which welcome it would carry');
create temp table invite as select * from public.new_invite();
select test.ok((select code ~ '^ZAM-[A-Z0-9]{4}-[A-Z0-9]{4}$' and expires_at > now() + interval '6 days' and landmark_title = 'Corner café' from invite),
  'a personal code, named for your district, carrying your welcome landmark');
select test.ok((select code from public.new_invite()) = (select code from invite), 'the open code is reused until it''s used');
select test.ok((select code from public.new_invite(false)) = (select code from invite), 'and shown when you look');
select test.throws($$ select * from public.use_invite((select code from invite)) $$, 'not your own');
select test.throws($$ select * from public.invite_codes $$, 'codes are not readable directly');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select status = 'accepted' and username = 'alice' and landmark_id is not null
    from public.use_invite(lower((select code from invite)))), 'using it: friends straight away, with a welcome to find');
reset role;
select test.ok((select status = 'accepted' and expires_at between now() + interval '29 days' and now() + interval '31 days'
    from public.friendships where requester = '00000000-0000-0000-0000-00000000000a' and addressee = '00000000-0000-0000-0000-00000000000c'),
  'for the usual 30 days');
update public.friendships set expires_at = now() + interval '3 days'
  where requester = '00000000-0000-0000-0000-00000000000a' and addressee = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
select test.ok((select status = 'already' from public.use_invite((select code from invite))), 'using it again changes nothing');
reset role;
select test.ok((select expires_at < now() + interval '4 days' from public.friendships
    where requester = '00000000-0000-0000-0000-00000000000a' and addressee = '00000000-0000-0000-0000-00000000000c'),
  'a code never renews a friendship: that stays a choice you both make');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select test.ok((select status = 'invalid' and id is null from public.use_invite((select code from invite))),
  'each code works for one person');
select test.ok((select status = 'invalid' and id is null from public.use_invite('ZAM-AAAA-AAAA')),
  'an unknown code gets the same answer as a used one');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.ok((select used_by_name = 'carol' from public.my_invites() where code = (select code from invite)), 'you see who used your code');
create temp table invite2 as select * from public.new_invite();
grant select on invite2 to authenticated;
select test.ok((select code from invite2) <> (select code from invite), 'and the next one is new');

-- A lapsed friendship: the code says so, renews nothing, and stays open.
reset role;
update public.friendships set expires_at = now() - interval '2 days'
  where requester = '00000000-0000-0000-0000-00000000000a' and addressee = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select status = 'lapsed' and username = 'alice' from public.use_invite((select code from invite2))),
  'a code with a lapsed friend says so');
reset role;
select test.ok((select expires_at < now() from public.friendships
    where requester = '00000000-0000-0000-0000-00000000000a' and addressee = '00000000-0000-0000-0000-00000000000c')
    and (select used_by is null from public.invite_codes where code = (select code from invite2)),
  'without renewing it, and the code stays open for someone new');

-- Guessing: 10 wrong codes an hour, then even a right one waits.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select count(*) from generate_series(1, 9) n, public.use_invite('ZAM-AAAA-AAA' || n) u where u.status = 'invalid';
select test.ok((select status = 'slow_down' from public.use_invite((select code from invite2))), 'too many wrong codes: slow down');
reset role;
select test.ok((select used_by is null from public.invite_codes where code = (select code from invite2)), 'and the code isn''t used');
delete from public.invite_misses;
set role authenticated;
select test.ok((select status = 'accepted' from public.use_invite((select code from invite2))), 'an hour later it works');
reset role;
delete from public.friendships where requester = '00000000-0000-0000-0000-00000000000a' and addressee = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
reset role;
create temp table carol_code as select invite_code as code from public.profiles where username = 'carol';
grant select on carol_code to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select test.ok((select status = 'pending' and username = 'carol' and landmark_id is null
    from public.use_invite((select code from carol_code))), 'old-style codes still send a friend request');
reset role;
delete from public.friendships where requester = '00000000-0000-0000-0000-00000000000d' and addressee = '00000000-0000-0000-0000-00000000000c';
delete from public.landmarks where title = 'Corner café';
delete from public.friendships where requester = '00000000-0000-0000-0000-00000000000a' and addressee = '00000000-0000-0000-0000-00000000000c';
delete from public.reactions;

-- ---------- choosing a home district ----------
-- alice walks Zamalek (r10) most. Until she chooses, that's her home.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.ok((select name from public.my_areas() where kind = 'district') = 'Zamalek', 'until you choose, home is where you score most');
select test.ok((select home is null from public.my_firsts()), 'and "make it home" is still to do');
select test.ok((select array_agg(id || ':' || home || ':' || switch order by hexes desc) from public.home_choices()) = array['r10:false:false'],
  'the districts you could make home: the ones you walked');
select test.throws($$ select * from public.set_home_district('r20') $$, 'only a district you''ve walked can be home');
select test.throws($$ update public.profiles set home_district = 'r20' where id = auth.uid() $$, 'and only through set_home_district');

-- One hex in Maadi (r20), and she makes it home although Zamalek is warmer.
select public.sync_cells(jsonb_build_array(
  jsonb_build_object('c', '8a3e628c24cffff', 't', test.ms(), 'a', '["r1","r2","r20"]'::jsonb)), (select a from areas_json));
select test.ok((select array_agg(id order by hexes desc) from public.home_choices()) = array['r10', 'r20'], 'warmest first');
select test.ok((select id = 'r20' and name = 'Maadi' from public.set_home_district(' r20 ')), 'making Maadi home');
select test.ok((select array_agg(kind || ':' || name order by kind) from public.my_areas())
    = array['city:Cairo', 'country:Egypt', 'district:Maadi'], 'home is the one you chose, with its city and country');
select test.ok((select home = 'r20' and home_name = 'Maadi' from public.my_firsts()), '"make it home" is done');
select test.ok((select home from public.home_choices() where id = 'r20') and not (select home from public.home_choices() where id = 'r10'),
  'and marked among your choices');
select test.ok(not exists (select 1 from public.home_choices() where switch), 'a new home isn''t second-guessed');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select district_name from public.friend_stats() where username = 'alice') = 'Maadi',
  'friends see the home you chose');

-- Three weeks on, alice has walked Zamalek more than Maadi in each of the last three weeks.
reset role;
update public.profiles set home_set_at = now() - interval '22 days' where username = 'alice';
delete from public.score_events where user_id = '00000000-0000-0000-0000-00000000000a';
insert into public.score_events (user_id, day, country, city, district, points)
select '00000000-0000-0000-0000-00000000000a', (now() at time zone 'utc')::date - x.ago, 'r1', 'r2', x.district, x.points
from (values (1, 'r10', 5), (2, 'r20', 1), (9, 'r10', 5), (10, 'r20', 8)) x (ago, district, points);
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.ok(not exists (select 1 from public.home_choices() where switch), 'warmer in one week only: no question');
reset role;
insert into public.score_events (user_id, day, country, city, district, points)
values ('00000000-0000-0000-0000-00000000000a', (now() at time zone 'utc')::date - 10, 'r1', 'r2', 'r10', 5),
  ('00000000-0000-0000-0000-00000000000a', (now() at time zone 'utc')::date - 16, 'r1', 'r2', 'r10', 2)
on conflict (user_id, day, country, city, district) do update set points = score_events.points + excluded.points;
set role authenticated;
select test.ok((select switch from public.home_choices() where id = 'r10'), 'warmer than home in each of the last 3 weeks: worth asking');
select test.ok((select name from public.my_areas() where kind = 'district') = 'Maadi', 'but home never switches by itself');
select public.set_home_district('r10');
select test.ok(not exists (select 1 from public.home_choices() where switch), 'once switched, nothing to ask');
reset role;
select test.ok((select home_set_at > now() - interval '1 minute' from public.profiles where username = 'alice'), 'and the new home starts its clock');
update public.profiles set home_district = null, home_set_at = null where username = 'alice';

-- ---------- anon and account deletion ----------
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select test.throws($$ select * from public.profiles $$, 'anon has no table access');
select test.throws($$ select public.leaderboard() $$, 'anon cannot call the API');
select test.throws($$ select * from public.my_cells() $$, 'anon cannot read hexes');
select test.throws($$ select * from public.landmarks_near(array['873e6281bffffff']) $$, 'anon cannot read landmarks');
select test.throws($$ select * from public.areas $$, 'anon cannot read areas');

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select public.delete_my_account();
reset role;
select test.ok(not exists (select 1 from public.profiles where username = 'bob'), 'account deletion removes the profile');
select test.ok(not exists (select 1 from public.circles where id = (select id from the_circle)),
  'and a circle whose last member was them');
select test.ok(not exists (select 1 from public.user_cells where user_id = '00000000-0000-0000-0000-00000000000b'), 'and the cells');
select test.ok(not exists (select 1 from public.score_events where user_id = '00000000-0000-0000-0000-00000000000b'), 'and the score log');
select test.ok((select met_with from public.checkins where kind = 'meetup') is null, 'and unlinks meetups');
select test.ok((select count(*) from public.landmark_finds) = 2, 'and their landmark finds');
select test.ok(not exists (select 1 from public.landmark_points where user_id = '00000000-0000-0000-0000-00000000000b')
    and not exists (select 1 from public.landmark_points where from_user = '00000000-0000-0000-0000-00000000000b'),
  'and landmark points');

\echo 'All social schema tests passed'
