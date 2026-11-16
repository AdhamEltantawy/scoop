-- Leave a landmark on the hex you're standing in, walked or not.
--
-- It used to need the hex in your explored map (a walk through it). Now the
-- app only checks you're inside the hex (a precise GPS fix), as it already
-- does for finding one.
--
-- Landmark points count in the district, city and country of their hex. Those
-- came from the author's own explored hex; now they come from any explorer's
-- tags for that hex, so a landmark on a hex its author never walked still
-- counts in its areas (once anyone has walked it).
--
-- Safe to run again.

create or replace function public.landmarks_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.title := btrim(new.title);
  new.note := nullif(btrim(new.note), '');
  if (select count(*) from landmarks where user_id = new.user_id) >= landmark_limit() then
    raise exception 'You have % landmarks out already. Remove one to leave another', landmark_limit() using errcode = 'P0001';
  end if;
  if (select count(*) from landmarks where user_id = new.user_id and cell = new.cell) >= landmark_per_hex_limit() then
    raise exception 'You have % landmarks on this hex already', landmark_per_hex_limit() using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ~0.7 km² block, to look the hex up in user_cells by its cell8 index.
alter table public.landmark_points
  add column if not exists cell8 text generated always as (public.h3_to_parent(cell, 8)) stored;

create or replace function public.landmark_points_in(p public.landmark_points, area text)
returns boolean language sql stable security definer set search_path = public as $$
  select area is null or exists (
    select 1 from user_cells c where c.cell8 = p.cell8 and c.cell = p.cell and area in (c.country, c.city, c.district))
$$;

create or replace function public.area_ranking(area text, t0 timestamptz, t1 timestamptz)
returns table (user_id uuid, value numeric, rank bigint, total bigint)
language sql stable security definer set search_path = public as $$
  with people as (
    select c.user_id from user_cells c
      where t0 is null and area in (c.country, c.city, c.district)
    union
    select e.user_id from score_events e
      where t0 is not null and area in (e.country, e.city, e.district)
        and e.day >= (t0 at time zone 'utc')::date and (t1 is null or e.day <= (t1 at time zone 'utc')::date)
    union
    select k.user_id from checkins k join user_cells c on c.user_id = k.user_id and c.cell = k.cell
      where t0 is not null and area in (c.country, c.city, c.district)
        and k.created_at >= t0 and (t1 is null or k.created_at < t1)
    union
    select p.user_id from landmark_points p join user_cells c on c.cell8 = p.cell8 and c.cell = p.cell
      where area in (c.country, c.city, c.district)
        and (t0 is null or (p.created_at >= t0 and (t1 is null or p.created_at < t1)))
  ), scored as (
    select p.user_id,
      round(case when t0 is null then score_now(p.user_id, area) else score_gained(p.user_id, t0, t1, area) end, 2) as v
    from people p
  )
  select s.user_id, s.v, rank() over (order by s.v desc), count(*) over ()
  from scored s
$$;
