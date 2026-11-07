-- Landmarks earn points, and finders vote on them.
--
-- Points (they fade like check-ins, and count in your areas, weekly and
-- monthly boards and challenges):
--   leave a landmark            +3
--   find someone's landmark     +2
--   your landmark is found      +1 per explorer
--   your landmark gets a 👍     +1 per vote
-- Removing a landmark takes back what its author earned from it, so leaving
-- and removing one again doesn't farm points. Finders keep theirs.
--
-- Once you've found a landmark you can vote on it: thumbs up or down. A
-- landmark with 3 or more downs and at least twice as many downs as ups is
-- hidden from everyone but its author (and nobody gets told about it).
--
-- Safe to run again.

alter table public.landmark_finds add column if not exists vote smallint check (vote in (-1, 1));
alter table public.landmark_finds add column if not exists voted_at timestamptz;

create table if not exists public.landmark_points (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  landmark_id bigint references public.landmarks (id) on delete set null,
  cell text not null check (cell ~ '^8a[0-9a-f]{13}$'),
  -- The landmark's author: their hex in `cell` says which district, city and
  -- country the points count in.
  author uuid references public.profiles (id) on delete set null,
  reason text not null check (reason in ('left', 'found', 'was_found', 'upvoted')),
  -- The finder or voter, for 'was_found' and 'upvoted'.
  from_user uuid references public.profiles (id) on delete cascade,
  points numeric not null,
  created_at timestamptz not null default now()
);
create index if not exists landmark_points_user on public.landmark_points (user_id, created_at);
create index if not exists landmark_points_landmark on public.landmark_points (landmark_id);

alter table public.landmark_points enable row level security;
-- No policies: only the functions below read or write it.
revoke all on public.landmark_points from public, anon, authenticated;

-- Keep in sync with LANDMARK_POINTS in social-core.js.
create or replace function public.landmark_reward(reason text)
returns numeric language sql immutable as $$
  select case reason when 'left' then 3 when 'found' then 2 when 'was_found' then 1 when 'upvoted' then 1 else 0 end
$$;

-- Hidden from everyone but the author: voted down by enough finders.
create or replace function public.landmark_buried(ups bigint, downs bigint)
returns boolean language sql immutable as $$
  select downs >= 3 and downs >= 2 * ups
$$;

-- ---------- awarding ----------

create or replace function public.landmarks_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into landmark_points (user_id, landmark_id, cell, author, reason, points)
  values (new.user_id, new.id, new.cell, new.user_id, 'left', landmark_reward('left'));
  return null;
end $$;
drop trigger if exists landmarks_award on public.landmarks;
create trigger landmarks_award after insert on public.landmarks
  for each row execute function public.landmarks_after_insert();

create or replace function public.landmarks_before_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from landmark_points where landmark_id = old.id and user_id = old.user_id;
  return old;
end $$;
drop trigger if exists landmarks_take_back on public.landmarks;
create trigger landmarks_take_back before delete on public.landmarks
  for each row execute function public.landmarks_before_delete();

create or replace function public.landmark_finds_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  l record;
begin
  select id, user_id, cell into l from landmarks where id = new.landmark_id;
  insert into landmark_points (user_id, landmark_id, cell, author, reason, from_user, points) values
    (new.user_id, l.id, l.cell, l.user_id, 'found', null, landmark_reward('found')),
    (l.user_id, l.id, l.cell, l.user_id, 'was_found', new.user_id, landmark_reward('was_found'));
  return null;
end $$;
drop trigger if exists landmark_finds_award on public.landmark_finds;
create trigger landmark_finds_award after insert on public.landmark_finds
  for each row execute function public.landmark_finds_after_insert();

-- ---------- scores now include landmark points ----------

create or replace function public.landmark_points_in(p public.landmark_points, area text)
returns boolean language sql stable security definer set search_path = public as $$
  select area is null or exists (
    select 1 from user_cells c where c.user_id = p.author and c.cell = p.cell and area in (c.country, c.city, c.district))
$$;

create or replace function public.score_now(uid uuid, area text)
returns numeric language sql stable security definer set search_path = public as $$
  select
    coalesce((select sum(hex_value(c.visits) * heat(c.last_visited, now())) from user_cells c
      where c.user_id = uid and (area is null or area in (c.country, c.city, c.district))), 0)::numeric
  + coalesce((select sum(checkin_points(k.kind, k.met_with) * heat(k.created_at, now())) from checkins k
      where k.user_id = uid and (area is null or exists (
        select 1 from user_cells c where c.user_id = uid and c.cell = k.cell and area in (c.country, c.city, c.district)))), 0)::numeric
  + coalesce((select sum(p.points * heat(p.created_at, now())) from landmark_points p
      where p.user_id = uid and landmark_points_in(p, area)), 0)::numeric
$$;

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
  + coalesce((select sum(p.points) from landmark_points p
      where p.user_id = uid and p.created_at >= t0 and (t1 is null or p.created_at < t1)
        and landmark_points_in(p, area)), 0)
$$;

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
    union
    select p.user_id from landmark_points p join user_cells c on c.user_id = p.author and c.cell = p.cell
      where area in (c.country, c.city, c.district)
        and (t0 is null or (p.created_at >= t0 and (t1 is null or p.created_at < t1)))
  ), scored as (
    select p.user_id,
      round(case when t0 is null then score_now(p.user_id, area) else score_gained(p.user_id, t0, t1, area) end, 2) as v
    from people p
  )
  select s.user_id, s.v, rank() over (order by s.v desc), count(*) over ()
  from scored s
$$;

create or replace function public.everyone_ranking(t0 timestamptz, t1 timestamptz)
returns table (user_id uuid, value numeric, rank bigint, total bigint)
language sql stable security definer set search_path = public as $$
  with people as (
    select distinct c.user_id from user_cells c where t0 is null
    union
    select e.user_id from score_events e
      where t0 is not null
        and e.day >= (t0 at time zone 'utc')::date and (t1 is null or e.day <= (t1 at time zone 'utc')::date)
    union
    select k.user_id from checkins k
      where t0 is not null and k.created_at >= t0 and (t1 is null or k.created_at < t1)
    union
    select p.user_id from landmark_points p
      where t0 is null or (p.created_at >= t0 and (t1 is null or p.created_at < t1))
  ), scored as (
    select p.user_id,
      round(case when t0 is null then score_now(p.user_id, null) else score_gained(p.user_id, t0, t1, null) end, 2) as v
    from people p
  )
  select s.user_id, s.v, rank() over (order by s.v desc), count(*) over ()
  from scored s
$$;

-- ---------- client API ----------

-- As before, plus votes. Buried landmarks only show up for their author.
drop function if exists public.landmarks_near(text[]);
create function public.landmarks_near(blocks text[])
returns table (id bigint, cell text, kind text, title text, note text, created_at timestamptz,
  author text, mine boolean, finds bigint, found_by_me boolean, ups bigint, downs bigint, my_vote smallint)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if cardinality(blocks) > 50 then raise exception 'Too many blocks' using errcode = 'P0001'; end if;
  return query
  select l.id, l.cell, l.kind, l.title, l.note, l.created_at,
    case when l.user_id = auth.uid() or are_friends(auth.uid(), l.user_id)
      then coalesce(p.display_name, p.username) end,
    l.user_id = auth.uid(), s.finds, me.user_id is not null, s.ups, s.downs, me.vote
  from landmarks l
  join profiles p on p.id = l.user_id
  cross join lateral (
    select count(*) as finds, count(*) filter (where f.vote = 1) as ups, count(*) filter (where f.vote = -1) as downs
    from landmark_finds f where f.landmark_id = l.id
  ) s
  left join landmark_finds me on me.landmark_id = l.id and me.user_id = auth.uid()
  where l.cell7 = any(blocks)
    and (l.user_id = auth.uid() or not landmark_buried(s.ups, s.downs))
  order by l.created_at desc
  limit 500;
end $$;

-- As before, plus votes, whether it's hidden, and the points it earned you.
drop function if exists public.my_landmarks();
create function public.my_landmarks()
returns table (id bigint, cell text, kind text, title text, note text, created_at timestamptz,
  finds bigint, last_found timestamptz, ups bigint, downs bigint, buried boolean, points numeric)
language sql stable security definer set search_path = public as $$
  select l.id, l.cell, l.kind, l.title, l.note, l.created_at,
    s.finds, s.last_found, s.ups, s.downs, landmark_buried(s.ups, s.downs),
    (select coalesce(sum(p.points), 0) from landmark_points p where p.landmark_id = l.id and p.user_id = l.user_id)
  from landmarks l
  cross join lateral (
    select count(*) as finds, max(f.found_at) as last_found,
      count(*) filter (where f.vote = 1) as ups, count(*) filter (where f.vote = -1) as downs
    from landmark_finds f where f.landmark_id = l.id
  ) s
  where l.user_id = auth.uid()
  order by l.created_at desc
$$;

-- Thumbs up (1) or down (-1) on a landmark you found. Voting again changes
-- your vote. A thumbs up gives the author a point. Returns the totals.
create or replace function public.vote_landmark(landmark bigint, vote int)
returns table (ups bigint, downs bigint)
language plpgsql security definer set search_path = public as $$
declare
  l record;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if vote is null or vote not in (-1, 1) then raise exception 'Vote up or down' using errcode = 'P0001'; end if;
  select id, user_id, cell into l from landmarks where id = landmark;
  if not found then raise exception 'That landmark is gone' using errcode = 'P0001'; end if;
  update landmark_finds f set vote = vote_landmark.vote, voted_at = now()
    where f.landmark_id = landmark and f.user_id = auth.uid();
  if not found then raise exception 'Find this landmark before voting on it' using errcode = 'P0001'; end if;
  delete from landmark_points p where p.landmark_id = landmark and p.reason = 'upvoted' and p.from_user = auth.uid();
  if vote = 1 then
    insert into landmark_points (user_id, landmark_id, cell, author, reason, from_user, points)
    values (l.user_id, l.id, l.cell, l.user_id, 'upvoted', auth.uid(), landmark_reward('upvoted'));
  end if;
  return query select count(*) filter (where f.vote = 1), count(*) filter (where f.vote = -1)
    from landmark_finds f where f.landmark_id = landmark;
end $$;

-- ---------- privileges ----------

revoke execute on function public.landmarks_after_insert(), public.landmarks_before_delete(),
  public.landmark_finds_after_insert(), public.landmark_reward(text), public.landmark_buried(bigint, bigint),
  public.landmark_points_in(public.landmark_points, text)
  from public, anon, authenticated;
revoke execute on function public.landmarks_near(text[]), public.my_landmarks(), public.vote_landmark(bigint, int)
  from public, anon;
grant execute on function public.landmarks_near(text[]), public.my_landmarks(), public.vote_landmark(bigint, int)
  to authenticated;
