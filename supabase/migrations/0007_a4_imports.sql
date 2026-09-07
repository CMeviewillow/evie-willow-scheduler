-- Time tracker, phase 1: a4_imports
--
-- One row per A4 production-schedule import attempt (phase 2 writes to
-- this). raw_text is kept so a parse can be re-run without asking Abi for
-- the file again. Created here, before cabinets, since cabinets.import_batch_id
-- references it.

create table if not exists a4_imports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  room_id uuid not null references rooms(id),
  filename text not null,
  imported_by uuid not null references people(id),
  imported_at timestamptz not null default now(),
  raw_text text,
  cabinet_count int,
  status text not null default 'parsed' check (status in ('parsed', 'reviewed', 'applied')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_a4_imports_job_id on a4_imports (job_id);
create index if not exists idx_a4_imports_room_id on a4_imports (room_id);
