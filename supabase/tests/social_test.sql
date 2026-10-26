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
grant execute on all functions in schema test to anon, authenticated;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.com'),
  ('00000000-0000-0000-0000-00000000000d', 'dave@example.com');

-- ---------- H3 parent ----------
select test.ok(public.h3_to_parent('8a1f1d48945ffff', 8) = '881f1d4895fffff', 'res 8 parent matches h3-js');
select test.ok(public.h3_to_parent('8a1f1d48945ffff', 9) = '891f1d48947ffff', 'res 9 parent matches h3-js');

-- ---------- profiles ----------
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.profiles (id, username, display_name) values (auth.uid(), 'alice', 'Alice');
select test.throws($$ select invite_code from public.profiles $$, 'invite codes are not readable');
select test.ok(public.my_invite_code() ~ '^[0-9A-F]{8}$', 'own invite code available via RPC');
select test.throws($$ insert into public.profiles (id, username) values ('00000000-0000-0000-0000-00000000000b', 'mallory') $$,
  'cannot create a profile for someone else');
select test.throws($$ update public.profiles set invite_code = 'AAAAAAAA' $$, 'cannot change invite code');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into public.profiles (id, username) values (auth.uid(), 'bob');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
insert into public.profiles (id, username) values (auth.uid(), 'carol');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
insert into public.profiles (id, username, leaderboard_public) values (auth.uid(), 'dave', true);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select count(*) from public.profiles) = 2, 'stranger sees only self and public profiles');

-- ---------- cells ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.ok(public.sync_cells('[
  {"c": "8a1f1d48945ffff", "t": 1760000000000, "v": 3},
  {"c": "8a1f1d489457fff", "t": 1760000000000, "v": 1},
  {"c": "8a1f1d4894effff", "t": 1760000000000}
]') = 3, 'sync inserts cells');
select public.sync_cells('[{"c": "8a1f1d48945ffff", "t": 1750000000000, "v": 2}]');
select test.ok((select visits = 3 and first_visited = to_timestamp(1750000000) from public.user_cells where cell = '8a1f1d48945ffff'),
  'sync keeps max visits and earliest first visit');
select test.throws($$ select public.sync_cells('[{"c": "891f1d48947ffff", "t": 1760000000000}]') $$, 'only res-10 cells');
select test.throws($$ insert into public.user_cells (user_id, cell, first_visited) values (auth.uid(), '8a1fb466249ffff', now()) $$,
  'no direct inserts into user_cells');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select public.sync_cells('[{"c": "8a1f1d48945ffff", "t": 1760000000000}, {"c": "8a1fb466249ffff", "t": 1760000000000}]');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
select public.sync_cells('[{"c": "8a1f1d4897b7fff", "t": 1760000000000}]');

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

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select count(*) from public.user_cells) = 0, 'stranger sees no cells');

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

-- ---------- check-ins ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select test.throws($$ insert into public.checkins (cell, kind) values ('8a1fb466249ffff', 'coffee') $$,
  'cannot check in to an unvisited hex');
insert into public.checkins (cell, kind, note) values ('8a1f1d48945ffff', 'coffee', 'flat white');
select test.throws($$ insert into public.checkins (cell, kind) values ('8a1f1d48945ffff', 'coffee') $$,
  'one check-in per kind, hex and day');
select test.throws($$ insert into public.checkins (cell, kind) values ('8a1f1d48945ffff', 'photo') $$,
  'photo check-in needs a photo');
select test.throws($$ insert into public.checkins (cell, kind, photo_path) values ('8a1f1d489457fff', 'photo', '00000000-0000-0000-0000-00000000000b/x.jpg') $$,
  'photo must be in own folder');
insert into public.checkins (cell, kind, photo_path)
  values ('8a1f1d489457fff', 'photo', '00000000-0000-0000-0000-00000000000a/one.jpg');
insert into public.checkins (cell, kind) values ('8a1f1d48945ffff', 'meetup');
select test.ok((select met_with from public.checkins where kind = 'meetup') is null, 'meetup unverified until a friend checks in');
select test.throws($$ update public.checkins set met_with = '00000000-0000-0000-0000-00000000000b' $$,
  'cannot verify a meetup yourself');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into public.checkins (cell, kind) values ('8a1f1d48945ffff', 'meetup');
select test.ok((select count(*) from public.checkins where kind = 'meetup' and met_with is not null) = 2,
  'friend meetup verifies both check-ins');
select test.ok((select count(*) from public.badges where badge_key = 'first_meetup') = 2, 'both get the meetup badge');

-- ---------- scores and leaderboards ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
-- alice: 3 new hexes + floor(log2(3)) = 1 + coffee 2 + photo 3 + meetup 5 = 14
select test.ok((select value from public.leaderboard('friends', 'score', 'all') where username = 'alice') = 14,
  'all-time score adds hexes, regulars and check-ins');
select test.ok((select array_agg(username order by username) from public.leaderboard('friends', 'hexes', 'all')) = array['alice', 'bob'],
  'friends leaderboard has only self and friends');
select test.ok((select array_agg(username) from public.leaderboard('public', 'hexes', 'all')) = array['dave'],
  'public leaderboard has only opted-in users');
select test.throws($$ select public.score_between(auth.uid(), null, null, null) $$, 'internal score helper not callable');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
select test.ok((select array_agg(cell) from public.collective_map(array['881f1d4895fffff', '881f1d4897fffff'])) = array['891f1d4897bffff'],
  'stranger sees only public explorers on the community map');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select test.ok((select explorers from public.collective_map(array['881f1d4895fffff']) where cell = '891f1d48947ffff') = 2,
  'community map counts friends exploring the same block');

-- ---------- challenges ----------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into public.challenges (title, metric, ends_at) values ('October hexes', 'hexes', now() + interval '7 days');
insert into public.challenge_members (challenge_id, user_id) select id, '00000000-0000-0000-0000-00000000000b' from public.challenges;
select test.throws($$ insert into public.challenge_members (challenge_id, user_id) select id, '00000000-0000-0000-0000-00000000000c' from public.challenges $$,
  'can only invite friends');
reset role;
create temp table the_challenge as select id from public.challenges limit 1;
grant select on the_challenge to authenticated;
set role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
update public.challenge_members set status = 'joined' where user_id = auth.uid();
select test.ok((select count(*) from public.challenge_standings((select id from the_challenge)) where status = 'joined') = 2,
  'invitee joins and sees standings');
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

-- ---------- anon and account deletion ----------
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select test.throws($$ select * from public.profiles $$, 'anon has no table access');
select test.throws($$ select public.leaderboard() $$, 'anon cannot call the API');

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select public.delete_my_account();
reset role;
select test.ok(not exists (select 1 from public.profiles where username = 'bob'), 'account deletion removes the profile');
select test.ok(not exists (select 1 from public.user_cells where user_id = '00000000-0000-0000-0000-00000000000b'), 'and the cells');
select test.ok((select met_with from public.checkins where kind = 'meetup') is null, 'and unlinks meetups');

\echo 'All social schema tests passed'
