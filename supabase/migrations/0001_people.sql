-- Time tracker, phase 1: people
--
-- Leavers are never deleted — set active = false instead. History (time
-- entries, aliases) must stay intact and they simply drop off the board.
-- There is deliberately no delete path anywhere for this table.

create extension if not exists pgcrypto;

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  pin text unique check (pin is null or pin ~ '^[0-9]{4}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_people_active on people (active);

-- pin is how someone confirms it's really them on the floor board, after
-- tapping their name — a 4-digit code, unique per person (postgres treats
-- each null as distinct, so people who haven't been assigned one yet
-- don't collide with each other). Nobody is seeded with one here: making
-- up placeholder numbers in a migration would read as real data. Assign
-- real PINs per person via the admin screen before phase 3 goes live —
-- someone with no pin simply can't be selected to clock on.

-- Seed: the real current team, confirmed directly against the business
-- (2026-09). No job title/role field — people aren't boxed into one
-- stage, and what someone's doing on a given timer is already captured
-- by which stage they clock into, not by a fixed label on the person.
-- Nobody here is deleted, ever. Old Clockify name variants aren't
-- seeded as aliases — add them via the ?admin=aliases screen (or the
-- person_aliases table directly) if and when reconciling old history
-- actually needs them.
--
-- This migration is meant to run exactly once, like every migration here —
-- there's no natural unique key on name alone (two people could genuinely
-- share a first name) to make a re-run safely idempotent, so don't re-run
-- this file against a database that already has these rows.
insert into people (name) values
  -- Workshop
  ('Harry'), ('Jon'), ('Tom'), ('Mike'), ('Jan'), ('Jaxon'), ('Josh'),
  ('Wayne'), ('Glenn'), ('Mark'), ('Steve'),
  ('Thompson'), -- fitter, but occasionally comes into the workshop
  -- Office
  ('Callum'), ('Abi'), ('Louise'), ('Martin'), ('Victoria'), ('Becky');
