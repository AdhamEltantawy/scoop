-- "My district" goes away. The home panel shows the district you're in, and the
-- things that need a district that stays put for the week (your ranks, the
-- weekly district matchup, "become a local") follow the one you score most in.
--
-- * home_area() no longer looks at profiles.home_district: it is always the
--   area you score most in (heat-weighted, so it moves slowly). The column,
--   set_home_district() and home_choices() stay so older apps keep working.
-- * my_firsts() returns that district as `home` once you've walked, so an older
--   app's "make it home" step shows as done. The new app has no such step.
--
-- Safe to run again.

-- The area you score most in, or the city or country it's in.
create or replace function public.home_area(uid uuid, kind text)
returns text language sql stable security definer set search_path = public as $$
  select warmest_area(uid, kind)
$$;

-- Your neighbourhood firsts. `home` is the district you score most in.
create or replace function public.my_firsts()
returns table (walked boolean, home text, home_name text, found boolean, met boolean, coffee boolean, left_one boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  hd text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  hd := warmest_area(me, 'district');
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
