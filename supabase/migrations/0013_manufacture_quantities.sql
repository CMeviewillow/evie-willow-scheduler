-- Time tracker: manufacture quantities (Frame/Door, "half a cabinet" each)
--
-- Replaces an earlier version of this migration that gave Bench prep a
-- per-cabinet frame/door split — a real Clockify export showed that
-- doesn't match practice: Frame and Door manufacture are batch work,
-- never logged against one specific cabinet (no entry in real history
-- ever reads "Frame manufacture #7"), unlike Bench/Reassembly which
-- always carry a cabinet number. See the note in 0006_stages.sql.
--
-- What's real instead: each stage runs at some number of cabinets' worth
-- per day (9 one day, 5 another, whatever the styles booked in that day
-- allow — this mirrors dayCapacity/benchDaysForJob in the main
-- scheduler). So a frame or door isn't "done against cabinet #7" — it's
-- one unit of a batch, and once the day's batch is complete, that's N
-- cabinets' worth of frames (or doors) ready. A cabinet only has both
-- once frame AND door have each independently reached it — so the two
-- counts combine as a minimum, not a sum, mirroring the "half each"
-- idea from the original ask but applied per day rather than per
-- cabinet-tap.
--
-- tracks_quantity marks which stages ask "how many did you complete"
-- when clocking off — Frame manufacture and Door manufacture today.
-- Extensible if another batch stage needs the same treatment later.

alter table stages add column if not exists tracks_quantity boolean not null default false;
update stages set tracks_quantity = true where name in ('Frame manufacture', 'Door manufacture');

alter table time_entries add column if not exists quantity_completed int check (quantity_completed is null or quantity_completed >= 0);

-- quantity_completed is required exactly when the stage tracks it, and
-- only makes sense once the entry is actually stopped (you don't know
-- the count until the session's over) — mirrors
-- enforce_cabinet_required_for_cabinet_stage's shape in 0009_time_entries.sql.
create or replace function enforce_quantity_matches_stage()
returns trigger as $$
declare
  stage_tracks_quantity boolean;
begin
  select tracks_quantity into stage_tracks_quantity
  from stages where id = new.stage_id;

  if stage_tracks_quantity and new.stopped_at is not null and new.quantity_completed is null then
    raise exception 'time_entries.quantity_completed is required when stopping a tracks_quantity stage (stage_id = %)', new.stage_id;
  end if;
  if not stage_tracks_quantity and new.quantity_completed is not null then
    raise exception 'time_entries.quantity_completed must be null when the stage does not track quantity (stage_id = %)', new.stage_id;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_time_entries_quantity_matches_stage on time_entries;
create trigger trg_time_entries_quantity_matches_stage
  before insert or update on time_entries
  for each row execute function enforce_quantity_matches_stage();

-- What the floor board would read: per job/room/day, how many cabinets'
-- worth of frames and doors are done, and the smaller of the two — the
-- number that's genuinely ready for Cabinet bench, since a cabinet needs
-- both. Left as raw frame/door totals too, not just the minimum, so a
-- lopsided day (doors way ahead of frames, say) is visible, not hidden
-- behind one blended number.
create or replace view frame_door_progress_by_day as
select
  job_id,
  room_id,
  started_at::date as work_date,
  sum(quantity_completed) filter (where stage_id = (select id from stages where name = 'Frame manufacture')) as frames_completed,
  sum(quantity_completed) filter (where stage_id = (select id from stages where name = 'Door manufacture')) as doors_completed,
  least(
    coalesce(sum(quantity_completed) filter (where stage_id = (select id from stages where name = 'Frame manufacture')), 0),
    coalesce(sum(quantity_completed) filter (where stage_id = (select id from stages where name = 'Door manufacture')), 0)
  ) as cabinets_ready_for_bench
from time_entries
where stage_id in (select id from stages where name in ('Frame manufacture', 'Door manufacture'))
  and stopped_at is not null
group by job_id, room_id, started_at::date;

-- RLS: matches every other table's permissive anon-key policy — see
-- 0012_rls.sql for why. This migration only adds columns/a view to
-- existing tables, so there's no new table to enable RLS on.
