-- The remote switch. Runs after moderation_test.sql (scripts/test-db.sh),
-- with eve and finn from there, and the test.ok / test.throws helpers.

\set ON_ERROR_STOP 1
set client_min_messages = warning;
\set eve 00000000-0000-0000-0000-0000000000e1
\set finn 00000000-0000-0000-0000-0000000000f1

create function test.gate(build int, platform text) returns text language sql as $$
  select state from public.app_gate(build, platform)
$$;
grant execute on function test.gate(int, text) to anon, authenticated;

-- ---------- nobody can read or change the settings from the app ----------
set role anon;
select test.throws($$ select * from public.app_gate $$, 'the settings can''t be read');
set role authenticated;
select set_config('request.jwt.claim.sub', :'eve', false);
select test.throws($$ update public.app_gate set off = false $$, 'or changed');
select set_config('request.jwt.claim.sub', '', false);

-- ---------- on by default ----------
set role anon;
select test.ok(test.gate(1, 'android') = 'ok' and test.gate(null, 'web') = 'ok', 'on by default, for every build');
select test.ok((select url = 'https://github.com/AdhamEltantawy/scoop/releases/latest' from public.app_gate(1, 'android')),
  'and it knows where the latest release is');

-- ---------- old builds ----------
reset role;
update public.app_gate set min_build = 57;
set role anon;
select test.ok(test.gate(56, 'android') = 'update', 'a build before min_build has to update');
select test.ok(test.gate(57, 'android') = 'ok' and test.gate(80, 'android') = 'ok', 'min_build and later run');
select test.ok(test.gate(null, 'android') = 'ok', 'an Android app that can''t tell its build runs');
select test.ok(test.gate(null, 'web') = 'ok', 'the web app is always the latest');

-- ---------- off ----------
reset role;
update public.app_gate set off = true, message = '  Back on Friday ', allowed = array[:'eve'::uuid];
set role anon;
select test.ok(test.gate(80, 'android') = 'off', 'switched off');
select test.ok((select message = 'Back on Friday' from public.app_gate(80, 'android')), 'with your message');
select test.ok(test.gate(null, 'web') = 'ok', 'the web app stays on unless off_web');
set role authenticated;
select set_config('request.jwt.claim.sub', :'finn', false);
select test.ok(test.gate(80, 'android') = 'off', 'off for people signed in');
select set_config('request.jwt.claim.sub', :'eve', false);
select test.ok(test.gate(80, 'android') = 'ok', 'except the people allowed through');
select test.ok(test.gate(56, 'android') = 'update', 'who still have to update an old build');
select set_config('request.jwt.claim.sub', '', false);

reset role;
update public.app_gate set off_web = true;
set role anon;
select test.ok(test.gate(null, 'web') = 'off', 'off_web switches off the web app too');

reset role;
select test.throws($$ update public.app_gate set update_url = 'http://example.com' $$, 'update_url is https');
select test.throws($$ insert into public.app_gate (id) values (false) $$, 'there''s one row of settings');
update public.app_gate set off = false, off_web = false, message = null, allowed = '{}', min_build = 0;
set role anon;
select test.ok(test.gate(1, 'android') = 'ok', 'back on');

\echo 'All app gate tests passed'
