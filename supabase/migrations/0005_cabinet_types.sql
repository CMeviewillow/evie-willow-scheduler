-- Time tracker, phase 1: cabinet_types
--
-- The master list. This is what makes cross-job pooling possible — every
-- cabinet on every job resolves to exactly one row here. Types are only
-- ever created through the phase 2 import review screen or an admin
-- screen, both office-side; nobody on the floor ever picks or types one.
-- Anything created during an import gets needs_office_review = true so
-- the list can't drift silently.
--
-- Naming convention (display and enforce this in the admin screen): PD
-- means Pair of Doors, SD means Single Door, a trailing number is width
-- in cm. So "Tall PD 120" is a tall cabinet with a pair of doors, 120cm
-- wide. Confirmed against a real Cabinet Vision export (DA1234 Walker
-- Church) — several of the seeded names below matched real cabinets on
-- that job exactly (e.g. "Base Intg DW Door 67").

create table if not exists cabinet_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null check (category in ('base', 'tall', 'wall', 'island', 'counter_top', 'housing', 'panel', 'component', 'other')),
  carries_reassembly boolean not null default true,
  needs_office_review boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cabinet_types_needs_review on cabinet_types (needs_office_review);

-- Seed: the types confirmed in the benchmark library so far. This is a
-- deliberate starting point, nowhere near the full range — the office
-- will extend it as real jobs get imported. Category assignments below
-- are a reasonable first guess from the name alone; the office should
-- correct any that are wrong via the admin screen rather than treating
-- them as fixed.
--
-- Deliberately NOT seeded: any "...ShP Skirting..." style name. Confirmed
-- against a real job that these are never real cabinets — see the note
-- in 0008_cabinets.sql.
insert into cabinet_types (name, category, carries_reassembly) values
  ('Base 3 Drawers 60', 'base', true),
  ('Base Dwr Line 1D-PD 110', 'base', true),
  ('Base Sink PD 80', 'base', true),
  ('Base Intg DW Door 67', 'base', true),
  ('Base Double Bin 48', 'base', true),
  ('Base 2 Oak Chopping Boards', 'base', true),
  ('Tall PD 80', 'tall', true),
  ('Tall SD 67', 'tall', true),
  ('Tall FFR Housing', 'tall', true),
  ('Single Oven DD-1DRW', 'tall', true),
  ('Counter Top 4D Bi-Fold 120', 'counter_top', true);

-- These carry no reassembly time — panels, housings, and units that ship
-- straight out rather than going through the workshop's own reassembly
-- stage.
insert into cabinet_types (name, category, carries_reassembly) values
  ('Panel', 'panel', false),
  ('Extractor Housing', 'housing', false),
  ('Turned Post', 'component', false),
  ('Open Shelf', 'other', false),
  ('Open Base Unit', 'base', false),
  ('Primed Unit Ship Out', 'other', false),
  ('Painted Unit Ship Out', 'other', false);
