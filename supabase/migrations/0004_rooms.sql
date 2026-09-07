-- Time tracker, phase 1: rooms
--
-- Cabinet numbering restarts per room (the real A4 sample confirms this —
-- "#1", "#2" etc. are room-scoped, not job-scoped), so the uniqueness
-- constraint on cabinet_number lives at the room level, not the job level.

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_rooms_job_id on rooms (job_id);
