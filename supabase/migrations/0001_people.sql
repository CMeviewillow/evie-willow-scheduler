-- Time tracker, phase 1: people
--
-- Leavers are never deleted — set active = false instead. History (time
-- entries, aliases) must stay intact and they simply drop off the board.
-- There is deliberately no delete path anywhere for this table.

create extension if not exists pgcrypto;

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('cnc', 'bench', 'spray', 'reassembly', 'fitter', 'logistics', 'design', 'admin', 'general')),
  active boolean not null default true,
  pin text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_people_active on people (active);

-- Seed: the real current team, confirmed directly against the business
-- (2026-09). Role is a first guess where it wasn't stated outright — the
-- office should correct it via an admin screen rather than treat it as
-- fixed, same as cabinet_types.category. Some names below replace an
-- earlier, wrong draft of this list; where a name changed, the old one
-- is carried forward as an alias in the next migration so imported
-- Clockify history still pools correctly. Nobody here is deleted, ever.
--
-- This migration is meant to run exactly once, like every migration here —
-- there's no natural unique key on name alone (two people could genuinely
-- share a first name) to make a re-run safely idempotent, so don't re-run
-- this file against a database that already has these rows.
insert into people (name, role) values
  -- Workshop
  ('Harry', 'bench'),
  ('Jon', 'cnc'),
  ('Tom', 'general'),
  ('Mike', 'bench'),
  ('Jan', 'bench'),
  ('Jaxon', 'bench'),
  ('Josh', 'bench'),
  ('Wayne', 'reassembly'),
  ('Glenn', 'reassembly'),
  ('Mark', 'spray'),
  ('Steve', 'spray'),
  ('Thompson', 'fitter'), -- fitter, but occasionally comes into the workshop
  -- Office
  ('Callum', 'admin'),
  ('Abi', 'design'),
  ('Louise', 'admin'),
  ('Martin', 'admin'),
  ('Victoria', 'admin'),
  ('Becky', 'admin');
