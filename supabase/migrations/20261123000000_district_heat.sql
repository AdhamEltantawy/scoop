-- District warmth is the average heat of a district's walked hexes, the same
-- heat the map shows: 1 right after a walk, halving every 30 days.
--
-- It used to count a hex as fully warm for 60 days and then drop it to cold,
-- so a district walked three to eight weeks ago read 100% while the map showed
-- its hexes pale. Now the number starts sliding the day after a walk, and
-- walking a hex again (or a new one) puts it straight back to full heat.
--
-- An 80% average needs the average hex walked in the last ~10 days, so the
-- weekly goal is now 50%: the average hex walked within about a month.
--
-- district_warmth() keeps its columns, so older apps still work:
--   hexes      hexes anyone ever walked there
--   warm       their total heat, in hexes (12 hexes at half heat = 6)
--   pct        warm / hexes, as a whole percentage: the district's warmth
--   mine_warm  the heat you keep there yourself, in hexes
--   mine_week  hexes you walked there this week
--   explorers  people who walked there in the last 60 days
--
-- The matchup and 'warmth' challenges follow, since they use district_pct().
-- The 'cells' challenge still counts a hex as warm for 60 days.
--
-- Safe to run again.

create or replace function public.half_life_days() returns int language sql immutable as $$ select 30 $$;
create or replace function public.warmth_goal() returns int language sql immutable as $$ select 50 $$;

-- How warm a hex last walked at `at` is now, from 0 to 1.
-- Keep in sync with heat() in social-core.js.
create or replace function public.hex_heat(at timestamptz)
returns float8 language sql stable set search_path = public as $$
  select case when at is null then 0
    else power(0.5, greatest(0, extract(epoch from now() - at)) / (half_life_days() * 86400.0)) end
$$;

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
    select hex_heat(max(c.last_visited)) as heat from user_cells c where c.district = d group by c.cell
  )
  select
    (select count(*) from cells),
    (select round(coalesce(sum(x.heat), 0))::bigint from cells x),
    (select coalesce(round(100 * avg(x.heat))::int, 0) from cells x),
    (select round(coalesce(sum(hex_heat(c.last_visited)), 0))::bigint from user_cells c
      where c.user_id = me and c.district = d),
    (select count(*) from user_cells c where c.user_id = me and c.district = d and c.last_visited >= period_start('week')),
    (select count(distinct c.user_id) from user_cells c where c.district = d
      and c.last_visited >= now() - warm_days() * interval '1 day');
end $$;

-- Just the percentage, for comparing districts.
create or replace function public.district_pct(district text)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(round(100 * avg(hex_heat(x.last)))::int, 0)
  from (select max(c.last_visited) as last from user_cells c where c.district = district_pct.district group by c.cell) x
$$;

revoke execute on function public.half_life_days(), public.warmth_goal(), public.hex_heat(timestamptz)
  from public, anon, authenticated;
