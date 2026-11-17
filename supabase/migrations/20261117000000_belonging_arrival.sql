-- Belonging, part 1: arriving in a neighbourhood.
--
-- * Welcome landmarks. Leaving a landmark, you can point newcomers to it. New
--   explorers are shown the nearest well-rated one as their first landmark to
--   find ("A welcome from a neighbour").
-- * area_pulse(): neighbourhood totals for the welcome screens, before signing
--   in too. It takes a district id and the ~5 km² blocks around you, and
--   returns counts and where landmarks are, never what they are or who left
--   them. Nothing about the caller is stored.
-- * my_firsts(): the six "neighbourhood firsts" a newcomer works through.
--
-- Safe to run again.

alter table public.landmarks add column if not exists welcome boolean not null default false;
grant select (welcome) on public.landmarks to authenticated;
grant insert (welcome) on public.landmarks to authenticated;

-- How many landmark pins area_pulse() returns at most.
create or replace function public.pulse_pin_limit()
returns int language sql immutable as $$ select 300 $$;

-- ---------- client API ----------

-- As before, plus whether it's a welcome for newcomers.
drop function if exists public.landmarks_near(text[]);
create function public.landmarks_near(blocks text[])
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
    and (l.user_id = auth.uid() or not landmark_buried(s.ups, s.downs))
  order by l.created_at desc
  limit 500;
end $$;

-- As before, plus whether it's a welcome for newcomers.
drop function if exists public.my_landmarks();
create function public.my_landmarks()
returns table (id bigint, cell text, kind text, title text, note text, created_at timestamptz,
  finds bigint, last_found timestamptz, ups bigint, downs bigint, buried boolean, points numeric, welcome boolean)
language sql stable security definer set search_path = public as $$
  select l.id, l.cell, l.kind, l.title, l.note, l.created_at,
    s.finds, s.last_found, s.ups, s.downs, landmark_buried(s.ups, s.downs),
    (select coalesce(sum(p.points), 0) from landmark_points p where p.landmark_id = l.id and p.user_id = l.user_id),
    l.welcome
  from landmarks l
  cross join lateral (
    select count(*) as finds, max(f.found_at) as last_found,
      count(*) filter (where f.vote = 1) as ups, count(*) filter (where f.vote = -1) as downs
    from landmark_finds f where f.landmark_id = l.id
  ) s
  where l.user_id = auth.uid()
  order by l.created_at desc
$$;

-- A neighbourhood at a glance, for anyone (signed in or not):
--   explorers  people who walked in the district in the last 60 days ("keep it warm")
--   landmarks  landmarks on hexes in the district (not hidden by votes)
--   cafes      hexes in the district with a coffee check-in
--   ordinal    which explorer of the district you are, by when each first
--              walked there; if you haven't yet (or aren't signed in), the next one
--   pins       [{cell, ups, welcome}] for landmarks in `blocks`, the ~5 km²
--              resolution-7 blocks around you, so the map can show "?" pins.
--              Never the title, note or author.
-- `district` may be null (outside any known district): then only pins come back.
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
    where not landmark_buried(s.ups, s.downs)
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

-- Your neighbourhood firsts. `home` is your home district (where your score
-- is highest), which "Make it home" ticks off.
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
    exists (select 1 from checkins k where k.user_id = me and k.kind = 'meetup' and k.met_with is not null),
    exists (select 1 from checkins k where k.user_id = me and k.kind = 'coffee'),
    exists (select 1 from landmarks l where l.user_id = me);
end $$;

-- ---------- privileges ----------

revoke execute on function public.pulse_pin_limit() from public, anon, authenticated;
revoke execute on function public.landmarks_near(text[]), public.my_landmarks(), public.my_firsts(),
  public.area_pulse(text, text[]) from public, anon;
grant execute on function public.landmarks_near(text[]), public.my_landmarks(), public.my_firsts() to authenticated;
-- The one function open to everyone: totals and pin locations only.
grant execute on function public.area_pulse(text, text[]) to anon, authenticated;
