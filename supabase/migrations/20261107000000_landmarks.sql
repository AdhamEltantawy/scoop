-- Landmarks: notes explorers leave on a hex for others to find.
--
-- You can leave a landmark on a hex you've walked (a viewpoint, a bit of
-- history, street art…): a kind, a title and an optional note. When anyone
-- else signed in passes through that hex, their app tells them, and they can
-- check it off. The author sees how many explorers have found it.
--
-- Landmarks are visible to every signed-in explorer, but only you and your
-- friends see who left one; to everyone else it's from an anonymous explorer
-- (as on the leaderboards). The tables aren't readable directly: the functions
-- below decide what crosses users.
--
-- Safe to run again.

create table if not exists public.landmarks (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  cell text not null check (cell ~ '^8a[0-9a-f]{13}$'),
  -- ~5 km² block, so the app can fetch the landmarks around you.
  cell7 text generated always as (public.h3_to_parent(cell, 7)) stored,
  kind text not null check (kind in ('view', 'history', 'art', 'nature', 'food', 'gem')),
  title text not null check (char_length(btrim(title)) between 1 and 60),
  note text check (char_length(note) <= 280),
  created_at timestamptz not null default now(),
  -- One landmark of yours per hex.
  unique (user_id, cell)
);
create index if not exists landmarks_cell7 on public.landmarks (cell7);

create table if not exists public.landmark_finds (
  landmark_id bigint not null references public.landmarks (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  found_at timestamptz not null default now(),
  primary key (landmark_id, user_id)
);
create index if not exists landmark_finds_user on public.landmark_finds (user_id);

-- How many landmarks one explorer can have out at once.
create or replace function public.landmark_limit()
returns int language sql immutable as $$ select 25 $$;

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
  return new;
end $$;
drop trigger if exists landmarks_validate on public.landmarks;
create trigger landmarks_validate before insert on public.landmarks
  for each row execute function public.landmarks_before_insert();

-- ---------- client API ----------

-- Landmarks in the given resolution-7 blocks (the one you're in and the ring
-- around it). Authors are named only for you and your friends.
create or replace function public.landmarks_near(blocks text[])
returns table (id bigint, cell text, kind text, title text, note text, created_at timestamptz,
  author text, mine boolean, finds bigint, found_by_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if cardinality(blocks) > 50 then raise exception 'Too many blocks' using errcode = 'P0001'; end if;
  return query
  select l.id, l.cell, l.kind, l.title, l.note, l.created_at,
    case when l.user_id = auth.uid() or are_friends(auth.uid(), l.user_id)
      then coalesce(p.display_name, p.username) end,
    l.user_id = auth.uid(),
    (select count(*) from landmark_finds f where f.landmark_id = l.id),
    exists (select 1 from landmark_finds f where f.landmark_id = l.id and f.user_id = auth.uid())
  from landmarks l
  join profiles p on p.id = l.user_id
  where l.cell7 = any(blocks)
  order by l.created_at desc
  limit 500;
end $$;

-- Check off someone else's landmark. Returns how many explorers have found it
-- (you included), and whether this was your first time.
create or replace function public.find_landmark(landmark bigint)
returns table (finds bigint, first_time boolean)
language plpgsql security definer set search_path = public as $$
declare
  author uuid;
  added int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select l.user_id into author from landmarks l where l.id = landmark;
  if not found then raise exception 'That landmark is gone' using errcode = 'P0001'; end if;
  if author = auth.uid() then raise exception 'This one is yours' using errcode = 'P0001'; end if;
  insert into landmark_finds (landmark_id, user_id) values (landmark, auth.uid()) on conflict do nothing;
  get diagnostics added = row_count;
  return query select (select count(*) from landmark_finds f where f.landmark_id = landmark), added > 0;
end $$;

-- Your own landmarks, with how often and when they were last found.
create or replace function public.my_landmarks()
returns table (id bigint, cell text, kind text, title text, note text, created_at timestamptz,
  finds bigint, last_found timestamptz)
language sql stable security definer set search_path = public as $$
  select l.id, l.cell, l.kind, l.title, l.note, l.created_at,
    count(f.user_id), max(f.found_at)
  from landmarks l
  left join landmark_finds f on f.landmark_id = l.id
  where l.user_id = auth.uid()
  group by l.id
  order by l.created_at desc
$$;

-- ---------- row level security and privileges ----------

alter table public.landmarks enable row level security;
alter table public.landmark_finds enable row level security;

drop policy if exists "landmarks: read own" on public.landmarks;
create policy "landmarks: read own" on public.landmarks for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "landmarks: add own" on public.landmarks;
create policy "landmarks: add own" on public.landmarks for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "landmarks: delete own" on public.landmarks;
create policy "landmarks: delete own" on public.landmarks for delete to authenticated
  using (user_id = (select auth.uid()));
-- landmark_finds: no policies, only find_landmark() writes and the functions read.

revoke all on public.landmarks, public.landmark_finds from public, anon, authenticated;
grant select (id, cell, kind, title, note, created_at), delete on public.landmarks to authenticated;
grant insert (cell, kind, title, note) on public.landmarks to authenticated;

revoke execute on function public.landmarks_before_insert(), public.landmark_limit() from public, anon, authenticated;
revoke execute on function public.landmarks_near(text[]), public.find_landmark(bigint), public.my_landmarks()
  from public, anon;
grant execute on function public.landmarks_near(text[]), public.find_landmark(bigint), public.my_landmarks()
  to authenticated;
