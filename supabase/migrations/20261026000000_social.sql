-- Scoop community features.
--
-- Privacy model: only H3 cell ids (resolution 10), visit counts and walk
-- totals are ever uploaded — never GPS tracks. Everything is visible to the
-- owner and their accepted friends; users who opt into `leaderboard_public`
-- also appear on public leaderboards and the community map.
--
-- Clients only get the column privileges they need (see the grants at the
-- bottom), and anything that crosses users goes through the security definer
-- functions below, which always scope results to auth.uid().

-- ---------- H3 helpers ----------

-- Parent of an H3 cell at a coarser resolution, done with bit operations so no
-- extension is needed: set the resolution field, then mark every digit finer
-- than `res` as unused (7).
create or replace function public.h3_to_parent(cell text, res int)
returns text language sql immutable strict parallel safe as $$
  select lpad(to_hex(
    (('x' || lpad(cell, 16, '0'))::bit(64)::bigint
      & ~(15::bigint << 52)
      & ~((1::bigint << ((15 - res) * 3)) - 1))
    | (res::bigint << 52)
    | ((1::bigint << ((15 - res) * 3)) - 1)
  ), 15, '0')
$$;

-- ---------- tables ----------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text check (char_length(display_name) <= 40),
  avatar_url text check (char_length(avatar_url) <= 300),
  home_city text check (char_length(home_city) <= 60),
  invite_code text not null unique
    default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
  leaderboard_public boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.friendships (
  requester uuid not null references public.profiles (id) on delete cascade,
  addressee uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
create unique index friendships_pair on public.friendships
  (least(requester, addressee), greatest(requester, addressee));
create index friendships_addressee on public.friendships (addressee);

create table public.user_cells (
  user_id uuid not null references public.profiles (id) on delete cascade,
  cell text not null check (cell ~ '^8a[0-9a-f]{13}$'),
  cell8 text generated always as (public.h3_to_parent(cell, 8)) stored,
  first_visited timestamptz not null check (first_visited <= now() + interval '1 day'),
  visits int not null default 1 check (visits >= 1),
  primary key (user_id, cell)
);
create index user_cells_cell8 on public.user_cells (cell8);

create table public.walks (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  km numeric(7, 3) not null check (km >= 0 and km < 300),
  new_cells int not null default 0 check (new_cells >= 0),
  unique (user_id, started_at),
  check (ended_at >= started_at)
);
create index walks_feed on public.walks (user_id, started_at desc);

create table public.kudos (
  walk_id bigint not null references public.walks (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null default '👏' check (emoji in ('👏', '🔥', '❤️', '👣')),
  created_at timestamptz not null default now(),
  primary key (walk_id, user_id)
);

create table public.checkins (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  cell text not null check (cell ~ '^8a[0-9a-f]{13}$'),
  kind text not null check (kind in ('photo', 'coffee', 'food', 'meetup')),
  note text check (char_length(note) <= 140),
  photo_path text check (char_length(photo_path) <= 200),
  met_with uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  day date not null default (now() at time zone 'utc')::date
);
-- One check-in of each kind per hex per day.
create unique index checkins_once_a_day on public.checkins (user_id, cell, kind, day);
create index checkins_feed on public.checkins (user_id, created_at desc);
create index checkins_meetups on public.checkins (cell, created_at) where kind = 'meetup';

create table public.challenges (
  id bigint generated always as identity primary key,
  creator uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  metric text not null check (metric in ('hexes', 'km', 'score')),
  -- Optional area: resolution-8 cells (~0.7 km² each). Null means anywhere.
  area_cells text[] check (area_cells is null or cardinality(area_cells) between 1 and 400),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '92 days')
);

create table public.challenge_members (
  challenge_id bigint not null references public.challenges (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'joined')),
  primary key (challenge_id, user_id)
);
create index challenge_members_user on public.challenge_members (user_id);

create table public.badges (
  user_id uuid not null references public.profiles (id) on delete cascade,
  badge_key text not null,
  earned_at timestamptz not null default now(),
  primary key (user_id, badge_key)
);

-- ---------- relationship helpers ----------

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships
    where status = 'accepted'
      and ((requester = a and addressee = b) or (requester = b and addressee = a))
  )
$$;

-- The versions policies use: always relative to the signed-in user.
create or replace function public.is_friend(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.are_friends(auth.uid(), other)
$$;

-- Any friendship row, pending included (so requests show who sent them).
create or replace function public.is_connected(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friendships
    where (requester = auth.uid() and addressee = other)
       or (requester = other and addressee = auth.uid())
  )
$$;

create or replace function public.is_challenge_member(cid bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from challenge_members where challenge_id = cid and user_id = auth.uid())
      or exists (select 1 from challenges where id = cid and creator = auth.uid())
$$;

-- Storage folders are named after the owner's user id.
create or replace function public.can_view_folder(folder text)
returns boolean language sql stable security definer set search_path = public as $$
  select folder = auth.uid()::text or exists (
    select 1 from friendships
    where status = 'accepted'
      and ((requester = auth.uid() and addressee::text = folder)
        or (addressee = auth.uid() and requester::text = folder))
  )
$$;

-- ---------- scoring ----------

-- Hex scores: 1 point per new hex, floor(log2(visits)) for hexes you keep
-- coming back to, plus check-ins: photo 3, coffee/food 2, a meetup verified
-- by a friend checking in nearby 5.
create or replace function public.checkin_points(kind text, met_with uuid)
returns int language sql immutable as $$
  select case kind
    when 'photo' then 3
    when 'coffee' then 2
    when 'food' then 2
    when 'meetup' then case when met_with is null then 0 else 5 end
    else 0 end
$$;

-- Score earned between t0 and t1 (either may be null), optionally limited to
-- an area of resolution-8 cells.
create or replace function public.score_between(uid uuid, t0 timestamptz, t1 timestamptz, area text[])
returns numeric language sql stable security definer set search_path = public as $$
  select
    (select count(*) from user_cells c
      where c.user_id = uid
        and (t0 is null or c.first_visited >= t0) and (t1 is null or c.first_visited < t1)
        and (area is null or c.cell8 = any (area)))
  + (select coalesce(sum(checkin_points(k.kind, k.met_with)), 0) from checkins k
      where k.user_id = uid
        and (t0 is null or k.created_at >= t0) and (t1 is null or k.created_at < t1)
        and (area is null or h3_to_parent(k.cell, 8) = any (area)))
  + (case when t0 is null and t1 is null then
      (select coalesce(sum(floor(ln(c.visits) / ln(2))), 0) from user_cells c
        where c.user_id = uid and c.visits > 1 and (area is null or c.cell8 = any (area)))
     else 0 end)
$$;

create or replace function public.metric_between(uid uuid, metric text, t0 timestamptz, t1 timestamptz, area text[])
returns numeric language sql stable security definer set search_path = public as $$
  select case metric
    when 'hexes' then (select count(*)::numeric from user_cells c
      where c.user_id = uid
        and (t0 is null or c.first_visited >= t0) and (t1 is null or c.first_visited < t1)
        and (area is null or c.cell8 = any (area)))
    -- Walks carry no location, so km ignores the area.
    when 'km' then (select coalesce(sum(w.km), 0) from walks w
      where w.user_id = uid
        and (t0 is null or w.started_at >= t0) and (t1 is null or w.started_at < t1))
    else score_between(uid, t0, t1, area) end
$$;

-- Longest run of consecutive days (UTC) with at least one walk.
create or replace function public.longest_streak(uid uuid)
returns int language sql stable security definer set search_path = public as $$
  with d as (
    select distinct (started_at at time zone 'utc')::date as day from walks where user_id = uid
  ), g as (
    select day - (row_number() over (order by day))::int as grp from d
  )
  select coalesce(max(n), 0)::int from (select count(*) as n from g group by grp) runs
$$;

create or replace function public.award_badges(uid uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  n_cells int; max_visits int; n_walks int; total_km numeric;
  n_coffee int; n_photo int; met boolean; streak int;
begin
  select count(*), coalesce(max(visits), 0) into n_cells, max_visits from user_cells where user_id = uid;
  select count(*), coalesce(sum(km), 0) into n_walks, total_km from walks where user_id = uid;
  select count(*) filter (where kind = 'coffee'), count(*) filter (where kind = 'photo'),
         coalesce(bool_or(met_with is not null), false)
    into n_coffee, n_photo, met from checkins where user_id = uid;
  streak := longest_streak(uid);
  insert into badges (user_id, badge_key)
  select uid, v.k from (values
    ('first_walk', n_walks >= 1),
    ('hex_100', n_cells >= 100),
    ('hex_1000', n_cells >= 1000),
    ('hex_10000', n_cells >= 10000),
    ('marathon', total_km >= 42.195),
    ('km_500', total_km >= 500),
    ('streak_7', streak >= 7),
    ('streak_30', streak >= 30),
    ('regular', max_visits >= 10),
    ('first_meetup', met),
    ('coffee_10', n_coffee >= 10),
    ('photo_10', n_photo >= 10)
  ) as v (k, ok)
  where v.ok
  on conflict do nothing;
end $$;

-- ---------- triggers ----------

create or replace function public.walks_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform award_badges(new.user_id);
  return null;
end $$;
create trigger walks_award after insert on public.walks
  for each row execute function public.walks_after_insert();

create or replace function public.checkins_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  new.day := (now() at time zone 'utc')::date;
  new.met_with := null;
  if not exists (select 1 from user_cells where user_id = new.user_id and cell = new.cell) then
    raise exception 'Walk through this hex before checking in here' using errcode = 'P0001';
  end if;
  if new.photo_path is not null and split_part(new.photo_path, '/', 1) <> new.user_id::text then
    raise exception 'Photos must be in your own folder' using errcode = 'P0001';
  end if;
  if new.kind = 'photo' and new.photo_path is null then
    raise exception 'A photo check-in needs a photo' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger checkins_validate before insert on public.checkins
  for each row execute function public.checkins_before_insert();

-- A meetup counts once a friend also checks in to the same hex within 30 min.
create or replace function public.checkins_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  other record;
begin
  if new.kind = 'meetup' then
    select c.id, c.user_id into other from checkins c
    where c.kind = 'meetup' and c.cell = new.cell and c.user_id <> new.user_id
      and c.met_with is null and c.created_at >= new.created_at - interval '30 minutes'
      and are_friends(c.user_id, new.user_id)
    order by c.created_at desc limit 1;
    if found then
      update checkins set met_with = new.user_id where id = other.id;
      update checkins set met_with = other.user_id where id = new.id;
      perform award_badges(other.user_id);
    end if;
  end if;
  perform award_badges(new.user_id);
  return null;
end $$;
create trigger checkins_award after insert on public.checkins
  for each row execute function public.checkins_after_insert();

create or replace function public.challenges_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into challenge_members (challenge_id, user_id, status) values (new.id, new.creator, 'joined');
  return null;
end $$;
create trigger challenges_add_creator after insert on public.challenges
  for each row execute function public.challenges_after_insert();

-- ---------- client API ----------

create or replace function public.my_invite_code()
returns text language sql stable security definer set search_path = public as $$
  select invite_code from profiles where id = auth.uid()
$$;

-- Upsert visited cells: [{ "c": cell, "t": firstVisitedMs, "v": visits }, …].
-- Keeps the earliest first visit and the highest visit count.
create or replace function public.sync_cells(cells jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  n int;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if jsonb_array_length(cells) > 1000 then raise exception 'At most 1000 cells per call'; end if;
  insert into user_cells (user_id, cell, first_visited, visits)
  select distinct on (x ->> 'c')
    me, x ->> 'c',
    to_timestamp((x ->> 't')::double precision / 1000),
    greatest(1, coalesce((x ->> 'v')::int, 1))
  from jsonb_array_elements(cells) as x
  order by x ->> 'c'
  on conflict (user_id, cell) do update set
    first_visited = least(user_cells.first_visited, excluded.first_visited),
    visits = greatest(user_cells.visits, excluded.visits);
  get diagnostics n = row_count;
  perform award_badges(me);
  return n;
end $$;

-- Send a request by invite code. If they already asked you, you're now friends.
create or replace function public.send_friend_request(code text)
returns table (id uuid, username text, display_name text, status text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  other uuid;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select p.id into other from profiles p where p.invite_code = upper(trim(code));
  if other is null then raise exception 'No one has that invite code' using errcode = 'P0001'; end if;
  if other = me then raise exception 'That''s your own code' using errcode = 'P0001'; end if;
  if exists (select 1 from friendships f where f.requester = other and f.addressee = me) then
    update friendships f set status = 'accepted' where f.requester = other and f.addressee = me;
  else
    insert into friendships (requester, addressee) values (me, other) on conflict do nothing;
  end if;
  return query
    select p.id, p.username, p.display_name, f.status
    from profiles p
    join friendships f on (f.requester = me and f.addressee = p.id) or (f.requester = p.id and f.addressee = me)
    where p.id = other;
end $$;

create or replace function public.respond_friend_request(other uuid, accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if accept then
    update friendships set status = 'accepted'
    where requester = other and addressee = auth.uid() and status = 'pending';
  else
    delete from friendships where requester = other and addressee = auth.uid() and status = 'pending';
  end if;
end $$;

create or replace function public.leaderboard(scope text default 'friends', metric text default 'score', period text default 'week')
returns table (user_id uuid, username text, display_name text, value numeric, rank bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  since timestamptz;
begin
  if me is null then raise exception 'Not signed in'; end if;
  if scope not in ('friends', 'public') or metric not in ('hexes', 'km', 'score') or period not in ('week', 'all') then
    raise exception 'Bad leaderboard arguments';
  end if;
  since := case when period = 'week' then date_trunc('week', now()) end;
  return query
    with scored as (
      select p.id, p.username, p.display_name, metric_between(p.id, metric, since, null, null) as v
      from profiles p
      where case when scope = 'friends' then p.id = me or are_friends(me, p.id) else p.leaderboard_public end
    )
    select s.id, s.username, s.display_name, round(s.v, 2), rank() over (order by s.v desc)
    from scored s
    order by 5, 2
    limit 100;
end $$;

create or replace function public.challenge_standings(cid bigint)
returns table (user_id uuid, username text, display_name text, status text, value numeric, rank bigint)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  ch challenges;
begin
  if not is_challenge_member(cid) then raise exception 'Not part of this challenge'; end if;
  select * into ch from challenges where id = cid;
  return query
    with scored as (
      select p.id, p.username, p.display_name, m.status,
        case when m.status = 'joined'
          then metric_between(p.id, ch.metric, ch.starts_at, least(ch.ends_at, now()), ch.area_cells)
          else 0 end as v
      from challenge_members m join profiles p on p.id = m.user_id
      where m.challenge_id = cid
    )
    select s.id, s.username, s.display_name, s.status, round(s.v, 2),
      rank() over (order by (s.status = 'joined') desc, s.v desc)
    from scored s
    order by 6, 2;
end $$;

-- The collective map for the given resolution-8 cells: resolution-9 cells with
-- how many people (you, friends and public profiles) explored them and who got
-- there first. Raw resolution-10 cells of other users never leave the server.
create or replace function public.collective_map(cells8 text[])
returns table (cell text, explorers bigint, first_username text, first_visited timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if cardinality(cells8) > 400 then raise exception 'Zoom in to see the community map'; end if;
  return query
    with people as (
      select p.id, p.username from profiles p
      where p.id = me or p.leaderboard_public or are_friends(me, p.id)
    ), per_user as (
      select h3_to_parent(c.cell, 9) as c9, c.user_id, min(c.first_visited) as fv
      from user_cells c join people on people.id = c.user_id
      where c.cell8 = any (cells8)
      group by 1, 2
    )
    select u.c9, count(*), (array_agg(people.username order by u.fv))[1], min(u.fv)
    from per_user u join people on people.id = u.user_id
    group by u.c9;
end $$;

-- Play Store requirement. Delete your photos from storage first (the client
-- does this); everything else cascades from auth.users.
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- ---------- row level security ----------

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.user_cells enable row level security;
alter table public.walks enable row level security;
alter table public.kudos enable row level security;
alter table public.checkins enable row level security;
alter table public.challenges enable row level security;
alter table public.challenge_members enable row level security;
alter table public.badges enable row level security;

create policy "profiles: read self, connected and public" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or leaderboard_public or public.is_connected(id));
create policy "profiles: create own" on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "friendships: read own" on public.friendships for select to authenticated
  using (requester = (select auth.uid()) or addressee = (select auth.uid()));
create policy "friendships: remove own" on public.friendships for delete to authenticated
  using (requester = (select auth.uid()) or addressee = (select auth.uid()));

create policy "cells: read own and friends" on public.user_cells for select to authenticated
  using (user_id = (select auth.uid()) or public.is_friend(user_id));
create policy "cells: delete own" on public.user_cells for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "walks: read own and friends" on public.walks for select to authenticated
  using (user_id = (select auth.uid()) or public.is_friend(user_id));
create policy "walks: add own" on public.walks for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "walks: delete own" on public.walks for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "kudos: read on visible walks" on public.kudos for select to authenticated
  using (exists (select 1 from public.walks w where w.id = walk_id));
create policy "kudos: give on visible walks" on public.kudos for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.walks w where w.id = walk_id));
create policy "kudos: take back own" on public.kudos for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "checkins: read own and friends" on public.checkins for select to authenticated
  using (user_id = (select auth.uid()) or public.is_friend(user_id));
create policy "checkins: add own" on public.checkins for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "checkins: delete own" on public.checkins for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "challenges: read if involved" on public.challenges for select to authenticated
  using (creator = (select auth.uid()) or public.is_challenge_member(id));
create policy "challenges: create own" on public.challenges for insert to authenticated
  with check (creator = (select auth.uid()));
create policy "challenges: delete own" on public.challenges for delete to authenticated
  using (creator = (select auth.uid()));

create policy "members: read if involved" on public.challenge_members for select to authenticated
  using (public.is_challenge_member(challenge_id));
create policy "members: creator invites friends" on public.challenge_members for insert to authenticated
  with check (
    status = 'invited'
    and public.is_friend(user_id)
    and exists (select 1 from public.challenges c where c.id = challenge_id and c.creator = (select auth.uid()))
  );
create policy "members: accept own invite" on public.challenge_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "members: leave or remove" on public.challenge_members for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.challenges c where c.id = challenge_id and c.creator = (select auth.uid()))
  );

create policy "badges: read own and friends" on public.badges for select to authenticated
  using (user_id = (select auth.uid()) or public.is_friend(user_id));

-- ---------- privileges ----------
-- Supabase grants everything on new objects to anon and authenticated by
-- default; narrow that to exactly what the client uses.

revoke all on public.profiles, public.friendships, public.user_cells, public.walks, public.kudos,
  public.checkins, public.challenges, public.challenge_members, public.badges from anon, authenticated;

grant select (id, username, display_name, avatar_url, home_city, leaderboard_public, created_at)
  on public.profiles to authenticated;
grant insert (id, username, display_name, avatar_url, home_city, leaderboard_public)
  on public.profiles to authenticated;
grant update (username, display_name, avatar_url, home_city, leaderboard_public)
  on public.profiles to authenticated;
grant select, delete on public.friendships to authenticated;
grant select, delete on public.user_cells to authenticated;
grant select, delete on public.walks to authenticated;
grant insert (started_at, ended_at, km, new_cells) on public.walks to authenticated;
grant select, delete on public.kudos to authenticated;
grant insert (walk_id, emoji) on public.kudos to authenticated;
grant select, delete on public.checkins to authenticated;
grant insert (cell, kind, note, photo_path) on public.checkins to authenticated;
grant select, delete on public.challenges to authenticated;
grant insert (title, metric, area_cells, starts_at, ends_at) on public.challenges to authenticated;
grant select, delete on public.challenge_members to authenticated;
grant insert (challenge_id, user_id, status) on public.challenge_members to authenticated;
grant update (status) on public.challenge_members to authenticated;
grant select on public.badges to authenticated;

-- Internal helpers: not callable from the API.
revoke execute on function public.are_friends(uuid, uuid), public.score_between(uuid, timestamptz, timestamptz, text[]),
  public.metric_between(uuid, text, timestamptz, timestamptz, text[]), public.longest_streak(uuid),
  public.award_badges(uuid), public.walks_after_insert(), public.checkins_before_insert(),
  public.checkins_after_insert(), public.challenges_after_insert()
  from public, anon, authenticated;

revoke execute on function public.my_invite_code(), public.sync_cells(jsonb), public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean), public.leaderboard(text, text, text),
  public.challenge_standings(bigint), public.collective_map(text[]), public.delete_my_account()
  from public, anon;
grant execute on function public.my_invite_code(), public.sync_cells(jsonb), public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean), public.leaderboard(text, text, text),
  public.challenge_standings(bigint), public.collective_map(text[]), public.delete_my_account()
  to authenticated;

-- ---------- check-in photos ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('checkin-photos', 'checkin-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

create policy "checkin photos: upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'checkin-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "checkin photos: read own and friends" on storage.objects for select to authenticated
  using (bucket_id = 'checkin-photos' and public.can_view_folder((storage.foldername(name))[1]));
create policy "checkin photos: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'checkin-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
