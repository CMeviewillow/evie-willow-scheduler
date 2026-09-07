-- Time tracker, phase 1: jobs
--
-- 'setup' means the A4 import is under way (phase 2). 'released' means
-- every cabinet on the job has a type and it's visible on the floor board
-- (phase 3). The trigger enforcing that rule lives in
-- 0011_job_release_guard.sql, once cabinets exists.

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  da_number text not null unique,
  client_name text not null,
  status text not null default 'quoted' check (status in ('quoted', 'setup', 'released', 'in_production', 'delivered', 'complete')),
  delivery_date date,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_jobs_status on jobs (status);
