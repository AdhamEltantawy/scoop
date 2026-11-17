-- Reporting and blocking (production plan, workstream 7), widened for circles,
-- where strangers now meet.
--
-- * Report a landmark you found (its title or note), or a person you know
--   through Scoop: a friend or friend request, someone in one of your circles,
--   or someone on a circle walk with you (their name, or how they behaved).
--   One report per landmark per person; one open report per person per person.
-- * Three people reporting a landmark hide it from everyone but its author
--   until it's reviewed. Three people reporting a person stop their circles
--   being listed to guests, and stop them asking to join walks, until then.
-- * Block someone: friendships and friend requests between you end and can't
--   start again; neither of you sees the other's landmarks; neither can join a
--   circle the other is in, or ask to come along on its walks. An owner who
--   blocks a member or a guest removes them from the circle; anyone else has to
--   leave a circle they share before blocking someone in it. Blocking whoever
--   left a landmark never tells you who it was, and leaves circles alone.
--   Nobody is told they were blocked or reported.
-- * Reports are reviewed in the SQL editor, never from the app:
--     select * from moderation.queue;
--     select moderation.resolve(<report id>, 'keep' | 'remove' | 'ban', 'why');
--   The moderation schema isn't exposed through the API.
--
-- Safe to run again.

-- ---------- tables ----------

create table if not exists public.blocks (
  id bigint generated always as identity primary key,
  blocker uuid not null references public.profiles (id) on delete cascade,
  blocked uuid not null references public.profiles (id) on delete cascade,
  -- Blocked from a landmark: whoever it was stays anonymous, even in your list.
  from_landmark boolean not null default false,
  created_at timestamptz not null default now(),
  unique (blocker, blocked),
  check (blocker <> blocked)
);
create index if not exists blocks_blocked on public.blocks (blocked);

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('landmark', 'person')),
  -- The person reported, or who left the landmark.
  subject uuid not null references public.profiles (id) on delete cascade,
  -- Kept after the landmark goes, so the report can still be read.
  landmark_id bigint references public.landmarks (id) on delete set null,
  reason text not null check (reason in ('offensive', 'spam', 'private', 'name', 'unsafe', 'harassment', 'other')),
  note text check (char_length(note) <= 300),
  -- What was reported, as it was then: the landmark's title and note, or the person's names.
  content text not null,
  status text not null default 'open' check (status in ('open', 'kept', 'removed', 'banned')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (char_length(resolution) <= 300)
);
create unique index if not exists reports_one_per_landmark on public.reports (reporter, landmark_id)
  where kind = 'landmark';
create unique index if not exists reports_one_open_per_person on public.reports (reporter, subject)
  where kind = 'person' and status = 'open';
create index if not exists reports_open_landmark on public.reports (landmark_id) where status = 'open';
create index if not exists reports_open_subject on public.reports (subject) where status = 'open';

-- Hidden by reports until reviewed. Set when the third person reports it.
alter table public.landmarks add column if not exists held_at timestamptz;

alter table public.blocks enable row level security;
alter table public.reports enable row level security;
-- No policies: only the functions below read or write them.
revoke all on public.blocks, public.reports from public, anon, authenticated;

-- ---------- helpers ----------

-- How many different people it takes to hide something until it's reviewed.
create or replace function public.report_threshold()
returns int language sql immutable as $$ select 3 $$;

-- Either of the two blocked the other.
create or replace function public.blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and exists (
    select 1 from blocks x where (x.blocker = a and x.blocked = b) or (x.blocker = b and x.blocked = a))
$$;

-- Enough people reported this person that they're held back until reviewed.
create or replace function public.person_held(person uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (select count(distinct r.reporter) from reports r
    where r.subject = person and r.kind = 'person' and r.status = 'open') >= report_threshold()
$$;

-- Whether `a` knows `b` through Scoop, so can report them: a friendship or a
-- request either way, a circle you're both in, a walk you were both on, a
-- guest asking to come on a walk of your circle (or you on theirs), or
-- someone you blocked.
create or replace function public.knows(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from friendships f
      where (f.requester = a and f.addressee = b) or (f.requester = b and f.addressee = a))
    or exists (select 1 from circle_members x join circle_members y on y.circle_id = x.circle_id
      where x.user_id = a and y.user_id = b)
    or exists (select 1 from session_people p join session_people q on q.session_id = p.session_id
      where p.user_id = a and q.user_id = b)
    or exists (select 1 from session_people p join circle_sessions s on s.id = p.session_id
      join circle_members m on m.circle_id = s.circle_id
      where (p.user_id = b and m.user_id = a) or (p.user_id = a and m.user_id = b))
    or exists (select 1 from blocks x where x.blocker = a and x.blocked = b)
$$;

-- ---------- reporting ----------

-- Report a landmark you found. Returns whether this report was new.
create or replace function public.report_landmark(landmark bigint, reason text, note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  l landmarks;
  added int;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if reason is null or reason not in ('offensive', 'spam', 'private', 'other') then
    raise exception 'Pick a reason' using errcode = 'P0001';
  end if;
  select * into l from landmarks x where x.id = landmark;
  if not found then raise exception 'That landmark is gone' using errcode = 'P0001'; end if;
  if l.user_id = me then raise exception 'This one is yours' using errcode = 'P0001'; end if;
  if not exists (select 1 from landmark_finds f where f.landmark_id = landmark and f.user_id = me) then
    raise exception 'Find this landmark before reporting it' using errcode = 'P0001';
  end if;
  insert into reports (reporter, kind, subject, landmark_id, reason, note, content)
  values (me, 'landmark', l.user_id, l.id, reason, nullif(btrim(note), ''),
    l.title || coalesce(E'\n' || l.note, ''))
  on conflict do nothing;
  get diagnostics added = row_count;
  if added > 0 and l.held_at is null
    and (select count(distinct r.reporter) from reports r
      where r.landmark_id = l.id and r.status = 'open') >= report_threshold() then
    update landmarks x set held_at = now() where x.id = l.id;
  end if;
  return added > 0;
end $$;

-- Report someone you know through Scoop. Returns whether this report was new.
create or replace function public.report_person(person uuid, reason text, note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  p profiles;
  added int;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if reason is null or reason not in ('name', 'unsafe', 'harassment', 'spam', 'other') then
    raise exception 'Pick a reason' using errcode = 'P0001';
  end if;
  if person = me then raise exception 'That''s you' using errcode = 'P0001'; end if;
  select * into p from profiles x where x.id = person;
  if not found or not knows(me, person) then
    raise exception 'You can only report people you know through Scoop' using errcode = 'P0001';
  end if;
  insert into reports (reporter, kind, subject, reason, note, content)
  values (me, 'person', person, reason, nullif(btrim(note), ''),
    coalesce(nullif(btrim(p.display_name), '') || ' ', '') || '@' || p.username)
  on conflict do nothing;
  get diagnostics added = row_count;
  return added > 0;
end $$;

-- ---------- blocking ----------

-- What blocking does, once we know who. Circles: see the top of this file.
create or replace function public.apply_block(me uuid, other uuid, anonymous boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  shared record;
begin
  if other is null or other = me then raise exception 'You can''t block yourself' using errcode = 'P0001'; end if;
  if not anonymous then
    -- A circle you're both in that you don't own: leave it first.
    select c.name into shared from circles c
      join circle_members a on a.circle_id = c.id and a.user_id = me
      where a.role <> 'owner' and (
        exists (select 1 from circle_members b where b.circle_id = c.id and b.user_id = other)
        or exists (select 1 from session_people p join circle_sessions s on s.id = p.session_id
          where s.circle_id = c.id and p.user_id = other and p.guest and s.starts_at > now() - interval '3 hours'))
      limit 1;
    if found then
      raise exception 'You''re both in %. Only its owner can remove someone, so leave it first to block them', shared.name
        using errcode = 'P0001';
    end if;
    -- Circles you own: they're out, as a member or a guest.
    delete from circle_members m using circle_members mine
      where mine.circle_id = m.circle_id and mine.user_id = me and mine.role = 'owner' and m.user_id = other;
    delete from session_people p using circle_sessions s, circle_members mine
      where s.id = p.session_id and mine.circle_id = s.circle_id and mine.user_id = me and mine.role = 'owner'
        and p.user_id = other and p.guest;
    -- Your own asks to come along on their circles' walks.
    delete from session_people p using circle_sessions s, circle_members theirs
      where s.id = p.session_id and theirs.circle_id = s.circle_id and theirs.user_id = other
        and p.user_id = me and p.guest and s.starts_at > now();
  end if;
  delete from friendships f where (f.requester = me and f.addressee = other) or (f.requester = other and f.addressee = me);
  insert into blocks (blocker, blocked, from_landmark) values (me, other, anonymous)
  on conflict (blocker, blocked) do update set from_landmark = blocks.from_landmark and excluded.from_landmark;
end $$;

-- Block someone by who they are (from a friend, a request, a circle or a walk).
create or replace function public.block_person(person uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from profiles p where p.id = person) then
    raise exception 'No one to block' using errcode = 'P0001';
  end if;
  perform apply_block(auth.uid(), person, false);
end $$;

-- Stop seeing whoever left this landmark, without learning who it was.
create or replace function public.block_author(landmark bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  author uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select l.user_id into author from landmarks l where l.id = landmark;
  if not found then raise exception 'That landmark is gone' using errcode = 'P0001'; end if;
  if author = auth.uid() then raise exception 'This one is yours' using errcode = 'P0001'; end if;
  if not exists (select 1 from landmark_finds f where f.landmark_id = landmark and f.user_id = auth.uid()) then
    raise exception 'Find this landmark first' using errcode = 'P0001';
  end if;
  perform apply_block(auth.uid(), author, true);
end $$;

-- People you blocked. Someone blocked from a landmark has no name here.
create or replace function public.my_blocks()
returns table (id bigint, name text, from_landmark boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select b.id, case when b.from_landmark then null else first_name(p) end, b.from_landmark, b.created_at
  from blocks b join profiles p on p.id = b.blocked
  where b.blocker = auth.uid()
  order by b.created_at desc
$$;

-- Unblocking doesn't bring back friendships or circles: start again with an invite.
create or replace function public.unblock(block bigint)
returns void language sql security definer set search_path = public as $$
  delete from blocks b where b.id = block and b.blocker = auth.uid()
$$;

-- ---------- what blocks and reports change ----------

-- Friendships: none between people who blocked each other. Requests, invite
-- codes and renewals quietly do nothing, so nobody learns they were blocked.
create or replace function public.friendships_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if blocked_between(new.requester, new.addressee) then return null; end if;
  return new;
end $$;
drop trigger if exists friendships_not_blocked on public.friendships;
create trigger friendships_not_blocked before insert or update on public.friendships
  for each row execute function public.friendships_before_write();

-- Circles: nobody joins one with someone who blocked them, or whom they blocked.
create or replace function public.circle_members_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from circle_members m where m.circle_id = new.circle_id and blocked_between(m.user_id, new.user_id)) then
    raise exception 'That circle invite doesn''t work any more' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists circle_members_not_blocked on public.circle_members;
create trigger circle_members_not_blocked before insert on public.circle_members
  for each row execute function public.circle_members_before_insert();

-- Whether you'd be walking with someone you blocked, or who blocked you.
create or replace function public.circle_blocked_for(circle bigint, uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from circle_members m where m.circle_id = circle and blocked_between(m.user_id, uid))
$$;

-- Landmarks near you, as before, without held ones or blocked people's.
create or replace function public.landmarks_near(blocks text[])
returns table (id bigint, cell text, kind text, title text, note text, created_at timestamptz,
  author text, mine boolean, finds bigint, found_by_me boolean, ups bigint, downs bigint, my_vote smallint,
  welcome boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if cardinality(blocks) > 50 then raise exception 'Too many blocks' using errcode = 'P0001'; end if;
  return query
  select l.id, l.cell, l.kind, l.title, l.note, l.created_at,
    case when l.user_id = auth.uid() or are_friends(auth.uid(), l.user_id)
      then coalesce(p.display_name, p.username) end,
    l.user_id = auth.uid(), s.finds, me.user_id is not null, s.ups, s.downs, me.vote, l.welcome
  from landmarks l
  join profiles p on p.id = l.user_id
  cross join lateral (
    select count(*) as finds, count(*) filter (where f.vote = 1) as ups, count(*) filter (where f.vote = -1) as downs
    from landmark_finds f where f.landmark_id = l.id
  ) s
  left join landmark_finds me on me.landmark_id = l.id and me.user_id = auth.uid()
  where l.cell7 = any(blocks)
    and (l.user_id = auth.uid() or (not landmark_buried(s.ups, s.downs) and l.held_at is null
      and not blocked_between(auth.uid(), l.user_id)))
  order by l.created_at desc
  limit 500;
end $$;

-- Finding one: not a held landmark, nor a blocked person's.
create or replace function public.find_landmark(landmark bigint)
returns table (finds bigint, first_time boolean)
language plpgsql security definer set search_path = public as $$
declare
  l landmarks;
  added int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into l from landmarks x where x.id = landmark;
  if not found or l.held_at is not null or blocked_between(auth.uid(), l.user_id) then
    raise exception 'That landmark is gone' using errcode = 'P0001';
  end if;
  if l.user_id = auth.uid() then raise exception 'This one is yours' using errcode = 'P0001'; end if;
  insert into landmark_finds (landmark_id, user_id) values (landmark, auth.uid()) on conflict do nothing;
  get diagnostics added = row_count;
  return query select (select count(*) from landmark_finds f where f.landmark_id = landmark), added > 0;
end $$;

-- Your landmarks, as before, plus whether reports are holding it back.
drop function if exists public.my_landmarks();
create function public.my_landmarks()
returns table (id bigint, cell text, kind text, title text, note text, created_at timestamptz,
  finds bigint, last_found timestamptz, ups bigint, downs bigint, buried boolean, points numeric, welcome boolean,
  held boolean)
language sql stable security definer set search_path = public as $$
  select l.id, l.cell, l.kind, l.title, l.note, l.created_at,
    s.finds, s.last_found, s.ups, s.downs, landmark_buried(s.ups, s.downs),
    (select coalesce(sum(p.points), 0) from landmark_points p where p.landmark_id = l.id and p.user_id = l.user_id),
    l.welcome, l.held_at is not null
  from landmarks l
  cross join lateral (
    select count(*) as finds, max(f.found_at) as last_found,
      count(*) filter (where f.vote = 1) as ups, count(*) filter (where f.vote = -1) as downs
    from landmark_finds f where f.landmark_id = l.id
  ) s
  where l.user_id = auth.uid()
  order by l.created_at desc
$$;

-- Neighbourhood totals and ? pins, as before; pins skip held landmarks and,
-- signed in, blocked people's.
create or replace function public.area_pulse(district text, blocks text[])
returns table (explorers bigint, landmarks bigint, cafes bigint, ordinal bigint, pins jsonb)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
  d text := district;
begin
  if d is not null and d !~ '^r[0-9]{1,12}$' then raise exception 'Bad district' using errcode = 'P0001'; end if;
  if blocks is null then blocks := '{}'; end if;
  if cardinality(blocks) > 7 then raise exception 'Too many blocks' using errcode = 'P0001'; end if;
  if exists (select 1 from unnest(blocks) b where b !~ '^87[0-9a-f]{13}$') then
    raise exception 'Bad block' using errcode = 'P0001';
  end if;
  return query
  with folks as (
    select c.user_id, min(c.first_visited) as since, max(c.last_visited) as last
    from user_cells c
    where d is not null and c.district = d
    group by c.user_id
  ), ranked as (
    select f.user_id, f.last, row_number() over (order by f.since, f.user_id) as n from folks f
  ), marks as (
    select l.id, l.cell, l.cell7, l.welcome, s.ups
    from landmarks l
    cross join lateral (
      select count(*) filter (where f.vote = 1) as ups, count(*) filter (where f.vote = -1) as downs
      from landmark_finds f where f.landmark_id = l.id
    ) s
    where not landmark_buried(s.ups, s.downs) and l.held_at is null
      and (me is null or l.user_id = me or not blocked_between(me, l.user_id))
  )
  select
    (select count(*) from ranked r where r.last >= now() - interval '60 days'),
    (select count(*) from marks m where d is not null and exists (
      select 1 from user_cells c where c.cell8 = h3_to_parent(m.cell, 8) and c.cell = m.cell and c.district = d)),
    (select count(distinct k.cell) from checkins k where d is not null and k.kind = 'coffee' and exists (
      select 1 from user_cells c where c.user_id = k.user_id and c.cell = k.cell and c.district = d)),
    coalesce((select r.n from ranked r where me is not null and r.user_id = me), (select count(*) from ranked) + 1),
    coalesce((select jsonb_agg(jsonb_build_object('cell', p.cell, 'ups', p.ups, 'welcome', p.welcome))
      from (select m.cell, m.ups, m.welcome from marks m where m.cell7 = any(blocks)
        order by m.ups desc, m.id limit pulse_pin_limit()) p), '[]'::jsonb);
end $$;

-- Circles near you, as before, without ones you'd share with someone blocked,
-- or whose owner is held back by reports. Nothing, while you're held back.
create or replace function public.circles_near(district text)
returns table (id bigint, size bigint, weekday smallint, at_time text, tz text, next_session bigint,
  next_at timestamptz, asked text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if person_held(me) then return; end if;
  return query
  select c.id, (select count(*) from circle_members m where m.circle_id = c.id), c.weekday, c.at_time, c.tz,
    s.id, s.starts_at,
    (select case when sp.approved then 'yes' else 'asked' end from session_people sp
      where sp.session_id = s.id and sp.user_id = me and sp.guest)
  from circles c
  left join lateral (select x.id, x.starts_at from circle_sessions x
    where x.circle_id = c.id and x.starts_at > now() order by x.starts_at limit 1) s on true
  where c.guests and c.district = circles_near.district and not is_circle_member(c.id, me)
    and (select count(*) from circle_members m where m.circle_id = c.id) < circle_size_limit()
    and not circle_blocked_for(c.id, me)
    and not exists (select 1 from circle_members o where o.circle_id = c.id and o.role = 'owner' and person_held(o.user_id))
  order by s.starts_at nulls last, c.id
  limit 50;
end $$;

-- Asking to come along, as before, with the same limits as circles_near.
create or replace function public.ask_to_join(session bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  s record;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if person_held(me) then
    raise exception 'You can''t ask to join walks while reports about you are looked at' using errcode = 'P0001';
  end if;
  select x.id, x.starts_at, c.guests, c.id as circle_id into s
    from circle_sessions x join circles c on c.id = x.circle_id where x.id = session;
  if not found or not s.guests or circle_blocked_for(s.circle_id, me)
    or exists (select 1 from circle_members o where o.circle_id = s.circle_id and o.role = 'owner' and person_held(o.user_id)) then
    raise exception 'That circle isn''t taking guests' using errcode = 'P0001';
  end if;
  if s.starts_at <= now() then raise exception 'That walk has started' using errcode = 'P0001'; end if;
  if is_circle_member(s.circle_id, me) then raise exception 'You''re in that circle already' using errcode = 'P0001'; end if;
  if (select count(*) from session_people p join circle_sessions x on x.id = p.session_id
      where p.user_id = me and p.guest and x.starts_at > now()) >= guest_requests_limit() then
    raise exception 'You can ask to join % walks at a time', guest_requests_limit() using errcode = 'P0001';
  end if;
  insert into session_people (session_id, user_id, guest, approved) values (session, me, true, false)
  on conflict do nothing;
end $$;

-- ---------- review (SQL editor only) ----------

create schema if not exists moderation;
revoke all on schema moderation from public, anon, authenticated;

-- Open reports, one row per landmark or person, most reported first.
create or replace view moderation.queue as
  select min(r.id) as report_id, r.kind, r.landmark_id, r.subject,
    coalesce(nullif(btrim(p.display_name), '') || ' ', '') || '@' || p.username as who,
    (array_agg(r.content order by r.created_at desc))[1] as content,
    count(distinct r.reporter) as reporters,
    array_agg(distinct r.reason) as reasons,
    array_remove(array_agg(r.note order by r.created_at), null) as notes,
    bool_or(l.held_at is not null) or person_held(r.subject) and r.kind = 'person' as held,
    min(r.created_at) as first_at, max(r.created_at) as last_at
  from public.reports r
  join public.profiles p on p.id = r.subject
  left join public.landmarks l on l.id = r.landmark_id
  where r.status = 'open'
  group by r.kind, r.landmark_id, r.subject, p.display_name, p.username
  order by count(distinct r.reporter) desc, min(r.created_at);
revoke all on moderation.queue from public, anon, authenticated;

-- Close every open report on the same landmark or person as `report`:
--   keep    nothing wrong: a held landmark or person goes back to normal.
--   remove  the landmark is deleted, or the person's name is reset to explorer_xxxxxxxx.
--   ban     the person (and, for a landmark, whoever left it) can't sign in again;
--           their landmarks, circles, friendships and asks are removed.
create or replace function moderation.resolve(report bigint, action text, why text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  r reports;
  closed int;
begin
  if action is null or action not in ('keep', 'remove', 'ban') then
    raise exception 'action is keep, remove or ban';
  end if;
  select * into r from reports x where x.id = report;
  if not found then raise exception 'No report %', report; end if;
  update reports x set status = case action when 'keep' then 'kept' when 'remove' then 'removed' else 'banned' end,
      resolved_at = now(), resolution = why
    where x.status = 'open' and x.kind = r.kind and x.subject = r.subject
      and (r.kind = 'person' or x.landmark_id is not distinct from r.landmark_id);
  get diagnostics closed = row_count;
  if action = 'keep' and r.kind = 'landmark' then
    update landmarks l set held_at = null where l.id = r.landmark_id;
  elsif action = 'remove' and r.kind = 'landmark' then
    delete from landmarks l where l.id = r.landmark_id;
  elsif action = 'remove' then
    update profiles p set display_name = null, username = 'explorer_' || substr(md5(p.id::text), 1, 8)
      where p.id = r.subject;
  elsif action = 'ban' then
    update auth.users u set banned_until = 'infinity' where u.id = r.subject;
    -- Every open report about them is settled by the ban.
    update reports x set status = 'banned', resolved_at = now(), resolution = why
      where x.status = 'open' and x.subject = r.subject;
    delete from landmarks l where l.user_id = r.subject;
    delete from circle_members m where m.user_id = r.subject;
    delete from session_people p where p.user_id = r.subject;
    delete from friendships f where f.requester = r.subject or f.addressee = r.subject;
  end if;
  return closed;
end $$;
revoke all on function moderation.resolve(bigint, text, text) from public, anon, authenticated;

-- ---------- privileges ----------

revoke execute on function public.report_threshold(), public.blocked_between(uuid, uuid), public.person_held(uuid),
  public.knows(uuid, uuid), public.apply_block(uuid, uuid, boolean), public.friendships_before_write(),
  public.circle_members_before_insert(), public.circle_blocked_for(bigint, uuid)
  from public, anon, authenticated;
revoke execute on function public.report_landmark(bigint, text, text), public.report_person(uuid, text, text),
  public.block_person(uuid), public.block_author(bigint), public.my_blocks(), public.unblock(bigint),
  public.landmarks_near(text[]), public.find_landmark(bigint), public.my_landmarks(),
  public.circles_near(text), public.ask_to_join(bigint)
  from public, anon;
grant execute on function public.report_landmark(bigint, text, text), public.report_person(uuid, text, text),
  public.block_person(uuid), public.block_author(bigint), public.my_blocks(), public.unblock(bigint),
  public.landmarks_near(text[]), public.find_landmark(bigint), public.my_landmarks(),
  public.circles_near(text), public.ask_to_join(bigint)
  to authenticated;
-- area_pulse stays open to everyone (signed-out lookups), as in 20261117000000.
grant execute on function public.area_pulse(text, text[]) to anon, authenticated;
