-- Time tracker, phase 1: cabinets
--
-- cabinet_type_id is nullable at import time and required before the job
-- can be released (enforced by the trigger in 0011_job_release_guard.sql,
-- not just the UI). raw_description is kept verbatim from the A4 for
-- audit and re-matching, separate from whatever type it eventually maps
-- to.
--
-- Decimal cabinet numbers are a real, recurring pattern, not an edge
-- case — confirmed against a real Cabinet Vision export where e.g. "#14"
-- (a skirting/post unit) was followed by "#14.1" (a separate shaker panel
-- that belongs with it), each independently typed. Both are their own
-- row here.

create table if not exists cabinets (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  cabinet_number numeric not null,
  cabinet_type_id uuid references cabinet_types(id),
  raw_description text,
  import_batch_id uuid references a4_imports(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, cabinet_number)
);

create index if not exists idx_cabinets_room_id on cabinets (room_id);
create index if not exists idx_cabinets_cabinet_type_id on cabinets (cabinet_type_id);
create index if not exists idx_cabinets_import_batch_id on cabinets (import_batch_id);
