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
select test.ok((select string_agg(name, ',' order by id) from public.areas) = 'Egypt,Zamalek,Cairo,Maadi', 'area names stored');
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

-- ---------- anon and account deletion ----------
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select test.throws($$ select * from public.profiles $$, 'anon has no table access');
select test.throws($$ select public.leaderboard() $$, 'anon cannot call the API');
select test.throws($$ select * from public.areas $$, 'anon cannot read areas');

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select public.delete_my_account();
reset role;
select test.ok(not exists (select 1 from public.profiles where username = 'bob'), 'account deletion removes the profile');
select test.ok(not exists (select 1 from public.user_cells where user_id = '00000000-0000-0000-0000-00000000000b'), 'and the cells');
select test.ok(not exists (select 1 from public.score_events where user_id = '00000000-0000-0000-0000-00000000000b'), 'and the score log');
select test.ok((select met_with from public.checkins where kind = 'meetup') is null, 'and unlinks meetups');

\echo 'All social schema tests passed'
