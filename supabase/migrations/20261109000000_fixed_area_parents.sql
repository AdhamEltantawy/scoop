-- Scoop's own districts get their country and city from the server only.
--
-- Until now the first upload that tagged an own district (r9…) with a country
-- and city set them for every user, for good, and lent them to the other
-- districts in the same governorate. One wrong upload, deliberate or not,
-- would move everyone's hexes and points there.
--
-- The parents are now fixed here, from OpenStreetMap: Egypt (relation
-- 1473947), Cairo Governorate (4103336) and Giza Governorate (3824206).
-- sync_cells() no longer learns them from uploads, and parse_cells() already
-- lets area_parents win over what a phone says. Hexes and points already on
-- the server are moved to the fixed parents.
--
-- Safe to run again.

-- Names of the parents, owned by the server.
insert into public.areas (id, kind, name, level) values
  ('r1473947', 'country', 'Egypt', 2),
  ('r4103336', 'city', 'Cairo', 4),
  ('r3824206', 'city', 'Giza', 4)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, level = excluded.level;

insert into public.area_parents (district, country, city, borrowed)
select r.district, 'r1473947', case r.region when 'cairo' then 'r4103336' when 'giza' then 'r3824206' end, false
from public.own_district_regions r
on conflict (district) do update set country = excluded.country, city = excluded.city, borrowed = false;

do $$ begin perform public.apply_area_parents(array(select district from public.own_district_regions)); end $$;

-- As before, without learning parents from the upload.
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
  where x ->> 'id' !~ '^r9[0-9]{11}$' -- Scoop's own districts are named by migrations only
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

drop function if exists public.learn_area_parents(jsonb);
