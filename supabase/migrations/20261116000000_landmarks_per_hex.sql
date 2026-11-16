-- More than one landmark per hex.
--
-- A hex can hold several landmarks, and you can leave up to
-- landmark_per_hex_limit() of your own on the same hex (it used to be one).
-- The overall limit of landmark_limit() landmarks out at once still applies.
--
-- Safe to run again.

alter table public.landmarks drop constraint if exists landmarks_user_id_cell_key;
-- The unique constraint used to index this; the insert trigger counts by it.
create index if not exists landmarks_user_cell on public.landmarks (user_id, cell);

-- How many landmarks one explorer can have on a single hex.
create or replace function public.landmark_per_hex_limit()
returns int language sql immutable as $$ select 3 $$;

create or replace function public.landmarks_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.title := btrim(new.title);
  new.note := nullif(btrim(new.note), '');
  if not exists (select 1 from user_cells where user_id = new.user_id and cell = new.cell) then
    raise exception 'Walk through this hex before leaving a landmark here' using errcode = 'P0001';
  end if;
  if (select count(*) from landmarks where user_id = new.user_id) >= landmark_limit() then
    raise exception 'You have % landmarks out already. Remove one to leave another', landmark_limit() using errcode = 'P0001';
  end if;
  if (select count(*) from landmarks where user_id = new.user_id and cell = new.cell) >= landmark_per_hex_limit() then
    raise exception 'You have % landmarks on this hex already', landmark_per_hex_limit() using errcode = 'P0001';
  end if;
  return new;
end $$;

revoke execute on function public.landmark_per_hex_limit() from public, anon, authenticated;
