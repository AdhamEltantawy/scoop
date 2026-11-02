-- Scoop's own districts (districts.geojson) for cities where OpenStreetMap has
-- no admin boundaries below the city, starting with Greater Cairo and Giza.
--
-- Their ids are r9 + 11 digits, a range OSM relations won't reach. The server
-- owns their names: they're set here, and sync_cells ignores names that phones
-- send for these ids, so nobody can rename a district by syncing.
--
-- To add or rename one: edit districts.geojson, then add a migration that
-- upserts the same id and name (tests/social-core.test.mjs checks they match).

insert into public.areas (id, kind, name, level) values
  ('r900000000001', 'district', 'Zamalek', 10),
  ('r900000000002', 'district', 'Downtown', 10),
  ('r900000000003', 'district', 'Garden City', 10),
  ('r900000000004', 'district', 'Manial', 10),
  ('r900000000005', 'district', 'Old Cairo', 10),
  ('r900000000006', 'district', 'Maadi', 10),
  ('r900000000007', 'district', 'Degla', 10),
  ('r900000000008', 'district', 'Zahraa al-Maadi', 10),
  ('r900000000009', 'district', 'New Maadi', 10),
  ('r900000000010', 'district', 'Heliopolis', 10),
  ('r900000000011', 'district', 'Nasr City', 10),
  ('r900000000012', 'district', 'New Cairo', 10),
  ('r900000000013', 'district', 'Rehab', 10),
  ('r900000000014', 'district', 'Mokattam', 10),
  ('r900000000015', 'district', 'Shubra', 10),
  ('r900000000016', 'district', 'Abbasiya', 10),
  ('r900000000017', 'district', 'Dokki', 10),
  ('r900000000018', 'district', 'Mohandessin', 10),
  ('r900000000019', 'district', 'Agouza', 10),
  ('r900000000020', 'district', 'Giza / Haram', 10),
  ('r900000000021', 'district', 'Sheikh Zayed', 10),
  ('r900000000022', 'district', '6th of October', 10)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, level = excluded.level;

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
