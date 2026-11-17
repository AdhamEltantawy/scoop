-- A circle is in its meeting point's district, never its owner's home.
--
-- It used to fall back to the owner's home district when nobody had walked
-- the meeting hex yet, so a circle meeting in Maadi could be listed for
-- guests in Zamalek, and it kept that district even after the owner moved
-- the meeting point. Now the owner picks the meeting point and the district
-- comes from it:
--
-- * the district walkers have tagged that hex with, else
-- * the one the app looked up for it, else
-- * none: the circle isn't listed for guests until it has one.
--
-- Moving the meeting point moves the circle to that spot's district.
--
-- Safe to run again.

-- The district a hex is in: from walkers' tags for it (the most common one),
-- else the app's lookup (`hint`).
create or replace function public.cell_district(cell text, hint text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select c.district from user_cells c
      where c.cell8 = h3_to_parent(cell_district.cell, 8) and c.cell = cell_district.cell and c.district is not null
      group by c.district order by count(*) desc, c.district limit 1),
    case when btrim(hint) ~ '^r[0-9]{1,12}$' then btrim(hint) end)
$$;

drop function if exists public.create_circle(text, int, text, text, text, text, numeric, boolean);
drop function if exists public.update_circle(bigint, text, int, text, text, text, text, numeric, boolean);

-- Start a circle with its first walk booked. Returns the circle id.
-- district: the app's lookup of the meeting point's district.
create or replace function public.create_circle(name text, weekday int, at_time text, tz text, meet_cell text,
  meet_label text default null, goal_km numeric default 30, guests boolean default false, district text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cid bigint;
begin
  if me is null then raise exception 'Not signed in'; end if;
  perform check_circle_fields(name, weekday, at_time, tz, meet_cell, meet_label, goal_km);
  if (select count(*) from circle_members m where m.user_id = me) >= circles_per_user() then
    raise exception 'You''re in % circles already. Leave one to start another', circles_per_user() using errcode = 'P0001';
  end if;
  insert into circles (name, district, meet_cell, meet_label, weekday, at_time, tz, goal_km, guests)
  values (btrim(create_circle.name), cell_district(create_circle.meet_cell, create_circle.district),
    create_circle.meet_cell, nullif(btrim(create_circle.meet_label), ''), create_circle.weekday,
    create_circle.at_time, create_circle.tz, create_circle.goal_km, coalesce(create_circle.guests, false))
  returning id into cid;
  insert into circle_members (circle_id, user_id, role) values (cid, me, 'owner');
  insert into circle_sessions (circle_id, starts_at)
    values (cid, next_occurrence(create_circle.weekday, create_circle.at_time, create_circle.tz, now()));
  return cid;
end $$;

-- Change a circle (owner only). A new day or time moves the next walk,
-- unless someone already checked in to it. The district follows the meeting
-- point; if it can't be told, a circle that stayed put keeps the one it had.
create or replace function public.update_circle(circle bigint, name text, weekday int, at_time text, tz text,
  meet_cell text, meet_label text, goal_km numeric, guests boolean, district text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  c circles := my_circle(circle);
begin
  if not is_circle_owner(circle, auth.uid()) then raise exception 'Only the circle''s owner can change it' using errcode = 'P0001'; end if;
  perform check_circle_fields(name, weekday, at_time, tz, meet_cell, meet_label, goal_km);
  update circles x set name = btrim(update_circle.name), weekday = update_circle.weekday, at_time = update_circle.at_time,
    tz = update_circle.tz, meet_cell = update_circle.meet_cell, meet_label = nullif(btrim(update_circle.meet_label), ''),
    goal_km = update_circle.goal_km, guests = coalesce(update_circle.guests, false),
    district = coalesce(cell_district(update_circle.meet_cell, update_circle.district),
      case when x.meet_cell = update_circle.meet_cell then x.district end)
  where x.id = circle;
  if (c.weekday, c.at_time, c.tz) is distinct from (update_circle.weekday, update_circle.at_time, update_circle.tz) then
    delete from circle_sessions s where s.circle_id = circle and s.starts_at > now()
      and not exists (select 1 from session_people p where p.session_id = s.id and p.checked_in_at is not null);
    insert into circle_sessions (circle_id, starts_at)
      values (circle, next_occurrence(update_circle.weekday, update_circle.at_time, update_circle.tz, now()))
      on conflict do nothing;
  end if;
end $$;

-- Circles whose meeting hex has been walked move to its district. (Ones that
-- borrowed their owner's home on an unwalked hex are fixed the next time
-- their owner saves them.)
update public.circles c set district = d.district
from (select x.id, public.cell_district(x.meet_cell, null) as district from public.circles x) d
where d.id = c.id and d.district is not null and c.district is distinct from d.district;

-- ---------- privileges ----------

revoke execute on function public.cell_district(text, text) from public, anon, authenticated;
revoke execute on function
  public.create_circle(text, int, text, text, text, text, numeric, boolean, text),
  public.update_circle(bigint, text, int, text, text, text, text, numeric, boolean, text)
  from public, anon;
grant execute on function
  public.create_circle(text, int, text, text, text, text, numeric, boolean, text),
  public.update_circle(bigint, text, int, text, text, text, text, numeric, boolean, text)
  to authenticated;
