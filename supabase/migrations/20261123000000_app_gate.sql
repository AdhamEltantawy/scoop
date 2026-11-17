-- A remote switch for the app: turn it off, or make old Android builds update.
--
-- One row of settings, changed from the SQL editor (nobody can change it from the app):
--
--   min_build   Android builds below this are asked to update. A build is the
--               last number of its version: Scoop 1.0.57 is build 57, which
--               is the GitHub Actions run number the APK was built in.
--   off         The app is switched off for everyone except the people in `allowed`.
--   off_web     Whether `off` also applies to the web app (it always applies to Android).
--   allowed     Who can keep using it while it's off (auth user ids), e.g. you.
--   message     What people see instead of the app. Empty: a standard line.
--   update_url  Where "Get the new version" goes: the latest GitHub release.
--
-- Examples:
--   update public.app_gate set min_build = 57;                       -- builds before 1.0.57 must update
--   update public.app_gate set off = true, message = 'Back on Friday';
--   update public.app_gate set allowed = array[(select id from auth.users where email = 'you@example.com')];
--   update public.app_gate set off = false, message = null;          -- back on
--
-- The app checks when it starts and when it comes back to the foreground. It
-- remembers the last answer, so a switched-off or outdated app stays stopped
-- offline too; with no answer yet (offline since install), it runs.
-- Only Android builds that include this check can be stopped.
--
-- Safe to run again.

create table if not exists public.app_gate (
  id boolean primary key default true check (id),
  min_build int not null default 0 check (min_build >= 0),
  off boolean not null default false,
  off_web boolean not null default false,
  allowed uuid[] not null default '{}',
  message text check (char_length(message) <= 500),
  update_url text not null default 'https://github.com/AdhamEltantawy/scoop/releases/latest'
    check (update_url ~ '^https://')
);
insert into public.app_gate (id) values (true) on conflict (id) do nothing;

alter table public.app_gate enable row level security;
revoke all on public.app_gate from public, anon, authenticated;

-- Whether this copy of the app may run.
--   build     the Android build number (null in a browser)
--   platform  'android' or 'web'
-- state: 'ok', 'update' (this build is too old) or 'off'.
create or replace function public.app_gate(build int default null, platform text default 'web')
returns table (state text, message text, url text)
language sql stable security definer set search_path = public as $$
  select
    case
      when g.off and (app_gate.platform = 'android' or g.off_web)
        and (auth.uid() is null or not auth.uid() = any (g.allowed)) then 'off'
      when app_gate.platform = 'android' and app_gate.build < g.min_build then 'update'
      else 'ok'
    end,
    nullif(btrim(g.message), ''),
    g.update_url
  from app_gate g
$$;

revoke execute on function public.app_gate(int, text) from public;
grant execute on function public.app_gate(int, text) to anon, authenticated;
