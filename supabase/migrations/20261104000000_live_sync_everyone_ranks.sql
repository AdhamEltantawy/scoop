-- 1. Keep every device's map up to date, not just after a reinstall.
--    Each hex remembers when the server last saw it change (synced_at), so a
--    device can fetch only what your other devices uploaded since it last
--    looked. Like the visit dates, synced_at is only readable through
--    my_cells(), never by friends.
-- 2. An "Everyone" leaderboard: everybody with points, wherever they walk.
--    As on the area boards, only you and your friends are named.

-- ---------- 1. changes since you last looked ----------

alter table public.user_cells add column synced_at timestamptz not null default now();
create index user_cells_synced on public.user_cells (user_id, synced_at);

-- Only real changes count: sync_cells() re-uploading the same values (or only
-- adding area tags) leaves synced_at alone.
create or replace function public.touch_user_cell()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT'
    or new.first_visited is distinct from old.first_visited
    or new.last_visited is distinct from old.last_visited
    or new.visits is distinct from old.visits then
    new.synced_at := now();
  else
    new.synced_at := old.synced_at;
  end if;
  return new;
end $$;

create trigger user_cells_touch before insert or update on public.user_cells
  for each row execute function public.touch_user_cell();

-- Your own hexes with their visit dates, optionally only those changed after
-- `since`. Paged by cell: pass the last cell you got as after_cell.
drop function public.my_cells(text);
create function public.my_cells(after_cell text default '', since timestamptz default null)
returns table (cell text, first_visited timestamptz, last_visited timestamptz, visits int, synced_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.cell, c.first_visited, c.last_visited, c.visits, c.synced_at
  from user_cells c
  where c.user_id = auth.uid() and c.cell > coalesce(after_cell, '')
    and (since is null or c.synced_at > since)
  order by c.cell
  limit 1000
$$;

revoke execute on function public.my_cells(text, timestamptz) from public, anon;
grant execute on function public.my_cells(text, timestamptz) to authenticated;

-- ---------- 2. everyone ----------

-- Everyone with points: by current score (t0 null) or by points earned from t0 to t1.
create or replace function public.everyone_ranking(t0 timestamptz, t1 timestamptz)
returns table (user_id uuid, value numeric, rank bigint, total bigint)
language sql stable security definer set search_path = public as $$
  with people as (
    select distinct c.user_id from user_cells c where t0 is null
    union
    select e.user_id from score_events e
      where t0 is not null
        and e.day >= (t0 at time zone 'utc')::date and (t1 is null or e.day <= (t1 at time zone 'utc')::date)
    union
    select k.user_id from checkins k
      where t0 is not null and k.created_at >= t0 and (t1 is null or k.created_at < t1)
  ), scored as (
    select p.user_id,
      round(case when t0 is null then score_now(p.user_id, null) else score_gained(p.user_id, t0, t1, null) end, 2) as v
    from people p
  )
  select s.user_id, s.v, rank() over (order by s.v desc), count(*) over ()
  from scored s
$$;

-- One area's ranking, or everyone's when area is null.
create or replace function public.ranking(area text, t0 timestamptz, t1 timestamptz)
returns table (user_id uuid, value numeric, rank bigint, total bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if area is null then
    return query select * from everyone_ranking(t0, t1);
  else
    return query select * from area_ranking(area, t0, t1);
  end if;
end $$;

-- Everyone in a district, city or country, or everywhere (area null). Only
-- you and your friends are named; everyone else is an anonymous row. Top 50,
-- plus your own row.
create or replace function public.area_leaderboard(area text, period text default 'now')
returns table (rank bigint, value numeric, total bigint, is_me boolean, is_friend boolean,
  user_id uuid, username text, display_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if period not in ('now', 'week', 'month') then raise exception 'Bad leaderboard period'; end if;
  return query
    select r.rank, r.value, r.total, r.user_id = me, f.yes,
      case when r.user_id = me or f.yes then r.user_id end,
      case when r.user_id = me or f.yes then p.username end,
      case when r.user_id = me or f.yes then p.display_name end
    from ranking(area, period_start(period), null) r
    join profiles p on p.id = r.user_id
    cross join lateral (select are_friends(me, r.user_id) as yes) f
    where r.rank <= 50 or r.user_id = me
    order by r.rank, (r.user_id = me) desc;
end $$;

revoke execute on function public.everyone_ranking(timestamptz, timestamptz),
  public.ranking(text, timestamptz, timestamptz)
  from public, anon, authenticated;
