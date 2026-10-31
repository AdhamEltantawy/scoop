-- Scoop: fading scores, official areas, monthly friend renewal and
-- friends-only visibility. Builds on 20261026000000_social.sql.
--
-- Scores fade: a hex is worth hex_value(visits) = 1 + floor(log2(visits)),
-- times its heat, which halves every 30 days since you last walked through it.
-- Check-ins fade the same way from when they were made. Walking through a hex
-- warms it back up, and the points that earns are logged per day and area in
-- score_events, which the week / month leaderboards and challenges add up.
--
-- Every hex is tagged with the official country, city and district it's in
-- (OpenStreetMap admin boundaries, looked up on the device). Each area has its
-- own leaderboard, where people who aren't your friends are anonymous.
--
-- Who sees what: your last-visit times, per-hex dates and score log are only
-- ever read by these functions, never returned to anyone. Friends see which
-- hexes you explored, your walks, check-ins, scores and home district.
-- Friendships last 30 days and renew only when both people renew.

-- ---------- scoring helpers ----------
-- Keep in sync with heat() and hexValue() in social-core.js.

create or replace function public.heat(last timestamptz, at timestamptz)
returns double precision language sql immutable parallel safe as $$
  select case when last is null then 0
    else power(0.5, greatest(0, extract(epoch from (at - last))) / (30 * 86400)) end
$$;

create or replace function public.hex_value(visits int)
returns int language sql immutable parallel safe as $$
  select case when visits >= 1 then 1 + floor(log(2.0, visits::numeric))::int else 0 end
$$;

-- ---------- areas ----------

create table public.areas (
  id text primary key check (id ~ '^r[0-9]{1,12}$'),
  kind text not null check (kind in ('country', 'city', 'district')),
  name text not null check (char_length(name) between 1 and 120),
  level int check (level between 1 and 12)
);

alter table public.user_cells
  add column last_visited timestamptz,
  add column country text check (country ~ '^r[0-9]{1,12}$'),
  add column city text check (city ~ '^r[0-9]{1,12}$'),
  add column district text check (district ~ '^r[0-9]{1,12}$');
update public.user_cells set last_visited = first_visited;
alter table public.user_cells
  alter column last_visited set not null,
  add constraint user_cells_last_visited check (last_visited >= first_visited and last_visited <= now() + interval '1 day');
create index user_cells_country on public.user_cells (country);
create index user_cells_city on public.user_cells (city);
create index user_cells_district on public.user_cells (district);

-- Points earned per user, day (UTC) and area. '' when an area isn't known.
create table public.score_events (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  country text not null default '',
  city text not null default '',
  district text not null default '',
  points numeric(12, 2) not null check (points >= 0),
  primary key (user_id, day, country, city, district)
);
create index score_events_day on public.score_events (day);

-- ---------- friendships expire ----------

alter table public.friendships
  add column expires_at timestamptz,
  add column requester_renewed boolean not null default false,
  add column addressee_renewed boolean not null default false;
-- Existing friendships get a fresh month.
update public.friendships set expires_at = now() + interval '30 days' where status = 'accepted';

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships
    where status = 'accepted' and expires_at > now()
      and ((requester = a and addressee = b) or (requester = b and addressee = a))
  )
$$;

create or replace function public.can_view_folder(folder text)
returns boolean language sql stable security definer set search_path = public as $$
  select folder = auth.uid()::text or exists (
    select 1 from profiles p where p.id::text = folder and are_friends(auth.uid(), p.id)
  )
$$;

-- ---------- no more public profiles ----------
-- Outside your friends you only appear, anonymously, on area leaderboards.

drop policy "profiles: read self, connected and public" on public.profiles;
create policy "profiles: read self and connected" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_connected(id));
drop function public.collective_map(text[]);
alter table public.profiles drop column leaderboard_public;

-- Friends see which hexes you explored and how often, not when.
revoke select on public.user_cells from authenticated;
grant select (user_id, cell, visits) on public.user_cells to authenticated;

-- ---------- scores ----------

drop function public.leaderboard(text, text, text);
drop function public.challenge_standings(bigint);
drop function public.metric_between(uuid, text, timestamptz, timestamptz, text[]);
drop function public.score_between(uuid, timestamptz, timestamptz, text[]);

-- Current (faded) score, optionally only in one area.
create or replace function public.score_now(uid uuid, area text)
returns numeric language sql stable security definer set search_path = public as $$
  select
    coalesce((select sum(hex_value(c.visits) * heat(c.last_visited, now())) from user_cells c
      where c.user_id = uid and (area is null or area in (c.country, c.city, c.district))), 0)::numeric
  + coalesce((select sum(checkin_points(k.kind, k.met_with) * heat(k.created_at, now())) from checkins k
      where k.user_id = uid and (area is null or exists (
        select 1 from user_cells c where c.user_id = uid and c.cell = k.cell and area in (c.country, c.city, c.district)))), 0)::numeric
$$;

-- Points earned from t0 until t1 (null: until now), optionally only in one
-- area. Walk points are logged per day, so t0 and t1 count whole days.
create or replace function public.score_gained(uid uuid, t0 timestamptz, t1 timestamptz, area text)
returns numeric language sql stable security definer set search_path = public as $$
  select
    coalesce((select sum(e.points) from score_events e
      where e.user_id = uid
        and e.day >= (t0 at time zone 'utc')::date
        and (t1 is null or e.day <= (t1 at time zone 'utc')::date)
        and (area is null or area in (e.country, e.city, e.district))), 0)
  + coalesce((select sum(checkin_points(k.kind, k.met_with)) from checkins k
      where k.user_id = uid and k.created_at >= t0 and (t1 is null or k.created_at < t1)
        and (area is null or exists (
          select 1 from user_cells c where c.user_id = uid and c.cell = k.cell and area in (c.country, c.city, c.district)))), 0)
$$;

-- Everyone ranked in an area: by current score (t0 null) or by points earned
-- from t0 to t1.
create or replace function public.area_ranking(area text, t0 timestamptz, t1 timestamptz)
returns table (user_id uuid, value numeric, rank bigint, total bigint)
language sql stable security definer set search_path = public as $$
  with people as (
    select c.user_id from user_cells c
      where t0 is null and area in (c.country, c.city, c.district)
    union
    select e.user_id from score_events e
      where t0 is not null and area in (e.country, e.city, e.district)
        and e.day >= (t0 at time zone 'utc')::date and (t1 is null or e.day <= (t1 at time zone 'utc')::date)
    union
    select k.user_id from checkins k join user_cells c on c.user_id = k.user_id and c.cell = k.cell
      where t0 is not null and area in (c.country, c.city, c.district)
        and k.created_at >= t0 and (t1 is null or k.created_at < t1)
  ), scored as (
    select p.user_id,
      round(case when t0 is null then score_now(p.user_id, area) else score_gained(p.user_id, t0, t1, area) end, 2) as v
    from people p
  )
  select s.user_id, s.v, rank() over (order by s.v desc), count(*) over ()
  from scored s
$$;

-- The area of each kind where someone's current score is highest: their home
-- district, city and country.
create or replace function public.home_area(uid uuid, kind text)
returns text language sql stable security definer set search_path = public as $$
  select a from (
    select case kind when 'district' then c.district when 'city' then c.city else c.country end as a,
      hex_value(c.visits) * heat(c.last_visited, now()) as s
    from user_cells c where c.user_id = uid
  ) x
  where a is not null
  group by a
  order by sum(s) desc, a
  limit 1
$$;

create or replace function public.period_start(period text)
returns timestamptz language sql stable as $$
  select case period
    when 'week' then date_trunc('week', now() at time zone 'utc') at time zone 'utc'
    when 'month' then date_trunc('month', now() at time zone 'utc') at time zone 'utc'
  end
$$;

-- ---------- sync ----------

drop function public.sync_cells(jsonb);

-- [{ "c": cell, "t": firstVisitedMs, "l": lastVisitedMs, "v": visits,
--    "a": [countryId, cityId, districtId] }, …]
create or replace function public.parse_cells(cells jsonb)
returns table (cell text, fv timestamptz, lv timestamptz, v int, country text, city text, district text)
language sql immutable as $$
  select distinct on (x ->> 'c')
    x ->> 'c',
    to_timestamp((x ->> 't')::double precision / 1000),
    greatest(to_timestamp((x ->> 't')::double precision / 1000),
             to_timestamp(coalesce(x ->> 'l', x ->> 't')::double precision / 1000)),
    greatest(1, coalesce((x ->> 'v')::int, 1)),
    nullif(x -> 'a' ->> 0, ''), nullif(x -> 'a' ->> 1, ''), nullif(x -> 'a' ->> 2, '')
  from jsonb_array_elements(cells) as x
  order by x ->> 'c'
$$;

-- Upsert visited cells, keeping the earliest first visit, latest last visit and
-- highest visit count, and log the points that warming them up earned.
-- areas: [{ "id": "r123", "kind": "district", "name": "…", "level": 9 }, …]
create or replace function public.sync_cells(cells jsonb, areas jsonb default '[]'::jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  n int;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(cells) > 1000 then raise exception 'At most 1000 cells per call'; end if;
  if jsonb_array_length(areas) > 200 then raise exception 'At most 200 areas per call'; end if;

  insert into public.areas (id, kind, name, level)
  select x ->> 'id', x ->> 'kind', left(x ->> 'name', 120), (x ->> 'level')::int
  from jsonb_array_elements(areas) as x
  on conflict (id) do nothing;

  insert into score_events as e (user_id, day, country, city, district, points)
  select me, (i.lv at time zone 'utc')::date,
    coalesce(i.country, u.country, ''), coalesce(i.city, u.city, ''), coalesce(i.district, u.district, ''),
    sum(case
      when u.cell is null then hex_value(i.v)
      when i.lv > u.last_visited
        then greatest(0, hex_value(greatest(i.v, u.visits)) - hex_value(u.visits) * heat(u.last_visited, i.lv))
      else greatest(0, hex_value(i.v) - hex_value(u.visits))
    end)
  from parse_cells(cells) i
  left join user_cells u on u.user_id = me and u.cell = i.cell
  group by 2, 3, 4, 5
  having sum(case
      when u.cell is null then hex_value(i.v)
      when i.lv > u.last_visited
        then greatest(0, hex_value(greatest(i.v, u.visits)) - hex_value(u.visits) * heat(u.last_visited, i.lv))
      else greatest(0, hex_value(i.v) - hex_value(u.visits))
    end) > 0
  on conflict (user_id, day, country, city, district) do update set points = e.points + excluded.points;

  insert into user_cells (user_id, cell, first_visited, last_visited, visits, country, city, district)
  select me, i.cell, i.fv, i.lv, i.v, i.country, i.city, i.district from parse_cells(cells) i
  on conflict (user_id, cell) do update set
    first_visited = least(user_cells.first_visited, excluded.first_visited),
    last_visited = greatest(user_cells.last_visited, excluded.last_visited),
    visits = greatest(user_cells.visits, excluded.visits),
    country = coalesce(excluded.country, user_cells.country),
    city = coalesce(excluded.city, user_cells.city),
    district = coalesce(excluded.district, user_cells.district);
  get diagnostics n = row_count;
  perform award_badges(me);
  return n;
end $$;

-- ---------- leaderboards ----------

-- You and your friends, by current score (period 'now') or by points earned
-- this week or month.
create or replace function public.leaderboard(period text default 'now')
returns table (user_id uuid, username text, display_name text, value numeric, rank bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  since timestamptz := period_start(period);
begin
  if me is null then raise exception 'Not signed in'; end if;
  if period not in ('now', 'week', 'month') then raise exception 'Bad leaderboard period'; end if;
  return query
    with scored as (
      select p.id, p.username, p.display_name,
        round(case when since is null then score_now(p.id, null) else score_gained(p.id, since, null, null) end, 2) as v
      from profiles p
      where p.id = me or are_friends(me, p.id)
    )
    select s.id, s.username, s.display_name, s.v, rank() over (order by s.v desc)
    from scored s
    order by 5, 2;
end $$;

-- Everyone in a district, city or country. Only you and your friends are
-- named; everyone else is an anonymous row. Top 50, plus your own row.
create or replace function public.area_leaderboard(area text, period text default 'now')
returns table (rank bigint, value numeric, total bigint, is_me boolean, is_friend boolean,
  user_id uuid, username text, display_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if period not in ('now', 'week', 'month') then raise exception 'Bad leaderboard period'; end if;
  return query
    select r.rank, r.value, r.total, r.user_id = me, f.yes,
      case when r.user_id = me or f.yes then r.user_id end,
      case when r.user_id = me or f.yes then p.username end,
      case when r.user_id = me or f.yes then p.display_name end
    from area_ranking(area, period_start(period), null) r
    join profiles p on p.id = r.user_id
    cross join lateral (select are_friends(me, r.user_id) as yes) f
    where r.rank <= 50 or r.user_id = me
    order by r.rank, (r.user_id = me) desc;
end $$;

-- Your home district, city and country, with your place in each.
create or replace function public.my_areas(period text default 'now')
returns table (kind text, id text, name text, rank bigint, total bigint, value numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if period not in ('now', 'week', 'month') then raise exception 'Bad leaderboard period'; end if;
  return query
    select k.kind, h.id, a.name, r.rank, r.total, r.value
    from (values ('district', 1), ('city', 2), ('country', 3)) as k (kind, ord)
    cross join lateral (select home_area(me, k.kind) as id) h
    left join areas a on a.id = h.id
    left join lateral (select * from area_ranking(h.id, period_start(period), null) x where x.user_id = me) r on true
    where h.id is not null
    order by k.ord;
end $$;

-- Scores and stats of you and your friends (friends only see each other's
-- totals and home district, never per-hex dates).
create or replace function public.friend_stats()
returns table (user_id uuid, username text, display_name text, score numeric, week numeric, month numeric,
  hexes bigint, km numeric, district text, district_name text, district_rank bigint, district_total bigint,
  expires_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  return query
    select p.id, p.username, p.display_name,
      round(score_now(p.id, null), 2),
      round(score_gained(p.id, period_start('week'), null, null), 2),
      round(score_gained(p.id, period_start('month'), null, null), 2),
      (select count(*) from user_cells c where c.user_id = p.id),
      (select coalesce(sum(w.km), 0) from walks w where w.user_id = p.id),
      h.id, a.name, r.rank, r.total,
      (select f.expires_at from friendships f
        where (f.requester = me and f.addressee = p.id) or (f.requester = p.id and f.addressee = me))
    from profiles p
    cross join lateral (select home_area(p.id, 'district') as id) h
    left join areas a on a.id = h.id
    left join lateral (select * from area_ranking(h.id, null, null) x where x.user_id = p.id) r on true
    where p.id = me or are_friends(me, p.id)
    order by 4 desc;
end $$;

-- ---------- friend requests and renewal ----------

-- Renew a friendship in its last 7 days, or up to 30 days after it lapsed.
-- It only renews (for another 30 days) once both of you have.
create or replace function public.renew_friendship(other uuid)
returns table (expires_at timestamptz, renewed boolean, waiting_for_them boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  f friendships;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select * into f from friendships x
    where (x.requester = me and x.addressee = other) or (x.requester = other and x.addressee = me);
  if not found or f.status <> 'accepted' then raise exception 'You''re not friends' using errcode = 'P0001'; end if;
  if f.expires_at > now() + interval '7 days' then
    raise exception 'You can renew in the last 7 days of the month' using errcode = 'P0001';
  end if;
  if f.expires_at < now() - interval '30 days' then
    raise exception 'This friendship lapsed over a month ago — add each other again with an invite code' using errcode = 'P0001';
  end if;
  update friendships x set
    requester_renewed = x.requester_renewed or x.requester = me,
    addressee_renewed = x.addressee_renewed or x.addressee = me
  where x.requester = f.requester and x.addressee = f.addressee
  returning * into f;
  if f.requester_renewed and f.addressee_renewed then
    update friendships x set
      expires_at = greatest(x.expires_at, now()) + interval '30 days',
      requester_renewed = false, addressee_renewed = false
    where x.requester = f.requester and x.addressee = f.addressee
    returning * into f;
    return query select f.expires_at, true, false;
  else
    return query select f.expires_at, false, true;
  end if;
end $$;

-- Send a request by invite code. If they already asked you, you're now
-- friends. If you were friends and it lapsed (or is about to), this renews.
create or replace function public.send_friend_request(code text)
returns table (id uuid, username text, display_name text, status text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  other uuid;
  f friendships;
  has_row boolean;
  st text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select p.id into other from profiles p where p.invite_code = upper(trim(code));
  if other is null then raise exception 'No one has that invite code' using errcode = 'P0001'; end if;
  if other = me then raise exception 'That''s your own code' using errcode = 'P0001'; end if;
  select * into f from friendships x
    where (x.requester = me and x.addressee = other) or (x.requester = other and x.addressee = me);
  has_row := found;
  if has_row and f.status = 'accepted' and f.expires_at < now() - interval '30 days' then
    -- Lapsed too long ago: start over.
    delete from friendships x where x.requester = f.requester and x.addressee = f.addressee;
    has_row := false;
  end if;
  if not has_row then
    insert into friendships (requester, addressee) values (me, other);
    st := 'pending';
  elsif f.status = 'pending' and f.requester = other then
    update friendships x set status = 'accepted', expires_at = now() + interval '30 days'
      where x.requester = other and x.addressee = me;
    st := 'accepted';
  elsif f.status = 'pending' then
    st := 'pending';
  elsif f.expires_at > now() + interval '7 days' then
    st := 'accepted';
  else
    st := case when (select r.renewed from renew_friendship(other) r) then 'accepted' else 'renewing' end;
  end if;
  return query select p.id, p.username, p.display_name, st from profiles p where p.id = other;
end $$;

create or replace function public.respond_friend_request(other uuid, accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if accept then
    update friendships set status = 'accepted', expires_at = now() + interval '30 days'
    where requester = other and addressee = auth.uid() and status = 'pending';
  else
    delete from friendships where requester = other and addressee = auth.uid() and status = 'pending';
  end if;
end $$;

-- ---------- challenges: friends across districts ----------
-- Each member is ranked in their own home district by the points they earned
-- there during the challenge. The best percentile wins: 6th of 500 beats 3rd
-- of 4. top_pct = (rank - 0.5) / people * 100; no points means 100.

alter table public.challenges drop column area_cells;
alter table public.challenges drop constraint challenges_metric_check;
update public.challenges set metric = 'district';
alter table public.challenges alter column metric set default 'district',
  add constraint challenges_metric_check check (metric = 'district');
revoke insert on public.challenges from authenticated;
grant insert (title, starts_at, ends_at) on public.challenges to authenticated;

create or replace function public.challenge_standings(cid bigint)
returns table (user_id uuid, username text, display_name text, status text, district text, district_name text,
  value numeric, district_rank bigint, district_total bigint, top_pct numeric, rank bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  ch challenges;
begin
  if not is_challenge_member(cid) then raise exception 'Not part of this challenge'; end if;
  select * into ch from challenges where id = cid;
  return query
    with m as (
      select p.id, p.username, p.display_name, m.status, home_area(p.id, 'district') as d
      from challenge_members m join profiles p on p.id = m.user_id
      where m.challenge_id = cid
    ), standing as (
      select m.*, r.value as v, r.rank as rk, r.total as n
      from m left join lateral (
        select * from area_ranking(m.d, ch.starts_at, least(ch.ends_at, now())) x where x.user_id = m.id
      ) r on true
    ), scored as (
      select s.*,
        case when s.status <> 'joined' or coalesce(s.v, 0) <= 0 then 100::numeric
          else round((s.rk - 0.5) / s.n * 100, 1) end as pct
      from standing s
    )
    select s.id, s.username, s.display_name, s.status, s.d, a.name,
      coalesce(s.v, 0), s.rk, s.n, s.pct,
      rank() over (order by (s.status = 'joined') desc, s.pct, s.rk nulls last, coalesce(s.v, 0) desc)
    from scored s left join areas a on a.id = s.d
    order by 11, 2;
end $$;

-- ---------- community map: you and your friends ----------

-- Street hexes in the given resolution-8 cells with how many of you and your
-- friends explored them, and who got there first (no dates).
create or replace function public.collective_map(cells8 text[])
returns table (cell text, explorers bigint, first_username text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if cardinality(cells8) > 60 then raise exception 'Zoom in to see the community map'; end if;
  return query
    select c.cell, count(*), (array_agg(p.username order by c.first_visited))[1]
    from user_cells c join profiles p on p.id = c.user_id
    where c.cell8 = any (cells8) and (c.user_id = me or are_friends(me, c.user_id))
    group by c.cell;
end $$;

-- ---------- row level security and privileges ----------

alter table public.areas enable row level security;
alter table public.score_events enable row level security;
create policy "areas: names are readable" on public.areas for select to authenticated using (true);
-- score_events has no policies: only the functions above read or write it.

revoke all on public.areas, public.score_events from anon, authenticated;
grant select on public.areas to authenticated;

revoke execute on function public.score_now(uuid, text), public.score_gained(uuid, timestamptz, timestamptz, text),
  public.area_ranking(text, timestamptz, timestamptz), public.home_area(uuid, text), public.parse_cells(jsonb)
  from public, anon, authenticated;

revoke execute on function public.sync_cells(jsonb, jsonb), public.leaderboard(text), public.area_leaderboard(text, text),
  public.my_areas(text), public.friend_stats(), public.renew_friendship(uuid), public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean), public.challenge_standings(bigint), public.collective_map(text[])
  from public, anon;
grant execute on function public.sync_cells(jsonb, jsonb), public.leaderboard(text), public.area_leaderboard(text, text),
  public.my_areas(text), public.friend_stats(), public.renew_friendship(uuid), public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean), public.challenge_standings(bigint), public.collective_map(text[])
  to authenticated;
