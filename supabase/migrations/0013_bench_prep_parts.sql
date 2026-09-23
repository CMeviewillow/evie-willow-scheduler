-- Time tracker: bench prep parts and discrete stage completion
--
-- Two gaps closed here, found while designing how the floor board would
-- auto-fill its counts from real clock data:
--
-- 1. time_entries only ever recorded continuous labour TIME, with no
--    discrete "this is actually done" event — but the floor board counts
--    finished cabinets, not minutes. stage_completions is that missing
--    discrete event, separate from time_entries (which stays exactly as
--    it is, for costing).
--
-- 2. A cabinet isn't complete at Bench prep until BOTH its frame and its
--    door are done — so Bench prep can't use the same plain one-row-per-
--    cabinet completion Cabinet bench/reassembly use. has_parts marks
--    which stages need a completion row PER PART instead of one for the
--    whole cabinet; today that's Bench prep only, with exactly two parts
--    (frame, door), each worth half a cabinet. Drawer making is
--    deliberately not a third part here — the floor board already tracks
--    drawer boxes on its own separate tab.

alter table stages add column if not exists has_parts boolean not null default false;
update stages set has_parts = true where name = 'Bench prep';

alter table time_entries add column if not exists part text check (part in ('frame', 'door'));

-- part is required exactly when the stage says it needs one — mirrors
-- enforce_cabinet_required_for_cabinet_stage's shape in 0009_time_entries.sql.
create or replace function enforce_part_matches_stage()
returns trigger as $$
declare
  stage_has_parts boolean;
begin
  select has_parts into stage_has_parts
  from stages where id = new.stage_id;

  if stage_has_parts and new.part is null then
    raise exception 'time_entries.part is required when the stage has parts (stage_id = %)', new.stage_id;
  end if;
  if not stage_has_parts and new.part is not null then
    raise exception 'time_entries.part must be null when the stage has no parts (stage_id = %)', new.stage_id;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_time_entries_part_matches_stage on time_entries;
create trigger trg_time_entries_part_matches_stage
  before insert or update on time_entries
  for each row execute function enforce_part_matches_stage();

-- The discrete "this is done" event. part is null for a plain cabinet
-- stage (one row = the whole cabinet, worth 1) and 'frame'/'door' for a
-- has_parts stage (one row = half a cabinet each). Phase 3's floor board
-- tap writes here, distinct from starting/stopping a timer in
-- time_entries — someone can clock on and off a frame several times
-- before it's actually finished.
create table if not exists stage_completions (
  id uuid primary key default gen_random_uuid(),
  cabinet_id uuid not null references cabinets(id),
  stage_id uuid not null references stages(id),
  part text check (part in ('frame', 'door')),
  completed_by uuid not null references people(id),
  completed_at timestamptz not null default now(),
  source text not null default 'board' check (source in ('board', 'manual')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same part-matches-stage rule as time_entries, plus: at most one
-- completion per cabinet/stage/part (coalesce so the "whole cabinet,
-- part is null" case is also deduplicated — a plain unique constraint
-- would treat every null as distinct and let it be marked done twice).
create or replace function enforce_completion_part_matches_stage()
returns trigger as $$
declare
  stage_has_parts boolean;
begin
  select has_parts into stage_has_parts
  from stages where id = new.stage_id;

  if stage_has_parts and new.part is null then
    raise exception 'stage_completions.part is required when the stage has parts (stage_id = %)', new.stage_id;
  end if;
  if not stage_has_parts and new.part is not null then
    raise exception 'stage_completions.part must be null when the stage has no parts (stage_id = %)', new.stage_id;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_stage_completions_part_matches_stage on stage_completions;
create trigger trg_stage_completions_part_matches_stage
  before insert or update on stage_completions
  for each row execute function enforce_completion_part_matches_stage();

create unique index if not exists idx_stage_completions_unique
  on stage_completions (cabinet_id, stage_id, coalesce(part, ''));

-- RLS: matches every other table's permissive anon-key policy — see
-- 0012_rls.sql for why. Enabled here, not there, since this table is
-- created after 0012 runs.
alter table stage_completions enable row level security;
create policy "allow all - stage_completions" on stage_completions for all using (true) with check (true);

-- What the floor board reads: how much of a cabinet is done at a given
-- stage, as a fraction (1 for a plain stage, 0.5/1 for a has_parts stage
-- with one/both parts done).
create or replace view cabinet_stage_progress as
select
  sc.cabinet_id,
  sc.stage_id,
  s.has_parts,
  case
    when s.has_parts then least(1.0, count(distinct sc.part)::numeric / 2)
    else 1.0
  end as fraction_complete,
  max(sc.completed_at) as last_completed_at
from stage_completions sc
join stages s on s.id = sc.stage_id
group by sc.cabinet_id, sc.stage_id, s.has_parts;
