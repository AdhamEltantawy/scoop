-- Your own hexes with their visit dates, so the app can rebuild your map after
-- a reinstall or on a new phone. The date columns of user_cells stay
-- unreadable (friends never see when you walked where); this only ever
-- returns the caller's own rows. Paged by cell: pass the last cell you got.

create or replace function public.my_cells(after_cell text default '')
returns table (cell text, first_visited timestamptz, last_visited timestamptz, visits int)
language sql stable security definer set search_path = public as $$
  select c.cell, c.first_visited, c.last_visited, c.visits
  from user_cells c
  where c.user_id = auth.uid() and c.cell > coalesce(after_cell, '')
  order by c.cell
  limit 1000
$$;

revoke execute on function public.my_cells(text) from public, anon;
grant execute on function public.my_cells(text) to authenticated;
