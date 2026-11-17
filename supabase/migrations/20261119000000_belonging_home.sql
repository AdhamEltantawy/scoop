-- Belonging, part 3: home, feed, ranks, challenges, bringing someone in.
--
-- * District warmth: how much of a district's walked hexes someone walked in
--   the last 60 days, against a goal of 80% by Sunday night.
-- * A weekly matchup: each district against the district in its city whose
--   warmth was closest when the week's pairing was made. Warmest on Sunday
--   night wins. Pairings are made once and stay for the week.
-- * Circles rank against circles in their district by km walked together
--   this week (members' own points stay private).
-- * Open district challenges, added by an admin (add_area_challenge), that
--   anyone in the district can join.
-- * Reactions (the four kudos emoji) on check-ins, badges and landmark finds,
--   not only walks.
-- * When a friend finds your landmark, your feed names them. Votes stay
--   anonymous, and strangers stay "an explorer".
-- * Personal invite codes ("ZAM-7KQ2"): one person, 7 days. Using one makes
--   you friends straight away (they shared it, you used it) for the usual 30
--   days, renewed only if you both choose. It points the newcomer to the
--   inviter's welcome landmark.
-- * Friend challenges are no longer shown in the app; their tables stay.
--
-- Safe to run again.

-- ---------- warmth ----------

create or replace function public.warm_days() returns int language sql immutable as $$ select 60 $$;
create or replace function public.warmth_goal() returns int language sql immutable as $$ select 80 $$;

-- A district right now:
--   hexes      hexes anyone ever walked there
--   warm       of those, walked by someone in the last 60 days
--   pct        warm / hexes, as a whole percentage
--   mine_warm  hexes you keep warm there
--   mine_week  hexes you walked there this week
--   explorers  people who walked there in the last 60 days
create or replace function public.district_warmth(district text)
returns table (hexes bigint, warm bigint, pct int, mine_warm bigint, mine_week bigint, explorers bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_variable
declare
  me uuid := auth.uid();
  d text := district;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if d is null or d !~ '^r[0-9]{1,12}$' then raise exception 'Bad district' using errcode = 'P0001'; end if;
  return query
  with cells as (
    select c.cell, max(c.last_visited) as last from user_cells c where c.district = d group by c.cell
  )
  select
    (select count(*) from cells),
    (select count(*) from cells x where x.last >= now() - warm_days() * interval '1 day'),
    coalesce((select round(100.0 * count(*) filter (where x.last >= now() - warm_days() * interval '1 day') / nullif(count(*), 0))::int
      from cells x), 0),
    (select count(*) from user_cells c where c.user_id = me and c.district = d
      and c.last_visited >= now() - warm_days() * interval '1 day'),
    (select count(*) from user_cells c where c.user_id = me and c.district = d and c.last_visited >= period_start('week')),
    (select count(distinct c.user_id) from user_cells c where c.district = d
      and c.last_visited >= now() - warm_days() * interval '1 day');
end $$;

-- Just the percentage, for comparing districts.
create or replace function public.district_pct(district text)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(round(100.0 * count(*) filter (where x.last >= now() - warm_days() * interval '1 day') / nullif(count(*), 0))::int, 0)
  from (select max(c.last_visited) as last from user_cells c where c.district = district_pct.district group by c.cell) x
$$;

-- ---------- the weekly matchup ----------

create table if not exists public.district_matchups (
  week date not null,
  district text not null,
  rival text not null,
  primary key (week, district)
);
alter table public.district_matchups enable row level security;
revoke all on public.district_matchups from public, anon, authenticated;

-- This week's rival for a district, pairing it now if it hasn't been yet:
-- the unpaired district in the same city with the closest warmth.
create or replace function public.district_matchup(district text)
returns table (rival text, rival_name text, pct int, rival_pct int, ends_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare
  d text := district;
  wk date := (date_trunc('week', now() at time zone 'utc'))::date;
  city text;
  mine int;
  r text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if d is null or d !~ '^r[0-9]{1,12}$' then raise exception 'Bad district' using errcode = 'P0001'; end if;
  select m.rival into r from district_matchups m where m.week = wk and m.district = d;
  if r is null then
    perform pg_advisory_xact_lock(hashtext('district_matchup ' || wk));
    select m.rival into r from district_matchups m where m.week = wk and m.district = d;
  end if;
  if r is null then
    select c.city into city from user_cells c where c.district = d and c.city is not null
      group by c.city order by count(*) desc, c.city limit 1;
    if city is not null then
      mine := district_pct(d);
      select x.district into r from (
        select distinct c.district from user_cells c
        where c.city = city and c.district is not null and c.district <> d
      ) x
      where not exists (select 1 from district_matchups m where m.week = wk and m.district = x.district)
      order by abs(district_pct(x.district) - mine), x.district
      limit 1;
      if r is not null then
        insert into district_matchups (week, district, rival) values (wk, d, r), (wk, r, d) on conflict do nothing;
      end if;
    end if;
  end if;
  return query select r, (select a.name from areas a where a.id = r), district_pct(d),
    case when r is null then null else district_pct(r) end,
    ((wk + 7)::timestamp at time zone 'utc');
end $$;

-- ---------- circles against circles ----------

-- Where your circle stands among the circles in its district this week, by
-- km walked together.
create or replace function public.circle_standing(circle bigint)
returns table (rank bigint, total bigint, km numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  c circles := my_circle(circle);
begin
  return query
  with weekly as (
    select x.id, coalesce((select sum(p.km) from circle_sessions s join session_people p on p.session_id = s.id
      where s.circle_id = x.id and s.starts_at >= period_start('week')), 0) as km
    from circles x where x.district is not distinct from c.district
  ), ranked as (
    select w.id, w.km, rank() over (order by w.km desc) as rk, count(*) over () as n from weekly w
  )
  select r.rk, r.n, r.km from ranked r where r.id = circle;
end $$;

-- ---------- open district challenges ----------

create table if not exists public.area_challenges (
  id bigint generated always as identity primary key,
  district text not null check (district ~ '^r[0-9]{1,12}$'),
  title text not null check (char_length(btrim(title)) between 1 and 60),
  detail text check (char_length(detail) <= 140),
  -- cells: warm every hex in `cells`; warmth: get the district to `target` %;
  -- landmarks: find every landmark in the district.
  kind text not null check (kind in ('cells', 'warmth', 'landmarks')),
  target numeric,
  cells text[],
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  check (kind <> 'cells' or cardinality(cells) between 1 and 2000),
  check (kind <> 'warmth' or target between 1 and 100)
);
create index if not exists area_challenges_district on public.area_challenges (district);

create table if not exists public.area_challenge_members (
  challenge_id bigint not null references public.area_challenges (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (challenge_id, user_id)
);

alter table public.area_challenges enable row level security;
alter table public.area_challenge_members enable row level security;
revoke all on public.area_challenges, public.area_challenge_members from public, anon, authenticated;

-- For admins, from the SQL editor:
--   select public.add_area_challenge('r900000000001', 'Warm the whole Corniche', 'Every hex along the river',
--     'cells', null, array['8a3e...'], now(), now() + interval '14 days');
create or replace function public.add_area_challenge(district text, title text, detail text, kind text,
  target numeric default null, cells text[] default null, starts_at timestamptz default now(), ends_at timestamptz default null)
returns bigint language sql security definer set search_path = public as $$
  insert into area_challenges (district, title, detail, kind, target, cells, starts_at, ends_at)
  values (district, btrim(title), nullif(btrim(detail), ''), kind, target, cells, starts_at, ends_at)
  returning id
$$;

-- How far along a challenge is, from 0 to 1. Landmarks are your own finds.
create or replace function public.area_challenge_progress(ch public.area_challenges, uid uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select case ch.kind
    when 'warmth' then least(1, district_pct(ch.district) / ch.target)
    when 'cells' then (select count(*) from unnest(ch.cells) x(cell) where exists (
        select 1 from user_cells c where c.cell8 = h3_to_parent(x.cell, 8) and c.cell = x.cell
          and c.last_visited >= now() - warm_days() * interval '1 day'))::numeric / cardinality(ch.cells)
    when 'landmarks' then coalesce((
      select count(*) filter (where exists (select 1 from landmark_finds f where f.landmark_id = l.id and f.user_id = uid))::numeric
        / nullif(count(*), 0)
      from landmarks l
      where l.user_id <> uid and exists (select 1 from user_cells c where c.cell8 = h3_to_parent(l.cell, 8) and c.cell = l.cell
        and c.district = ch.district)), 0)
  end
$$;

-- The challenges running in a district.
create or replace function public.area_challenges_for(district text)
returns table (id bigint, title text, detail text, kind text, ends_at timestamptz, members bigint, joined boolean, progress numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  return query
  select ch.id, ch.title, ch.detail, ch.kind, ch.ends_at,
    (select count(*) from area_challenge_members m where m.challenge_id = ch.id),
    exists (select 1 from area_challenge_members m where m.challenge_id = ch.id and m.user_id = me),
    round(area_challenge_progress(ch, me), 3)
  from area_challenges ch
  where ch.district = area_challenges_for.district and ch.starts_at <= now() and (ch.ends_at is null or ch.ends_at > now())
  order by ch.ends_at nulls last, ch.id;
end $$;

create or replace function public.join_area_challenge(challenge bigint, join_it boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from area_challenges ch where ch.id = challenge and ch.starts_at <= now()
      and (ch.ends_at is null or ch.ends_at > now())) then
    raise exception 'That challenge is over' using errcode = 'P0001';
  end if;
  if join_it then
    insert into area_challenge_members (challenge_id, user_id) values (challenge, auth.uid()) on conflict do nothing;
  else
    delete from area_challenge_members m where m.challenge_id = challenge and m.user_id = auth.uid();
  end if;
end $$;

-- ---------- reactions beyond walks ----------
-- Walks keep their kudos table. Check-ins, badges and landmark finds use this.
--   checkin  item = checkins.id
--   badge    item = '<user id>:<badge key>'
--   find     item = '<landmark id>:<finder id>'

create table if not exists public.reactions (
  kind text not null check (kind in ('checkin', 'badge', 'find')),
  item text not null check (char_length(item) <= 80),
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (emoji in ('👏', '🔥', '❤️', '👣')),
  created_at timestamptz not null default now(),
  primary key (kind, item, user_id)
);
alter table public.reactions enable row level security;
revoke all on public.reactions from public, anon, authenticated;

-- Whose item it is, if it exists.
create or replace function public.reaction_owner(kind text, item text)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if kind = 'checkin' then
    return (select k.user_id from checkins k where item ~ '^[0-9]{1,18}$' and k.id = item::bigint);
  elsif kind = 'badge' then
    return (select b.user_id from badges b where b.user_id::text = split_part(item, ':', 1) and b.badge_key = split_part(item, ':', 2));
  elsif kind = 'find' then
    return (select f.user_id from landmark_finds f where split_part(item, ':', 1) ~ '^[0-9]{1,18}$'
      and f.landmark_id = split_part(item, ':', 1)::bigint and f.user_id::text = split_part(item, ':', 2));
  end if;
  return null;
end $$;

-- React to a friend's check-in, badge or landmark find (null takes it back).
create or replace function public.react(kind text, item text, emoji text)
returns void language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  owner uuid := reaction_owner(react.kind, react.item);
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if owner is null then raise exception 'That''s gone' using errcode = 'P0001'; end if;
  if owner = auth.uid() then raise exception 'Kudos are for the others' using errcode = 'P0001'; end if;
  if not are_friends(auth.uid(), owner) then raise exception 'Kudos are for friends' using errcode = 'P0001'; end if;
  if react.emoji is null then
    delete from reactions r where r.kind = react.kind and r.item = react.item and r.user_id = auth.uid();
  else
    insert into reactions (kind, item, user_id, emoji) values (react.kind, react.item, auth.uid(), react.emoji)
    on conflict (kind, item, user_id) do update set emoji = excluded.emoji, created_at = now();
  end if;
end $$;

-- Reactions on items you can see (yours and friends'): counts per emoji, and yours.
create or replace function public.reactions_for(kind text, items text[])
returns table (item text, emoji text, n bigint, mine boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if cardinality(items) > 200 then raise exception 'Too many items' using errcode = 'P0001'; end if;
  return query
  select r.item, r.emoji, count(*), bool_or(r.user_id = me)
  from reactions r
  where r.kind = reactions_for.kind and r.item = any(items)
    and (select o = me or are_friends(me, o) from reaction_owner(reactions_for.kind, r.item) o)
  group by r.item, r.emoji;
end $$;

-- ---------- friends finding your landmarks ----------

-- Friends who found your landmarks, newest first (votes stay anonymous).
create or replace function public.landmark_finds_feed(before timestamptz, lim int default 20)
returns table (landmark_id bigint, kind text, title text, finder uuid, finder_name text, found_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  return query
  select l.id, l.kind, l.title, f.user_id, coalesce(p.display_name, p.username), f.found_at
  from landmarks l
  join landmark_finds f on f.landmark_id = l.id
  join profiles p on p.id = f.user_id
  where l.user_id = me and f.found_at < before and are_friends(me, f.user_id)
  order by f.found_at desc
  limit least(coalesce(lim, 20), 50);
end $$;

-- ---------- bringing someone in: personal invite codes ----------

create table if not exists public.invite_codes (
  code text primary key check (code ~ '^[A-Z]{3}-[A-Z0-9]{4}$'),
  user_id uuid not null references public.profiles (id) on delete cascade,
  landmark_id bigint references public.landmarks (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references public.profiles (id) on delete set null,
  used_at timestamptz
);
create index if not exists invite_codes_user on public.invite_codes (user_id);
alter table public.invite_codes enable row level security;
revoke all on public.invite_codes from public, anon, authenticated;

-- Your code to share: the one still open, or a new one. It carries your
-- newest welcome landmark, for the newcomer to find first.
create or replace function public.new_invite()
returns table (code text, expires_at timestamptz, landmark_id bigint, landmark_title text, landmark_kind text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  c text;
  prefix text;
  lm bigint;
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  if me is null then raise exception 'Not signed in'; end if;
  select l.id into lm from landmarks l where l.user_id = me and l.welcome
    and not landmark_buried((select count(*) filter (where f.vote = 1) from landmark_finds f where f.landmark_id = l.id),
      (select count(*) filter (where f.vote = -1) from landmark_finds f where f.landmark_id = l.id))
    order by l.created_at desc limit 1;
  select i.code into c from invite_codes i where i.user_id = me and i.used_by is null and i.expires_at > now() + interval '1 day'
    order by i.created_at desc limit 1;
  if c is not null then
    update invite_codes i set landmark_id = lm where i.code = c;
  else
    prefix := upper(left(regexp_replace(coalesce((select a.name from areas a where a.id = home_area(me, 'district')), ''),
      '[^A-Za-z]', '', 'g'), 3));
    if char_length(prefix) < 3 then prefix := 'SCP'; end if;
    for attempt in 1..20 loop
      c := prefix || '-' || (select string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '')
        from generate_series(1, 4));
      begin
        insert into invite_codes (code, user_id, landmark_id) values (c, me, lm);
        exit;
      exception when unique_violation then
        c := null;
      end;
    end loop;
    if c is null then raise exception 'Couldn''t make a code, try again' using errcode = 'P0001'; end if;
  end if;
  return query select i.code, i.expires_at, i.landmark_id, l.title, l.kind
    from invite_codes i left join landmarks l on l.id = i.landmark_id where i.code = c;
end $$;

-- Your codes from the last month, and who used them.
create or replace function public.my_invites()
returns table (code text, created_at timestamptz, expires_at timestamptz, used_at timestamptz, used_by_name text)
language sql stable security definer set search_path = public as $$
  select i.code, i.created_at, i.expires_at, i.used_at, coalesce(p.display_name, p.username)
  from invite_codes i left join profiles p on p.id = i.used_by
  where i.user_id = auth.uid() and i.created_at > now() - interval '30 days'
  order by i.created_at desc
$$;

-- Use a code: a personal one makes you friends now (for 30 days, renewed
-- only if you both choose); an old-style one sends a friend request as before.
-- landmark_id: the welcome to point you to first.
create or replace function public.use_invite(code text)
returns table (id uuid, username text, display_name text, status text, landmark_id bigint)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  inv invite_codes;
  f friendships;
  st text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if upper(btrim(code)) !~ '^[A-Z]{3}-[A-Z0-9]{4}$' then
    return query select r.id, r.username, r.display_name, r.status, null::bigint from send_friend_request(code) r;
    return;
  end if;
  select * into inv from invite_codes i where i.code = upper(btrim(use_invite.code)) for update;
  if not found or inv.expires_at < now() then raise exception 'That invite has expired. Ask for a new one' using errcode = 'P0001'; end if;
  if inv.user_id = me then raise exception 'That''s your own code' using errcode = 'P0001'; end if;
  if inv.used_by is not null and inv.used_by <> me then
    raise exception 'That invite was used already. Each one works for one person' using errcode = 'P0001';
  end if;
  select * into f from friendships x
    where (x.requester = me and x.addressee = inv.user_id) or (x.requester = inv.user_id and x.addressee = me);
  if found and f.status = 'accepted' and f.expires_at < now() - interval '30 days' then
    delete from friendships x where x.requester = f.requester and x.addressee = f.addressee;
    f := null;
  end if;
  if f.requester is null then
    insert into friendships (requester, addressee, status, expires_at) values (inv.user_id, me, 'accepted', now() + interval '30 days');
    st := 'accepted';
  elsif f.status = 'pending' then
    update friendships x set status = 'accepted', expires_at = now() + interval '30 days'
      where x.requester = f.requester and x.addressee = f.addressee;
    st := 'accepted';
  else
    -- Already friends: a code never renews a friendship. That stays a choice you both make.
    st := 'already';
  end if;
  update invite_codes i set used_by = me, used_at = coalesce(i.used_at, now()) where i.code = inv.code;
  return query select p.id, p.username, p.display_name, st, inv.landmark_id from profiles p where p.id = inv.user_id;
end $$;

-- ---------- privileges ----------

revoke execute on function public.warm_days(), public.warmth_goal(), public.district_pct(text),
  public.add_area_challenge(text, text, text, text, numeric, text[], timestamptz, timestamptz),
  public.area_challenge_progress(public.area_challenges, uuid), public.reaction_owner(text, text)
  from public, anon, authenticated;
revoke execute on function public.district_warmth(text), public.district_matchup(text), public.circle_standing(bigint),
  public.area_challenges_for(text), public.join_area_challenge(bigint, boolean), public.react(text, text, text),
  public.reactions_for(text, text[]), public.landmark_finds_feed(timestamptz, int), public.new_invite(),
  public.my_invites(), public.use_invite(text)
  from public, anon;
grant execute on function public.district_warmth(text), public.district_matchup(text), public.circle_standing(bigint),
  public.area_challenges_for(text), public.join_area_challenge(bigint, boolean), public.react(text, text, text),
  public.reactions_for(text, text[]), public.landmark_finds_feed(timestamptz, int), public.new_invite(),
  public.my_invites(), public.use_invite(text)
  to authenticated;
