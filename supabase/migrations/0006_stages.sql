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
-- like Cabinet bench.
--
-- Drawer making is its own separate overhead stage (like CNC or
-- Edgebanding), not part of any cabinet's stage progress and not a third
-- Bench prep part — a drawer box isn't numbered/typed against one
-- specific cabinet the way a frame or door is. It exists so real clocked
-- time can eventually be costed against it. The floor board's existing
-- Drawers tab (Harry's daily batch counts) is a separate, real-time
-- production-visibility tool and stays exactly as it is — there's no
-- person or precise time on a batch count to derive labour minutes from,
-- so it doesn't feed this stage's time_entries, it just runs alongside it.

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
  ('Drawer making', 4, false, true),
  ('Spraying and finishing', 5, false, true),
  ('Cabinet reassembly', 6, true, false),
  ('Edgebanding', 7, false, true),
  ('Timber machining', 8, false, true),
  ('Production prep', 9, false, true),
  ('Remakes and fix-ups', 10, true, false),
  ('Delivery and logistics', 11, false, false),
  ('Design and admin', 12, false, false);
