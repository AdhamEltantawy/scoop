-- Hexes in Scoop's own districts no longer wait for OpenStreetMap.
--
-- A new hex used to upload only once the phone had asked OSM (Overpass) for
-- its country and city. When that lookup kept failing, the hexes were held
-- back for 3 days: walks showed up on the server, hexes and points didn't.
--
-- In one of Scoop's own districts (r9…) the phone already knows the district,
-- so it now uploads right away and the server fills in the country and city
-- from area_parents: what earlier fully tagged uploads said that district is
-- in. Hexes and points that arrived before a district's parents were known
-- are re-tagged once they are.
--
-- Safe to run again.

create table if not exists public.area_parents (
  district text primary key check (district ~ '^r9[0-9]{11}$'),
  country text not null check (country ~ '^r[0-9]{1,12}$'),
  city text not null check (city ~ '^r[0-9]{1,12}$')
);
alter table public.area_parents enable row level security;
-- No policies: only the functions below read or write it.
revoke all on public.area_parents from public, anon, authenticated;

-- Fill in the country and city of own-district hexes, and move points logged
-- without them into the right areas.
create or replace function public.apply_area_parents(districts text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  update user_cells c set country = coalesce(c.country, p.country), city = coalesce(c.city, p.city)
  from area_parents p
  where p.district = any (districts) and c.district = p.district and (c.country is null or c.city is null);

  with moved as (
    delete from score_events e using area_parents p
    where p.district = any (districts) and e.district = p.district and (e.country = '' or e.city = '')
    returning e.user_id, e.day, coalesce(nullif(e.country, ''), p.country) as country,
      coalesce(nullif(e.city, ''), p.city) as city, e.district, e.points
  )
  insert into score_events as s (user_id, day, country, city, district, points)
  select user_id, day, country, city, district, sum(points) from moved group by 1, 2, 3, 4, 5
  on conflict (user_id, day, country, city, district) do update set points = s.points + excluded.points;
end $$;

-- Cells as sync_cells() takes them, with own districts' country and city
-- filled in when the phone didn't know them.
create or replace function public.parse_cells(cells jsonb)
returns table (cell text, fv timestamptz, lv timestamptz, v int, country text, city text, district text)
language sql stable set search_path = public as $$
  select x.cell, x.fv, x.lv, x.v, coalesce(x.country, p.country), coalesce(x.city, p.city), x.district
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

-- Same as before, plus: learn which country and city each own district is in
-- from fully tagged uploads, first.
create or replace function public.sync_cells(cells jsonb, areas jsonb default '[]'::jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  n int;
  learned text[];
begin
  if me is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(cells) > 1000 then raise exception 'At most 1000 cells per call'; end if;
  if jsonb_array_length(areas) > 200 then raise exception 'At most 200 areas per call'; end if;

  insert into public.areas (id, kind, name, level)
  select x ->> 'id', x ->> 'kind', left(x ->> 'name', 120), (x ->> 'level')::int
  from jsonb_array_elements(areas) as x
  where x ->> 'id' !~ '^r9[0-9]{11}$' -- Scoop's own districts are named by migrations only
  on conflict (id) do nothing;

  with added as (
    insert into area_parents (district, country, city)
    select distinct on (i.district) i.district, i.country, i.city
    from parse_cells(cells) i
    where i.district ~ '^r9[0-9]{11}$' and i.country is not null and i.city is not null
    order by i.district
    on conflict (district) do nothing
    returning district
  )
  select array_agg(district) into learned from added;
  if learned is not null then perform apply_area_parents(learned); end if;

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
-- district), and re-tag what arrived without it.
insert into public.area_parents (district, country, city)
select district, mode() within group (order by country), mode() within group (order by city)
from public.user_cells
where district ~ '^r9[0-9]{11}$' and country is not null and city is not null
group by district
on conflict (district) do nothing;
do $$ begin perform public.apply_area_parents(array(select district from public.area_parents)); end $$;

revoke execute on function public.apply_area_parents(text[]), public.parse_cells(jsonb) from public, anon, authenticated;
