-- The community map shows how warm every hex is, whoever walked it.
--
-- collective_map() only ever returned hexes walked by you and your friends, so
-- the district tab painted your own hexes plus your friends' and nothing else,
-- even when the card said the district was 60% warm. community_heat() returns
-- every hex in the asked-for blocks, with the same heat the district warmth is
-- the average of (hex_heat of the newest walk by anyone), so what's painted
-- adds up to the card.
--
-- What strangers learn from it, nothing more than the district number already
-- says: that somebody walked a hex, how recently (heat rounded to 2 places),
-- and how many people did. No names, no dates. `first_username` is only filled
-- when the first of you there was you or a friend, as before.
--
-- collective_map() stays as it was, so older apps keep working.
--
-- Safe to run again.

create or replace function public.community_heat(cells8 text[])
returns table (cell text, heat float8, explorers bigint, mine boolean, first_username text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;
  if cells8 is null or cardinality(cells8) > 60 then raise exception 'Zoom in to see the community map'; end if;
  return query
    select c.cell,
      round(hex_heat(max(c.last_visited))::numeric, 2)::float8,
      count(*),
      coalesce(bool_or(c.user_id = me), false),
      (array_agg(p.username order by c.first_visited) filter (where c.user_id = me or are_friends(me, c.user_id)))[1]
    from user_cells c join profiles p on p.id = c.user_id
    where c.cell8 = any (cells8)
    group by c.cell;
end $$;

revoke execute on function public.community_heat(text[]) from public, anon;
grant execute on function public.community_heat(text[]) to authenticated;
