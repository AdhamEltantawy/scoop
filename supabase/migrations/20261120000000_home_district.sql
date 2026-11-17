-- Your home district is the one you choose.
--
-- It used to be worked out every time it was asked for: the district where
-- your hexes were warmest right now. A busy weekend somewhere else, a
-- holiday, or living on a border could switch it without a word, and with it
-- "Become a Zamalek local", the home panel and its weekly matchup, your
-- district rank and what friends see. Now:
--
-- * Until you choose, it's still the warmest district (warmest_area), and
--   that's what the app suggests.
-- * "Make Zamalek home", one of the neighbourhood firsts, saves your choice.
--   Only a district you've walked can be home.
-- * It never changes by itself. home_choices() lists the districts you could
--   choose, and flags one that has been warmer for you than home in each of
--   the last 3 weeks, for the app to ask about once.
-- * Your home city and country are the ones your home district is in.
--
-- Safe to run again.

alter table public.profiles
  add column if not exists home_district text check (home_district ~ '^r[0-9]{1,12}$'),
  add column if not exists home_set_at timestamptz;
-- Not in the update grant: it's set through set_home_district() only.

-- Where you score most right now: your home until you choose one.
create or replace function public.warmest_area(uid uuid, kind text)
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

-- Your home district (the one you chose, else the warmest), or the city or
-- country it's in: whichever your hexes there say most often.
create or replace function public.home_area(uid uuid, kind text)
returns text language sql stable security definer set search_path = public as $$
  select case
    when p.d is null then warmest_area(uid, kind)
    when kind = 'district' then p.d
    else coalesce((
      select x.a from (
        select case kind when 'city' then c.city else c.country end as a
        from user_cells c where c.user_id = uid and c.district = p.d
      ) x
      where x.a is not null
      group by x.a
      order by count(*) desc, x.a
      limit 1
    ), warmest_area(uid, kind))
  end
  from (select (select pr.home_district from profiles pr where pr.id = uid) as d) p
$$;

-- Make a district you've walked your home.
create or replace function public.set_home_district(district text)
returns table (id text, name text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  d text := btrim(set_home_district.district);
begin
  if me is null then raise exception 'Not signed in'; end if;
  if d is null or not exists (select 1 from user_cells c where c.user_id = me and c.district = d) then
    raise exception 'Only a district you''ve walked can be home' using errcode = 'P0001';
  end if;
  update profiles p set
    home_district = d,
    home_set_at = case when p.home_district is distinct from d then now() else p.home_set_at end
  where p.id = me;
  return query select d, a.name from (select 1) x left join areas a on a.id = d;
end $$;

-- Districts you could make home: the ones you've walked, warmest first (the
-- top 5, plus your home wherever it is). hexes: how many of yours are there.
-- home: the one you chose. switch: a district that has been warmer for you
-- than home in each of the last 3 weeks (once you've had that home for 3
-- weeks), so one busy weekend or a week away doesn't count.
create or replace function public.home_choices()
returns table (id text, name text, hexes bigint, home boolean, switch boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  chosen text;
  since timestamptz;
  sw text;
  today date := (now() at time zone 'utc')::date;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select p.home_district, p.home_set_at into chosen, since from profiles p where p.id = me;
  if chosen is not null and since <= now() - interval '21 days' then
    with weekly as (
      select e.district as d, (today - e.day) / 7 as wk, sum(e.points) as pts
      from score_events e
      where e.user_id = me and e.day > today - 21 and e.district <> ''
      group by 1, 2
    )
    select w.d into sw
    from weekly w
    left join weekly h on h.d = chosen and h.wk = w.wk
    where w.d <> chosen and w.pts > coalesce(h.pts, 0)
    group by w.d
    having count(*) = 3
    order by sum(w.pts) desc, w.d
    limit 1;
  end if;
  return query
    with mine as (
      select c.district as d, count(*) as n, sum(hex_value(c.visits) * heat(c.last_visited, now())) as s
      from user_cells c
      where c.user_id = me and c.district is not null
      group by c.district
    ), ranked as (
      select m.d, m.n, row_number() over (order by m.s desc, m.d) as rn from mine m
    )
    select r.d, a.name, r.n, r.d = coalesce(chosen, ''), r.d = coalesce(sw, '')
    from ranked r
    left join areas a on a.id = r.d
    where r.rn <= 5 or r.d = chosen or r.d = sw
    order by r.rn;
end $$;

-- Your neighbourhood firsts. "Make it home" is done once you've chosen a home
-- district. (Walking with someone still counts circle walks.)
create or replace function public.my_firsts()
returns table (walked boolean, home text, home_name text, found boolean, met boolean, coffee boolean, left_one boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  hd text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select p.home_district into hd from profiles p where p.id = me;
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

-- ---------- privileges ----------

revoke execute on function public.warmest_area(uuid, text) from public, anon, authenticated;
revoke execute on function public.home_choices(), public.set_home_district(text) from public, anon;
grant execute on function public.home_choices(), public.set_home_district(text) to authenticated;
