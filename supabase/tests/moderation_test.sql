-- Reporting and blocking. Runs after social_test.sql (scripts/test-db.sh),
-- with its own people, and the test.ok / test.throws helpers from there.
--   eve  leaves a landmark, owns a circle     finn  in eve's circle
--   gina a guest on eve's circle's walk       hal   in eve's circle, then not
--   ivy  a stranger who finds eve's landmark  jon   a stranger looking for circles

\set ON_ERROR_STOP 1
set client_min_messages = warning;

reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'eve@example.com'),
  ('00000000-0000-0000-0000-0000000000f1', 'finn@example.com'),
  ('00000000-0000-0000-0000-0000000000a7', 'gina@example.com'),
  ('00000000-0000-0000-0000-0000000000b8', 'hal@example.com'),
  ('00000000-0000-0000-0000-0000000000c9', 'ivy@example.com'),
  ('00000000-0000-0000-0000-0000000000d0', 'jon@example.com');
create temp table who (name text primary key, id uuid);
insert into who values
  ('eve', '00000000-0000-0000-0000-0000000000e1'), ('finn', '00000000-0000-0000-0000-0000000000f1'),
  ('gina', '00000000-0000-0000-0000-0000000000a7'), ('hal', '00000000-0000-0000-0000-0000000000b8'),
  ('ivy', '00000000-0000-0000-0000-0000000000c9'), ('jon', '00000000-0000-0000-0000-0000000000d0');
grant select on who to authenticated;
create function test.as_(person text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', (select id::text from who where name = person), false)
$$;
create function test.id(person text) returns uuid language sql stable as $$
  select id from who where name = person
$$;
grant execute on function test.as_(text), test.id(text) to authenticated;

set role authenticated;
select test.as_('eve');  insert into public.profiles (id, username, display_name) values (auth.uid(), 'eve', 'Eve Adams');
select test.as_('finn'); insert into public.profiles (id, username) values (auth.uid(), 'finn');
select test.as_('gina'); insert into public.profiles (id, username) values (auth.uid(), 'gina');
select test.as_('hal');  insert into public.profiles (id, username) values (auth.uid(), 'hal');
select test.as_('ivy');  insert into public.profiles (id, username) values (auth.uid(), 'ivy');
select test.as_('jon');  insert into public.profiles (id, username) values (auth.uid(), 'jon');

-- ---------- reporting a landmark ----------
-- Hex Z4 8a3e6281baf7fff, in block 873e6281bffffff.
reset role;
insert into public.user_cells (user_id, cell, first_visited, last_visited, district)
  select id, '8a3e6281baf7fff', now(), now(), 'r10' from who where name in ('eve', 'ivy');
set role authenticated;
select test.as_('eve');
insert into public.landmarks (cell, kind, title, note) values ('8a3e6281baf7fff', 'view', 'Rude sign', 'Something rude');
reset role;
create temp table rude as select id from public.landmarks where title = 'Rude sign';
grant select on rude to authenticated;
set role authenticated;
select test.as_('finn'); select public.find_landmark((select id from rude));
select test.as_('gina'); select public.find_landmark((select id from rude));
select test.as_('hal');  select public.find_landmark((select id from rude));

select test.as_('ivy');
select test.throws($$ select public.report_landmark((select id from rude), 'offensive') $$, 'find a landmark before reporting it');
select test.as_('eve');
select test.throws($$ select public.report_landmark((select id from rude), 'offensive') $$, 'not your own');
select test.as_('finn');
select test.throws($$ select public.report_landmark((select id from rude), 'because') $$, 'reasons are checked');
select test.throws($$ select public.report_landmark((select id from rude), 'name') $$, 'a person''s reason is not a landmark''s');
select test.ok(public.report_landmark((select id from rude), 'offensive', '  Mean  '), 'reporting a landmark you found');
select test.ok(not public.report_landmark((select id from rude), 'spam'), 'once per landmark');
select test.throws($$ select * from public.reports $$, 'reports are not readable');
select test.throws($$ insert into public.reports (reporter, kind, subject, reason, content)
  values (auth.uid(), 'person', auth.uid(), 'spam', 'x') $$, 'nor writable directly');
select test.throws($$ select * from moderation.queue $$, 'the review queue is not reachable from the API');
select test.throws($$ select moderation.resolve(1, 'keep') $$, 'nor is resolving');
select test.as_('gina');
select public.report_landmark((select id from rude), 'private');
select test.as_('ivy');
select test.ok(exists (select 1 from public.landmarks_near(array['873e6281bffffff']) where title = 'Rude sign'),
  'two reports: still on the map');

select test.as_('hal');
select public.report_landmark((select id from rude), 'offensive');
select test.as_('ivy');
select test.ok(not exists (select 1 from public.landmarks_near(array['873e6281bffffff']) where title = 'Rude sign'),
  'three reports hide a landmark');
select test.throws($$ select public.find_landmark((select id from rude)) $$, 'and it can''t be found');
select test.ok((select not (pins @> '[{"cell": "8a3e6281baf7fff"}]') from public.area_pulse('r10', array['873e6281bffffff'])),
  'nor shows as a ? pin');
select test.as_('eve');
select test.ok((select held from public.my_landmarks() where title = 'Rude sign'), 'its author sees it''s held back');
select test.ok(exists (select 1 from public.landmarks_near(array['873e6281bffffff']) where title = 'Rude sign'),
  'and still sees it on the map');

reset role;
select test.ok((select reporters = 3 and held and content = E'Rude sign\nSomething rude' and who = 'Eve Adams @eve'
    and reasons @> array['offensive', 'private'] and notes = array['Mean']
  from moderation.queue where landmark_id = (select id from rude)), 'the queue: who, what, why and how many');
select test.ok(moderation.resolve((select report_id from moderation.queue where landmark_id = (select id from rude)),
  'keep', 'just a sign') = 3, 'keeping it closes its three reports');
select test.ok(not exists (select 1 from moderation.queue), 'and empties the queue');
set role authenticated;
select test.as_('ivy');
select test.ok(exists (select 1 from public.landmarks_near(array['873e6281bffffff']) where title = 'Rude sign'),
  'kept: back on the map');

-- ---------- blocking whoever left a landmark ----------
select test.throws($$ select public.block_author((select id from rude)) $$, 'find it first');
select public.find_landmark((select id from rude));
insert into public.landmarks (cell, kind, title) values ('8a3e6281baf7fff', 'art', 'Ivy''s mural');
select public.block_author((select id from rude));
select test.ok(not exists (select 1 from public.landmarks_near(array['873e6281bffffff']) where title = 'Rude sign'),
  'you stop seeing their landmarks');
select test.ok((select name is null and from_landmark from public.my_blocks()), 'and your list never says who it was');
select test.as_('eve');
select test.ok(not exists (select 1 from public.landmarks_near(array['873e6281bffffff']) where title = 'Ivy''s mural'),
  'they stop seeing yours');
select test.as_('ivy');
select public.unblock((select id from public.my_blocks()));
select test.ok(exists (select 1 from public.landmarks_near(array['873e6281bffffff']) where title = 'Rude sign'),
  'unblocking brings them back');

-- ---------- blocking a friend ----------
reset role;
create temp table mcodes as select username, invite_code from public.profiles;
grant select on mcodes to authenticated;
set role authenticated;
select test.as_('finn');
select public.send_friend_request((select invite_code from mcodes where username = 'gina'));
select test.as_('gina');
select public.respond_friend_request(test.id('finn'), true);
select test.as_('ivy');
select test.throws($$ select public.report_person(test.id('finn'), 'name') $$, 'only people you know through Scoop');
select test.as_('gina');
select test.throws($$ select public.report_person(test.id('gina'), 'name') $$, 'not yourself');
select test.throws($$ select public.report_person(test.id('finn'), 'offensive') $$, 'a landmark''s reason is not a person''s');
select test.ok(public.report_person(test.id('finn'), 'harassment', 'kept messaging'), 'reporting a friend');
select test.ok(not public.report_person(test.id('finn'), 'name'), 'one open report per person');
select public.block_person(test.id('finn'));
select test.ok(not exists (select 1 from public.friendships), 'blocking ends the friendship');
select test.ok((select name = 'finn' and not from_landmark from public.my_blocks()), 'and lists them by name');
select test.as_('finn');
select test.ok((select status from public.send_friend_request((select invite_code from mcodes where username = 'gina'))) = 'pending',
  'a blocked person''s request looks sent');
select test.ok(not exists (select 1 from public.friendships), 'but goes nowhere');
select test.as_('gina');
select public.unblock((select id from public.my_blocks()));

-- ---------- blocking in circles ----------
select test.as_('eve');
create temp table mod_circle as
  select public.create_circle('Evening Loop', 2, '19:00', 'Africa/Cairo', '8a3e6281baf7fff', 'Kiosk') as id;
select public.update_circle((select id from mod_circle), 'Evening Loop', 2, '19:00', 'Africa/Cairo', '8a3e6281baf7fff',
  'Kiosk', 30, true);
create temp table mod_session as select (next->>'id')::bigint as id, code from public.my_circles();
grant select on mod_circle, mod_session to authenticated;
select test.as_('finn'); select public.join_circle((select code from mod_session));
select test.as_('hal');  select public.join_circle((select code from mod_session));
select test.as_('gina'); select public.ask_to_join((select id from mod_session));

select test.as_('finn');
select test.throws($$ select public.block_person(test.id('hal')) $$, 'members leave a circle before blocking someone in it');
select test.throws($$ select public.block_person(test.id('gina')) $$, 'or a guest coming on its walk');
select test.ok(public.report_person(test.id('hal'), 'unsafe'), 'but can report them');
select test.as_('eve');
select public.block_person(test.id('hal'));
select test.ok((select jsonb_array_length(members) = 2 from public.my_circles()), 'an owner blocking a member removes them');
select test.as_('hal');
select test.throws($$ select public.join_circle((select code from mod_session)) $$, 'and they can''t come back');
select test.ok(not exists (select 1 from public.circles_near('r10')), 'nor see it listed');
select test.throws($$ select public.ask_to_join((select id from mod_session)) $$, 'nor ask to come along');

-- Three people reporting the owner: the circle stops being listed to guests.
select test.as_('jon');
select test.ok(exists (select 1 from public.circles_near('r10') where id = (select id from mod_circle)), 'listed to a stranger');
select test.as_('ivy'); select public.join_circle((select code from mod_session));
select test.as_('finn'); select public.report_person(test.id('eve'), 'name');
select test.as_('gina'); select public.report_person(test.id('eve'), 'name');
select test.as_('jon');
select test.ok(exists (select 1 from public.circles_near('r10') where id = (select id from mod_circle)), 'two reports: still listed');
select test.as_('ivy'); select public.report_person(test.id('eve'), 'unsafe', 'shouted at us');
select test.as_('jon');
select test.ok(not exists (select 1 from public.circles_near('r10') where id = (select id from mod_circle)),
  'three reports on its owner: no longer listed');
select test.throws($$ select public.ask_to_join((select id from mod_session)) $$, 'nor taking guests');
select test.as_('eve');
select test.ok(not exists (select 1 from public.circles_near('r10')), 'and they can''t look for other circles');

reset role;
select test.ok((select reporters = 3 and held and who = 'Eve Adams @eve' from moderation.queue where kind = 'person' and subject = test.id('eve')),
  'the queue shows them held back');
select moderation.resolve((select report_id from moderation.queue where kind = 'person' and subject = test.id('eve')),
  'remove', 'rude name');
select test.ok((select username ~ '^explorer_[0-9a-f]{8}$' and display_name is null from public.profiles where id = test.id('eve')),
  'removing resets their name');
set role authenticated;
select test.as_('jon');
select test.ok(exists (select 1 from public.circles_near('r10') where id = (select id from mod_circle)), 'and the circle is listed again');

-- ---------- banning ----------
reset role;
select moderation.resolve((select report_id from moderation.queue where kind = 'person' and subject = test.id('hal')),
  'ban', 'threats');
select test.ok((select banned_until = 'infinity' from auth.users where id = test.id('hal')), 'a ban stops them signing in');
select test.ok(not exists (select 1 from public.reports where subject = test.id('hal') and status = 'open'),
  'and settles every report about them');
select test.ok(not exists (select 1 from public.circle_members where user_id = test.id('hal'))
  and not exists (select 1 from public.landmarks where user_id = test.id('hal')), 'and takes them out of circles and the map');

-- ---------- account deletion ----------
set role authenticated;
select test.as_('gina');
select public.delete_my_account();
reset role;
select test.ok(not exists (select 1 from public.reports where reporter = test.id('gina') or subject = test.id('gina'))
  and not exists (select 1 from public.blocks where blocker = test.id('gina') or blocked = test.id('gina')),
  'deleting your account removes your reports and blocks');

\echo 'All moderation tests passed'
