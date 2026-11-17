-- Belonging, part 2: circles.
--
-- A circle is 2–8 people who walk together at a set time each week: a name,
-- a weekday and time, a meeting point and a shared weekly goal. Each walk is
-- a session. Members say whether they're coming, check in when they meet,
-- walk together (sharing hex ids live over Realtime, never tracks) and send
-- each other kudos. One tap books the same time next week.
--
-- What members see of each other: first names, who's coming, who checked in
-- at the meeting point, and during a circle walk its hexes and km. Outside
-- circle walks, only whether each walked that week, never when or where.
-- Joining a circle doesn't make you friends; friendships still last a month
-- unless you both renew.
--
-- A circle can welcome guests (off unless its owner turns it on). Then it's
-- listed in its district by size and schedule only, and anyone can ask to
-- join one walk. The owner says yes or no.
--
-- The streak: a week counts when at least two people checked in together on
-- a circle walk. Each circle gets one free skip per calendar month.
--
-- Safe to run again.

-- ---------- tables ----------

create table if not exists public.circles (
  id bigint generated always as identity primary key,
  name text not null check (char_length(btrim(name)) between 1 and 30),
  district text check (district ~ '^r[0-9]{1,12}$'),
  meet_cell text not null check (meet_cell ~ '^8a[0-9a-f]{13}$'),
  meet_label text check (char_length(meet_label) <= 60),
  weekday smallint not null check (weekday between 0 and 6),  -- 0 = Sunday, as in JavaScript
  at_time text not null check (at_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  tz text not null default 'Africa/Cairo' check (char_length(tz) <= 64),
  goal_km numeric(5, 1) not null default 30 check (goal_km between 1 and 500),
  guests boolean not null default false,
  code text not null unique default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
  created_at timestamptz not null default now()
);
create index if not exists circles_district on public.circles (district) where guests;

create table if not exists public.circle_members (
  circle_id bigint not null references public.circles (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);
create index if not exists circle_members_user on public.circle_members (user_id);

-- Someone left (or deleted their account): the longest-standing member takes
-- over from an owner, and the last one out takes the circle with them.
create or replace function public.circle_members_after_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  heir uuid;
begin
  if old.role = 'owner' and not exists (select 1 from circle_members m where m.circle_id = old.circle_id and m.role = 'owner') then
    select m.user_id into heir from circle_members m where m.circle_id = old.circle_id order by m.joined_at, m.user_id limit 1;
    if heir is not null then
      update circle_members m set role = 'owner' where m.circle_id = old.circle_id and m.user_id = heir;
    end if;
  end if;
  if not exists (select 1 from circle_members m where m.circle_id = old.circle_id) then
    delete from circles c where c.id = old.circle_id;
  end if;
  return null;
end $$;
drop trigger if exists circle_members_left on public.circle_members;
create trigger circle_members_left after delete on public.circle_members
  for each row execute function public.circle_members_after_delete();

create or replace function public.is_circle_owner(circle bigint, uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from circle_members m where m.circle_id = circle and m.user_id = uid and m.role = 'owner')
$$;

create table if not exists public.circle_sessions (
  id bigint generated always as identity primary key,
  circle_id bigint not null references public.circles (id) on delete cascade,
  starts_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (circle_id, starts_at)
);

-- Who's on a walk: members (once they answer or check in) and guests.
create table if not exists public.session_people (
  session_id bigint not null references public.circle_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  guest boolean not null default false,
  approved boolean not null default true,            -- guests wait for the owner
  rsvp text check (rsvp in ('in', 'out', 'omw')),    -- coming, can't make it, on my way
  rsvp_at timestamptz,
  checked_in_at timestamptz,
  walk_started timestamptz,
  km numeric(7, 3) check (km >= 0 and km < 300),
  hexes int check (hexes >= 0),
  primary key (session_id, user_id)
);
create index if not exists session_people_user on public.session_people (user_id);

create table if not exists public.circle_kudos (
  session_id bigint not null references public.circle_sessions (id) on delete cascade,
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, from_user, to_user),
  check (from_user <> to_user)
);

-- ---------- limits and helpers ----------

create or replace function public.circle_size_limit() returns int language sql immutable as $$ select 8 $$;
create or replace function public.circles_per_user() returns int language sql immutable as $$ select 3 $$;
create or replace function public.guest_requests_limit() returns int language sql immutable as $$ select 3 $$;

-- What circle members and guests call you: the first word of your display name.
create or replace function public.first_name(p public.profiles)
returns text language sql immutable as $$
  select split_part(coalesce(nullif(btrim(p.display_name), ''), p.username), ' ', 1)
$$;

-- The first `weekday` at `at_time` (local time in `tz`) after `after`.
create or replace function public.next_occurrence(weekday int, at_time text, tz text, after timestamptz)
returns timestamptz language plpgsql stable as $$
declare
  d date := (after at time zone tz)::date;
  t timestamptz;
begin
  for i in 0..7 loop
    if extract(dow from d + i) = weekday then
      t := ((d + i) + at_time::time) at time zone tz;
      if t > after then return t; end if;
    end if;
  end loop;
  return ((d + 7 + ((weekday - extract(dow from d)::int + 7) % 7)) + at_time::time) at time zone tz;
end $$;

create or replace function public.is_circle_member(circle bigint, uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from circle_members m where m.circle_id = circle and m.user_id = uid)
$$;

-- On this walk: a member of its circle, or a guest the owner said yes to.
create or replace function public.in_session(session bigint, uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from circle_sessions s join circle_members m on m.circle_id = s.circle_id
      where s.id = session and m.user_id = uid)
    or exists (select 1 from session_people p where p.session_id = session and p.user_id = uid and p.guest and p.approved)
$$;

-- A week counts when two or more checked in together on one of its walks.
create or replace function public.circle_week_done(circle bigint, tz text, week date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from circle_sessions s
    where s.circle_id = circle
      and date_trunc('week', s.starts_at at time zone tz)::date = week
      and (select count(*) from session_people p where p.session_id = s.id and p.checked_in_at is not null) >= 2)
$$;

-- Weeks in a row the circle walked together, counting back from this week
-- (which only counts once it's done). One missed week per calendar month is
-- forgiven. `skip_used`: whether this month's free skip is gone.
create or replace function public.circle_streak(circle bigint)
returns table (weeks int, skip_used boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  c circles;
  this_week date;
  w date;
  n int := 0;
  months_skipped date[] := '{}';
  first_week date;
begin
  select * into c from circles where id = circle;
  if not found then return; end if;
  this_week := date_trunc('week', now() at time zone c.tz)::date;
  first_week := date_trunc('week', c.created_at at time zone c.tz)::date;
  if circle_week_done(circle, c.tz, this_week) then n := 1; end if;
  w := this_week - 7;
  while w >= first_week and n < 520 loop
    if circle_week_done(circle, c.tz, w) then
      n := n + 1;
    elsif not (date_trunc('month', w)::date = any(months_skipped)) then
      months_skipped := months_skipped || date_trunc('month', w)::date;
    else
      exit;
    end if;
    w := w - 7;
  end loop;
  -- A run of forgiven weeks at the very start isn't a streak.
  if n = 0 then months_skipped := '{}'; end if;
  return query select n, date_trunc('month', this_week)::date = any(months_skipped);
end $$;

-- The circle you name, as long as you're in it.
create or replace function public.my_circle(circle bigint)
returns public.circles language plpgsql stable security definer set search_path = public as $$
declare
  c circles;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into c from circles where id = circle;
  if not found or not is_circle_member(circle, auth.uid()) then
    raise exception 'You''re not in that circle' using errcode = 'P0001';
  end if;
  return c;
end $$;

-- ---------- making and joining circles ----------

create or replace function public.check_circle_fields(name text, weekday int, at_time text, tz text, meet_cell text,
  meet_label text, goal_km numeric)
returns void language plpgsql stable as $$
begin
  if name is null or char_length(btrim(name)) not between 1 and 30 then
    raise exception 'Give your circle a name (up to 30 characters)' using errcode = 'P0001';
  end if;
  if weekday is null or weekday not between 0 and 6 then raise exception 'Pick a day' using errcode = 'P0001'; end if;
  if at_time is null or at_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Pick a time' using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_timezone_names z where z.name = tz) then
    raise exception 'Unknown time zone' using errcode = 'P0001';
  end if;
  if meet_cell is null or meet_cell !~ '^8a[0-9a-f]{13}$' then
    raise exception 'Pick a meeting point' using errcode = 'P0001';
  end if;
  if char_length(meet_label) > 60 then raise exception 'Meeting point name is too long' using errcode = 'P0001'; end if;
  if goal_km is null or goal_km not between 1 and 500 then
    raise exception 'A weekly goal is 1 to 500 km' using errcode = 'P0001';
  end if;
end $$;

-- Start a circle with its first walk booked. Returns the circle id.
create or replace function public.create_circle(name text, weekday int, at_time text, tz text, meet_cell text,
  meet_label text default null, goal_km numeric default 30, guests boolean default false)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid bigint;
  d text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  perform check_circle_fields(name, weekday, at_time, tz, meet_cell, meet_label, goal_km);
  if (select count(*) from circle_members m where m.user_id = me) >= circles_per_user() then
    raise exception 'You''re in % circles already. Leave one to start another', circles_per_user() using errcode = 'P0001';
  end if;
  -- The meeting point's district, from anyone's tags for that hex; else yours.
  select c.district into d from user_cells c
    where c.cell8 = h3_to_parent(meet_cell, 8) and c.cell = meet_cell and c.district is not null limit 1;
  d := coalesce(d, home_area(me, 'district'));
  insert into circles (name, district, meet_cell, meet_label, weekday, at_time, tz, goal_km, guests)
  values (btrim(name), d, meet_cell, nullif(btrim(meet_label), ''), weekday, at_time, tz, goal_km, coalesce(guests, false))
  returning id into cid;
  insert into circle_members (circle_id, user_id, role) values (cid, me, 'owner');
  insert into circle_sessions (circle_id, starts_at) values (cid, next_occurrence(weekday, at_time, tz, now()));
  return cid;
end $$;

-- Change a circle (owner only). A new day or time moves the next walk,
-- unless someone already checked in to it.
create or replace function public.update_circle(circle bigint, name text, weekday int, at_time text, tz text,
  meet_cell text, meet_label text, goal_km numeric, guests boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  c circles := my_circle(circle);
begin
  if not is_circle_owner(circle, auth.uid()) then raise exception 'Only the circle''s owner can change it' using errcode = 'P0001'; end if;
  perform check_circle_fields(name, weekday, at_time, tz, meet_cell, meet_label, goal_km);
  update circles x set name = btrim(update_circle.name), weekday = update_circle.weekday, at_time = update_circle.at_time,
    tz = update_circle.tz, meet_cell = update_circle.meet_cell, meet_label = nullif(btrim(update_circle.meet_label), ''),
    goal_km = update_circle.goal_km, guests = coalesce(update_circle.guests, false)
  where x.id = circle;
  if (c.weekday, c.at_time, c.tz) is distinct from (weekday, at_time, tz) then
    delete from circle_sessions s where s.circle_id = circle and s.starts_at > now()
      and not exists (select 1 from session_people p where p.session_id = s.id and p.checked_in_at is not null);
    insert into circle_sessions (circle_id, starts_at) values (circle, next_occurrence(weekday, at_time, tz, now()))
      on conflict do nothing;
  end if;
end $$;

-- Join with an invite code. Returns the circle.
create or replace function public.join_circle(code text)
returns table (id bigint, name text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  c circles;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select * into c from circles x where x.code = upper(btrim(join_circle.code));
  if not found then raise exception 'That circle invite doesn''t work any more' using errcode = 'P0001'; end if;
  if not is_circle_member(c.id, me) then
    if (select count(*) from circle_members m where m.user_id = me) >= circles_per_user() then
      raise exception 'You''re in % circles already. Leave one to join another', circles_per_user() using errcode = 'P0001';
    end if;
    if (select count(*) from circle_members m where m.circle_id = c.id) >= circle_size_limit() then
      raise exception '% is full (% people)', c.name, circle_size_limit() using errcode = 'P0001';
    end if;
    insert into circle_members (circle_id, user_id) values (c.id, me);
    -- A guest request for one of its walks is now just membership.
    delete from session_people p using circle_sessions s
      where p.session_id = s.id and s.circle_id = c.id and p.user_id = me and p.guest;
  end if;
  return query select c.id, c.name;
end $$;

-- Leave a circle (see circle_members_after_delete for who takes over).
create or replace function public.leave_circle(circle bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  c circles := my_circle(circle);
begin
  delete from session_people p using circle_sessions s
    where p.session_id = s.id and s.circle_id = circle and p.user_id = auth.uid() and s.starts_at > now();
  delete from circle_members m where m.circle_id = circle and m.user_id = auth.uid();
end $$;

-- ---------- your circles ----------

-- Your circles, each with its members, its next walk and how the week is going.
--   members  [{id, name, role, me, walked_week}]  walked_week: walked at all
--            this week (never when or where)
--   next     {id, starts_at, people: [{id, name, guest, approved, rsvp, checked_in}]}
--            or null when no walk is booked. Pending guests only show for the owner.
create or replace function public.my_circles()
returns table (id bigint, name text, role text, weekday smallint, at_time text, tz text, meet_cell text,
  meet_label text, goal_km numeric, guests boolean, code text, district text, district_name text,
  members jsonb, next jsonb, week_km numeric, streak int, skip_used boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  return query
  select c.id, c.name, mine.role, c.weekday, c.at_time, c.tz, c.meet_cell, c.meet_label, c.goal_km, c.guests, c.code,
    c.district, a.name,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', first_name(p), 'role', m.role, 'me', p.id = me,
        'walked_week', exists (select 1 from walks w where w.user_id = p.id and w.started_at >= period_start('week')))
        order by m.joined_at), '[]'::jsonb)
      from circle_members m join profiles p on p.id = m.user_id where m.circle_id = c.id),
    (select jsonb_build_object('id', s.id, 'starts_at', s.starts_at, 'people', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', first_name(p), 'guest', sp.guest, 'approved', sp.approved,
          'rsvp', sp.rsvp, 'checked_in', sp.checked_in_at is not null) order by sp.checked_in_at nulls last, p.id)
        from session_people sp join profiles p on p.id = sp.user_id
        where sp.session_id = s.id and (sp.approved or mine.role = 'owner')), '[]'::jsonb))
      from circle_sessions s
      where s.circle_id = c.id and s.starts_at > now() - interval '3 hours'
      order by s.starts_at limit 1),
    (select coalesce(sum(sp.km), 0) from session_people sp join circle_sessions s on s.id = sp.session_id
      where s.circle_id = c.id and s.starts_at >= period_start('week')),
    st.weeks, st.skip_used
  from circle_members mine
  join circles c on c.id = mine.circle_id
  left join areas a on a.id = c.district
  cross join lateral circle_streak(c.id) st
  where mine.user_id = me
  order by mine.joined_at;
end $$;

-- Book the same time next week (or the next one due, if none is). Any member can.
create or replace function public.book_next(circle bigint)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  c circles := my_circle(circle);
  last timestamptz;
  t timestamptz;
begin
  select max(s.starts_at) into last from circle_sessions s where s.circle_id = circle;
  t := next_occurrence(c.weekday, c.at_time, c.tz, greatest(coalesce(last, now()), now()));
  insert into circle_sessions (circle_id, starts_at) values (circle, t) on conflict do nothing;
  return t;
end $$;

-- Coming ('in'), can't make it ('out') or on my way ('omw').
create or replace function public.rsvp(session bigint, answer text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if answer is null or answer not in ('in', 'out', 'omw') then raise exception 'Bad answer' using errcode = 'P0001'; end if;
  if not in_session(session, me) then raise exception 'You''re not on that walk' using errcode = 'P0001'; end if;
  insert into session_people (session_id, user_id, rsvp, rsvp_at) values (session, me, answer, now())
  on conflict (session_id, user_id) do update set rsvp = excluded.rsvp, rsvp_at = excluded.rsvp_at;
end $$;

-- ---------- guests ----------

-- Circles in a district that welcome guests: size and schedule only.
create or replace function public.circles_near(district text)
returns table (id bigint, size bigint, weekday smallint, at_time text, tz text, next_session bigint,
  next_at timestamptz, asked text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
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
  order by s.starts_at nulls last, c.id
  limit 50;
end $$;

-- Ask to come along on one walk of a circle that welcomes guests.
create or replace function public.ask_to_join(session bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  s record;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select x.id, x.starts_at, c.guests, c.id as circle_id into s
    from circle_sessions x join circles c on c.id = x.circle_id where x.id = session;
  if not found or not s.guests then raise exception 'That circle isn''t taking guests' using errcode = 'P0001'; end if;
  if s.starts_at <= now() then raise exception 'That walk has started' using errcode = 'P0001'; end if;
  if is_circle_member(s.circle_id, me) then raise exception 'You''re in that circle already' using errcode = 'P0001'; end if;
  if (select count(*) from session_people p join circle_sessions x on x.id = p.session_id
      where p.user_id = me and p.guest and x.starts_at > now()) >= guest_requests_limit() then
    raise exception 'You can ask to join % walks at a time', guest_requests_limit() using errcode = 'P0001';
  end if;
  insert into session_people (session_id, user_id, guest, approved) values (session, me, true, false)
  on conflict do nothing;
end $$;

-- The owner says yes or no to a guest.
create or replace function public.answer_guest(session bigint, guest uuid, accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from circle_sessions s where s.id = session and is_circle_owner(s.circle_id, auth.uid())) then
    raise exception 'Only the circle''s owner can answer' using errcode = 'P0001';
  end if;
  if accept then
    update session_people p set approved = true where p.session_id = session and p.user_id = answer_guest.guest and p.guest;
  else
    delete from session_people p where p.session_id = session and p.user_id = answer_guest.guest and p.guest;
  end if;
end $$;

-- Walks you asked to join. Until the owner says yes you only know the
-- schedule; after, the circle's name, meeting point and first names.
create or replace function public.my_guest_walks()
returns table (session bigint, starts_at timestamptz, approved boolean, circle_name text, meet_cell text,
  meet_label text, people text[])
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  return query
  select s.id, s.starts_at, p.approved,
    case when p.approved then c.name end,
    case when p.approved then c.meet_cell end,
    case when p.approved then c.meet_label end,
    case when p.approved then array(select first_name(x) from circle_members m join profiles x on x.id = m.user_id
      where m.circle_id = c.id order by m.joined_at) end
  from session_people p
  join circle_sessions s on s.id = p.session_id
  join circles c on c.id = s.circle_id
  where p.user_id = auth.uid() and p.guest and s.starts_at > now() - interval '3 hours'
  order by s.starts_at;
end $$;

-- ---------- meeting up and walking together ----------

-- Check in at the meeting point, from half an hour before the walk until two
-- hours after it starts. You need to be in the same ~1 km² block as the
-- meeting point (the app checks you're there). It's a meetup check-in like
-- any other, and once someone else on the walk checked in too it's verified:
-- +5 each. Returns who has checked in.
create or replace function public.circle_check_in(session bigint, cell text)
returns table (user_id uuid, name text, checked_in_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  s record;
  mate record;
  mine bigint;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select x.id, x.starts_at, c.meet_cell into s from circle_sessions x join circles c on c.id = x.circle_id where x.id = session;
  if not found or not in_session(session, me) then raise exception 'You''re not on that walk' using errcode = 'P0001'; end if;
  if now() < s.starts_at - interval '30 minutes' or now() > s.starts_at + interval '2 hours' then
    raise exception 'Check in from half an hour before the walk' using errcode = 'P0001';
  end if;
  if cell is null or cell !~ '^8a[0-9a-f]{13}$' or h3_to_parent(cell, 8) <> h3_to_parent(s.meet_cell, 8) then
    raise exception 'Check in at the meeting point' using errcode = 'P0001';
  end if;
  insert into session_people (session_id, user_id, checked_in_at, rsvp, rsvp_at) values (session, me, now(), 'in', now())
  on conflict (session_id, user_id) do update set checked_in_at = coalesce(session_people.checked_in_at, now());
  -- The meetup check-in, on a hex you may not have walked yet.
  perform set_config('scoop.circle_check_in', 'on', true);
  insert into checkins (user_id, cell, kind) values (me, cell, 'meetup') on conflict do nothing;
  perform set_config('scoop.circle_check_in', '', true);
  select k.id into mine from checkins k where k.user_id = me and k.kind = 'meetup' and k.met_with is null
    and k.created_at >= s.starts_at - interval '30 minutes' order by k.created_at desc limit 1;
  if mine is not null then
    select k.id, k.user_id into mate from checkins k
      join session_people p on p.user_id = k.user_id and p.session_id = session and p.checked_in_at is not null
      where k.kind = 'meetup' and k.user_id <> me and k.created_at >= s.starts_at - interval '30 minutes'
      order by (k.met_with is null) desc, k.created_at desc limit 1;
    if found then
      update checkins k set met_with = mate.user_id where k.id = mine;
      update checkins k set met_with = me where k.id = mate.id and k.met_with is null;
      perform award_badges(mate.user_id);
      perform award_badges(me);
    end if;
  end if;
  return query select p.user_id, first_name(x), p.checked_in_at from session_people p join profiles x on x.id = p.user_id
    where p.session_id = session and p.checked_in_at is not null order by p.checked_in_at;
end $$;

-- Checking in for a circle walk works on a hex you haven't walked.
create or replace function public.checkins_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.day := (now() at time zone 'utc')::date;
  new.met_with := null;
  if coalesce(current_setting('scoop.circle_check_in', true), '') <> 'on'
    and not exists (select 1 from user_cells where user_id = new.user_id and cell = new.cell) then
    raise exception 'Walk through this hex before checking in here' using errcode = 'P0001';
  end if;
  if new.photo_path is not null and split_part(new.photo_path, '/', 1) <> new.user_id::text then
    raise exception 'Photos must be in your own folder' using errcode = 'P0001';
  end if;
  if new.kind = 'photo' and new.photo_path is null then
    raise exception 'A photo check-in needs a photo' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Your part of a circle walk, when you stop.
create or replace function public.log_circle_walk(session bigint, started timestamptz, km numeric, hexes int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if km is null or km < 0 or km >= 300 or hexes is null or hexes < 0 or hexes > 20000 then
    raise exception 'Bad walk' using errcode = 'P0001';
  end if;
  update session_people p set walk_started = started, km = log_circle_walk.km, hexes = log_circle_walk.hexes
    where p.session_id = session and p.user_id = auth.uid() and p.checked_in_at is not null;
  if not found then raise exception 'Check in before walking together' using errcode = 'P0001'; end if;
end $$;

-- A circle walk: who came, what each walked, and the kudos you gave.
create or replace function public.circle_walk(session bigint)
returns table (user_id uuid, name text, me boolean, guest boolean, km numeric, hexes int, kudos_from_me boolean,
  kudos bigint, circle_name text, district_name text, starts_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if not in_session(session, me) then raise exception 'You''re not on that walk' using errcode = 'P0001'; end if;
  return query
  select p.user_id, first_name(x), p.user_id = me, p.guest, p.km, p.hexes,
    exists (select 1 from circle_kudos k where k.session_id = session and k.from_user = me and k.to_user = p.user_id),
    (select count(*) from circle_kudos k where k.session_id = session and k.to_user = p.user_id),
    c.name, a.name, s.starts_at
  from session_people p
  join profiles x on x.id = p.user_id
  join circle_sessions s on s.id = p.session_id
  join circles c on c.id = s.circle_id
  left join areas a on a.id = c.district
  where p.session_id = session and p.checked_in_at is not null
  order by p.hexes desc nulls last, p.checked_in_at;
end $$;

create or replace function public.circle_kudos_toggle(session bigint, target uuid, give boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if target = auth.uid() then raise exception 'Kudos are for the others' using errcode = 'P0001'; end if;
  if not exists (select 1 from session_people p where p.session_id = session and p.user_id = auth.uid() and p.checked_in_at is not null)
    or not exists (select 1 from session_people p where p.session_id = session and p.user_id = target and p.checked_in_at is not null) then
    raise exception 'Kudos are for people who walked together' using errcode = 'P0001';
  end if;
  if give then
    insert into circle_kudos (session_id, from_user, to_user) values (session, auth.uid(), target) on conflict do nothing;
  else
    delete from circle_kudos k where k.session_id = session and k.from_user = auth.uid() and k.to_user = target;
  end if;
end $$;

-- ---------- firsts: walking with someone now includes circle walks ----------

create or replace function public.my_firsts()
returns table (walked boolean, home text, home_name text, found boolean, met boolean, coffee boolean, left_one boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  hd text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  hd := home_area(me, 'district');
  return query select
    exists (select 1 from walks w where w.user_id = me) or exists (select 1 from user_cells c where c.user_id = me),
    hd,
    (select a.name from areas a where a.id = hd),
    exists (select 1 from landmark_finds f where f.user_id = me),
    exists (select 1 from checkins k where k.user_id = me and k.kind = 'meetup' and k.met_with is not null)
      or exists (select 1 from session_people p where p.user_id = me and p.checked_in_at is not null
        and exists (select 1 from session_people o where o.session_id = p.session_id and o.user_id <> me
          and o.checked_in_at is not null)),
    exists (select 1 from checkins k where k.user_id = me and k.kind = 'coffee'),
    exists (select 1 from landmarks l where l.user_id = me);
end $$;

-- ---------- live walks: Realtime ----------

-- Whether you (and only you) are on a walk, for the Realtime policies, which run as you.
create or replace function public.on_this_walk(session bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and in_session(session, auth.uid())
$$;
-- Channel "circle-session:<id>" carries hex ids and km between the people on
-- that walk, and only them. (Only where Supabase Realtime is installed.)
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'realtime')
    and exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'realtime' and c.relname = 'messages') then
    execute 'drop policy if exists "circle walks: read" on realtime.messages';
    execute 'drop policy if exists "circle walks: send" on realtime.messages';
    execute $p$create policy "circle walks: read" on realtime.messages for select to authenticated
      using (realtime.topic() ~ '^circle-session:[0-9]+$'
        and public.on_this_walk(split_part(realtime.topic(), ':', 2)::bigint))$p$;
    execute $p$create policy "circle walks: send" on realtime.messages for insert to authenticated
      with check (realtime.topic() ~ '^circle-session:[0-9]+$'
        and public.on_this_walk(split_part(realtime.topic(), ':', 2)::bigint))$p$;
  end if;
end $$;

-- ---------- row level security and privileges ----------

alter table public.circles enable row level security;
alter table public.circle_members enable row level security;
alter table public.circle_sessions enable row level security;
alter table public.session_people enable row level security;
alter table public.circle_kudos enable row level security;
-- No policies: only the functions above read or write these.
revoke all on public.circles, public.circle_members, public.circle_sessions, public.session_people, public.circle_kudos
  from public, anon, authenticated;

revoke execute on function public.circle_size_limit(), public.circles_per_user(), public.guest_requests_limit(),
  public.first_name(public.profiles), public.next_occurrence(int, text, text, timestamptz),
  public.is_circle_member(bigint, uuid), public.is_circle_owner(bigint, uuid), public.circle_members_after_delete(),
  public.circle_week_done(bigint, text, date), public.circle_streak(bigint),
  public.my_circle(bigint), public.check_circle_fields(text, int, text, text, text, text, numeric)
  from public, anon, authenticated;
revoke execute on function public.in_session(bigint, uuid) from public, anon, authenticated;
-- on_this_walk() is used by the Realtime policies, which run as the caller.
revoke execute on function public.on_this_walk(bigint) from public, anon;
grant execute on function public.on_this_walk(bigint) to authenticated;

revoke execute on function
  public.create_circle(text, int, text, text, text, text, numeric, boolean),
  public.update_circle(bigint, text, int, text, text, text, text, numeric, boolean),
  public.join_circle(text), public.leave_circle(bigint), public.my_circles(), public.book_next(bigint),
  public.rsvp(bigint, text), public.circles_near(text), public.ask_to_join(bigint),
  public.answer_guest(bigint, uuid, boolean), public.my_guest_walks(), public.circle_check_in(bigint, text),
  public.log_circle_walk(bigint, timestamptz, numeric, int), public.circle_walk(bigint),
  public.circle_kudos_toggle(bigint, uuid, boolean), public.my_firsts()
  from public, anon;
grant execute on function
  public.create_circle(text, int, text, text, text, text, numeric, boolean),
  public.update_circle(bigint, text, int, text, text, text, text, numeric, boolean),
  public.join_circle(text), public.leave_circle(bigint), public.my_circles(), public.book_next(bigint),
  public.rsvp(bigint, text), public.circles_near(text), public.ask_to_join(bigint),
  public.answer_guest(bigint, uuid, boolean), public.my_guest_walks(), public.circle_check_in(bigint, text),
  public.log_circle_walk(bigint, timestamptz, numeric, int), public.circle_walk(bigint),
  public.circle_kudos_toggle(bigint, uuid, boolean), public.my_firsts()
  to authenticated;
