-- Time tracker, phase 1: people
--
-- Leavers are never deleted — set active = false instead. History (time
-- entries, aliases) must stay intact and they simply drop off the board.
-- There is deliberately no delete path anywhere for this table.

create extension if not exists pgcrypto;

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('cnc', 'bench', 'spray', 'reassembly', 'logistics', 'design', 'admin', 'general')),
  active boolean not null default true,
  pin text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_people_active on people (active);

-- Seed: current team as of this branch. Some of these have left the
-- business and some Clockify names are being renamed — that's what
-- person_aliases (next migration) is for. Nobody here is deleted, ever.
--
-- This migration is meant to run exactly once, like every migration here —
-- there's no natural unique key on name alone (two people could genuinely
-- share a first name) to make a re-run safely idempotent, so don't re-run
-- this file against a database that already has these rows.
insert into people (name, role) values
  ('Jon', 'cnc'),
  ('Noah', 'cnc'),
  ('Jan', 'bench'),
  ('Axel', 'bench'),
  ('Harry', 'bench'),
  ('Mike', 'bench'),
  ('Jaxon', 'bench'),
  ('Josh', 'bench'),
  ('Glenn', 'reassembly'),
  ('Wayne', 'reassembly'),
  ('Mark', 'spray'),
  ('Steve', 'spray'),
  ('Alex', 'general'),
  ('Liam', 'general'),
  ('Max', 'design'),
  ('Abi', 'design'),
  ('Becky', 'admin'),
  ('Victoria Pearce', 'admin'),
  ('Joe', 'admin'),
  ('Martin', 'admin');
