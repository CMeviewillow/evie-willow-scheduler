-- Time tracker, phase 1: time_entries
--
-- Concurrency rules (important — this is the core of the whole design):
--
-- One cabinet per timer. A timer is always against exactly one cabinet
-- when the stage is a cabinet stage. No batching, no splitting minutes
-- across cabinets.
--
-- Multiple people may work the same cabinet at the same time — two
-- benchers on one island is normal. So: a partial unique index stops one
-- PERSON from having two running timers, but there is deliberately no
-- constraint limiting how many people can be running against the same
-- cabinet at once.
--
-- This means total time against a cabinet is labour minutes, not elapsed
-- time — two people for two hours is four labour hours. That's the
-- correct basis for costing and matches how the benchmark library was
-- already built from Clockify, so no conversion is needed later. See the
-- cabinet_stage_totals view (0010) for both labour and elapsed figures.

create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id),
  job_id uuid not null references jobs(id),
  room_id uuid references rooms(id),
  cabinet_id uuid references cabinets(id),
  stage_id uuid not null references stages(id),
  started_at timestamptz not null,
  stopped_at timestamptz,
  break_minutes_deducted int not null default 0,
  net_minutes int,
  source text not null default 'board' check (source in ('board', 'manual', 'auto_closed', 'imported')),
  needs_review boolean not null default false,
  review_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_stopped_after_started check (stopped_at is null or stopped_at > started_at)
);

-- One person, at most one running timer.
create unique index if not exists idx_time_entries_one_running_per_person
  on time_entries (person_id)
  where stopped_at is null;

create index if not exists idx_time_entries_job_stage on time_entries (job_id, stage_id);
create index if not exists idx_time_entries_cabinet_stage on time_entries (cabinet_id, stage_id);
create index if not exists idx_time_entries_stopped_at on time_entries (stopped_at);

-- A cabinet is required whenever the stage is a cabinet stage (Cabinet
-- bench, Cabinet reassembly) — this can't be a plain check constraint
-- since it depends on another table, so it's a trigger instead.
create or replace function enforce_cabinet_required_for_cabinet_stage()
returns trigger as $$
declare
  stage_is_cabinet_stage boolean;
begin
  select is_cabinet_stage into stage_is_cabinet_stage
  from stages where id = new.stage_id;

  if stage_is_cabinet_stage and new.cabinet_id is null then
    raise exception 'time_entries.cabinet_id is required when the stage is a cabinet stage (stage_id = %)', new.stage_id;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_time_entries_cabinet_required on time_entries;
create trigger trg_time_entries_cabinet_required
  before insert or update on time_entries
  for each row execute function enforce_cabinet_required_for_cabinet_stage();
