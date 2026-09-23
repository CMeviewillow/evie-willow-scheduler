-- Time tracker, phase 1: stages
--
-- is_cabinet_stage drives whether the floor board asks which cabinet a
-- timer is against. Cabinet bench and Cabinet reassembly do because
-- that's the whole point of tracking them. Remakes and fix-ups also
-- does: a remedial coming back from site is against one specific
-- cabinet, and pinning it lets the office later see which cabinet or
-- type comes back for rework most, instead of a remedial just being
-- loose hours against the job. The rest are overhead/shared work that
-- isn't tracked per-unit.
--
-- Bench prep IS a cabinet stage too (frame and door making) — a cabinet
-- isn't complete at this stage until BOTH its frame and its door are
-- done, so it needs the two-part completion model added in
-- 0013_bench_prep_parts.sql (has_parts), not just a plain done/not-done
-- like Cabinet bench. Drawer making stays off this stage entirely — the
-- floor board already tracks drawer boxes on its own separate tab, not
-- as part of any cabinet's stage progress.

create table if not exists stages (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null,
  is_cabinet_stage boolean not null,
  is_overhead boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into stages (name, sort_order, is_cabinet_stage, is_overhead) values
  ('CNC', 1, false, true),
  ('Bench prep', 2, true, false),
  ('Cabinet bench', 3, true, false),
  ('Spraying and finishing', 4, false, true),
  ('Cabinet reassembly', 5, true, false),
  ('Edgebanding', 6, false, true),
  ('Timber machining', 7, false, true),
  ('Production prep', 8, false, true),
  ('Remakes and fix-ups', 9, true, false),
  ('Delivery and logistics', 10, false, false),
  ('Design and admin', 11, false, false);
