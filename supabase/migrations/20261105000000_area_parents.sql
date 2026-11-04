-- Hexes in Scoop's own districts no longer wait for OpenStreetMap.
--
-- A new hex used to upload only once the phone had asked OSM (Overpass) for
-- its country and city. When that lookup kept failing, the hexes were held
-- back for 3 days: walks showed up on the server, hexes and points didn't.
--
-- In one of Scoop's own districts (r9…) the phone already knows the district,
-- so it now uploads right away and the server fills in the country and city
-- from area_parents. Those are learned from uploads that came with OSM's
-- answer: from the district itself, or until then from another of Scoop's
-- districts in the same governorate (so one tagged hex anywhere in Cairo
-- covers Rehab too). A district's own answer replaces a borrowed one. Each own
-- district has one country and city: hexes and points that arrived with
-- none, or with a different one, are moved there.
--
-- Safe to run again.

-- Which governorate each of Scoop's own districts is in.
create table if not exists public.own_district_regions (
  district text primary key check (district ~ '^r9[0-9]{11}$'),
  region text not null
);
insert into public.own_district_regions (district, region) values
  ('r900000000001', 'cairo'), ('r900000000002', 'cairo'), ('r900000000003', 'cairo'), ('r900000000004', 'cairo'),
  ('r900000000005', 'cairo'), ('r900000000006', 'cairo'), ('r900000000007', 'cairo'), ('r900000000008', 'cairo'),
  ('r900000000009', 'cairo'), ('r900000000010', 'cairo'), ('r900000000011', 'cairo'), ('r900000000012', 'cairo'),
  ('r900000000013', 'cairo'), ('r900000000014', 'cairo'), ('r900000000015', 'cairo'), ('r900000000016', 'cairo'),
  ('r900000000017', 'giza'), ('r900000000018', 'giza'), ('r900000000019', 'giza'), ('r900000000020', 'giza'),
  ('r900000000021', 'giza'), ('r900000000022', 'giza')
on conflict (district) do update set region = excluded.region;

create table if not exists public.area_parents (
  district text primary key check (district ~ '^r9[0-9]{11}$'),
  country text not null check (country ~ '^r[0-9]{1,12}$'),
  city text not null check (city ~ '^r[0-9]{1,12}$')
);
-- borrowed: learned from another district in the same region, not this one.
alter table public.area_parents add column if not exists borrowed boolean not null default false;

alter table public.own_district_regions enable row level security;
alter table public.area_parents enable row level security;
-- No policies: only the functions below read or write them.
revoke all on public.own_district_regions, public.area_parents from public, anon, authenticated;

-- Record what OSM said an own district is in. rows: [{district, country, city}].
-- Returns the districts whose parents were added or changed.
create or replace function public.learn_area_parents(rows jsonb)
returns text[] language plpgsql security definer set search_path = public as $$
declare
  changed text[];
begin
  with given as (
    select distinct on (x ->> 'district') x ->> 'district' as district, x ->> 'country' as country, x ->> 'city' as city
    from jsonb_array_elements(rows) as x
    where x ->> 'district' ~ '^r9[0-9]{11}$' and x ->> 'country' ~ '^r[0-9]{1,12}$' and x ->> 'city' ~ '^r[0-9]{1,12}$'
    order by x ->> 'district'
  ), own as (
    insert into area_parents as p (district, country, city, borrowed)
    select district, country, city, false from given
    on conflict (district) do update set country = excluded.country, city = excluded.city, borrowed = false
      where p.borrowed
    returning district
  ), lent as (
    insert into area_parents (district, country, city, borrowed)
    select distinct on (o.district) o.district, g.country, g.city, true
    from given g
    join own_district_regions r on r.district = g.district
    join own_district_regions o on o.region = r.region and o.district <> g.district
    where not exists (select 1 from given g2 where g2.district = o.district)
    order by o.district
    on conflict (district) do nothing
    returning district
  )
  select array_agg(district) into changed from (select district from own union select district from lent) t;
  return changed;
end $$;

-- Give own districts' hexes their country and city, and move points logged
-- under anything else there.
create or replace function public.apply_area_parents(districts text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  update user_cells c set country = p.country, city = p.city
  from area_parents p
  where p.district = any (districts) and c.district = p.district
    and (c.country is distinct from p.country or c.city is distinct from p.city);

  with moved as (
    delete from score_events e using area_parents p
    where p.district = any (districts) and e.district = p.district and (e.country <> p.country or e.city <> p.city)
    returning e.user_id, e.day, p.country, p.city, e.district, e.points
  )
  insert into score_events as s (user_id, day, country, city, district, points)
  select user_id, day, country, city, district, sum(points) from moved group by 1, 2, 3, 4, 5
  on conflict (user_id, day, country, city, district) do update set points = s.points + excluded.points;
end $$;

-- Cells as sync_cells() takes them. In own districts with known parents,
-- the server's country and city win.
create or replace function public.parse_cells(cells jsonb)
returns table (cell text, fv timestamptz, lv timestamptz, v int, country text, city text, district text)
language sql stable set search_path = public as $$
  select x.cell, x.fv, x.lv, x.v, coalesce(p.country, x.country), coalesce(p.city, x.city), x.district
  from (
    select distinct on (x ->> 'c')
      x ->> 'c' as cell,
      to_timestamp((x ->> 't')::double precision / 1000) as fv,
      greatest(to_timestamp((x ->> 't')::double precision / 1000),
               to_timestamp(coalesce(x ->> 'l', x ->> 't')::double precision / 1000)) as lv,
      greatest(1, coalesce((x ->> 'v')::int, 1)) as v,
      nullif(x -> 'a' ->> 0, '') as country, nullif(x -> 'a' ->> 1, '') as city, nullif(x -> 'a' ->> 2, '') as district
    from jsonb_array_elements(cells) as x
    order by x ->> 'c'
  ) x
  left join area_parents p on p.district = x.district
$$;

-- Same as before, plus: first learn where own districts are from what the
-- phone's OSM lookups said.
create or replace function public.sync_cells(cells jsonb, areas jsonb default '[]'::jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  n int;
  changed text[];
begin
  if me is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(cells) > 1000 then raise exception 'At most 1000 cells per call'; end if;
  if jsonb_array_length(areas) > 200 then raise exception 'At most 200 areas per call'; end if;

  insert into public.areas (id, kind, name, level)
  select x ->> 'id', x ->> 'kind', left(x ->> 'name', 120), (x ->> 'level')::int
  from jsonb_array_elements(areas) as x
  where x ->> 'id' !~ '^r9[0-9]{11}$' -- Scoop's own districts are named by migrations only
  on conflict (id) do nothing;

  changed := learn_area_parents(coalesce((
    select jsonb_agg(jsonb_build_object('district', x -> 'a' ->> 2, 'country', x -> 'a' ->> 0, 'city', x -> 'a' ->> 1))
    from jsonb_array_elements(cells) as x
    where x -> 'a' ->> 2 ~ '^r9[0-9]{11}$' and coalesce(x -> 'a' ->> 0, '') <> '' and coalesce(x -> 'a' ->> 1, '') <> ''
  ), '[]'::jsonb));
  if changed is not null then perform apply_area_parents(changed); end if;

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

-- Learn from what's already on the server (the most common answer per
-- district, only the first time), lend what's known to the other districts
-- in the same governorate, and re-tag what arrived without it.
do $$
begin
  if not exists (select 1 from public.area_parents) then
    perform public.learn_area_parents(coalesce((
      select jsonb_agg(jsonb_build_object('district', district, 'country', country, 'city', city))
      from (
        select district, mode() within group (order by country) as country, mode() within group (order by city) as city
        from public.user_cells
        where district ~ '^r9[0-9]{11}$' and country is not null and city is not null
        group by district
      ) t
    ), '[]'::jsonb));
  end if;
  perform public.learn_area_parents(coalesce((
    select jsonb_agg(jsonb_build_object('district', district, 'country', country, 'city', city))
    from public.area_parents where not borrowed
  ), '[]'::jsonb));
  perform public.apply_area_parents(array(select district from public.area_parents));
end $$;

revoke execute on function public.learn_area_parents(jsonb), public.apply_area_parents(text[]), public.parse_cells(jsonb)
  from public, anon, authenticated;
