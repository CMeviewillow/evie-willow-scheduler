-- Time tracker, phase 1: production_imports
--
-- One row per production-schedule import attempt (phase 2 writes to
-- this). raw_text is kept so a parse can be re-run without asking Abi for
-- the file again. Created here, before cabinets, since cabinets.import_batch_id
-- references it.
--
-- Named for the source-agnostic "Production" document, not "A4" — a real
-- sample (DA1277 Anna Reid) showed the reliable per-cabinet table (Item /
-- Part No. / Width / Height / Depth) actually lives on the job's A3
-- "Production" file, not the A4 (which is a per-cabinet manufacturing
-- cutlist — frame/door/drawer detail, useful later for costing, not
-- needed for cabinet identity). See docs/time-tracker.md. Keeping this
-- table's name tied to a specific page size would repeat that exact
-- mistake if the format changes again.

create table if not exists production_imports (
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

create index if not exists idx_production_imports_job_id on production_imports (job_id);
create index if not exists idx_production_imports_room_id on production_imports (room_id);
