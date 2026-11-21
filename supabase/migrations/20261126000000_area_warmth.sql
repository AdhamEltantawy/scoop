-- The home panel's numbers for a place Scoop has no district for.
--
-- Somewhere like El Gouna, OpenStreetMap has no district, only the governorate
-- (Red Sea). The home panel now falls back to the city-level area, so
-- district_warmth() accepts a city id as well as a district id: the same
-- numbers, over every hex walked in the city. District ids and city ids are
-- OSM relation ids, so they never collide.
--
-- Same columns as before, so older apps keep working.
--
-- Safe to run again.

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
    select hex_heat(max(c.last_visited)) as heat from user_cells c where c.district = d or c.city = d group by c.cell
  )
  select
    (select count(*) from cells),
    (select round(coalesce(sum(x.heat), 0))::bigint from cells x),
    (select coalesce(round(100 * avg(x.heat))::int, 0) from cells x),
    (select round(coalesce(sum(hex_heat(c.last_visited)), 0))::bigint from user_cells c
      where c.user_id = me and (c.district = d or c.city = d)),
    (select count(*) from user_cells c where c.user_id = me and (c.district = d or c.city = d)
      and c.last_visited >= period_start('week')),
    (select count(distinct c.user_id) from user_cells c where (c.district = d or c.city = d)
      and c.last_visited >= now() - warm_days() * interval '1 day');
end $$;
