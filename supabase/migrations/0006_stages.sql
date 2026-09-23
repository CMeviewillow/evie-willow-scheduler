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
-- Frame manufacture, Door manufacture, Drawer manufacture and Skirting
-- and cornice manufacture are confirmed against a real Clockify export
-- (Helen & Alex Siviter-Platts, DA1198) as the office's actual categories
-- — none of them ever carry a cabinet number in real history, unlike
-- every Bench/Reassembly entry, which always does ("A4s Bench # 7",
-- "A4s Reassembly # 27"). A frame or door is manufactured in a batch,
-- not against one specific cabinet, and only becomes cabinet-specific at
-- the "Bench # N" assembly step — Cabinet bench, already correctly a
-- plain per-cabinet stage with no parts. An earlier version of this
-- migration invented a "Bench prep" cabinet stage with a frame/door
-- split per cabinet; that never matched real practice and has been
-- removed (see 0013_manufacture_quantities.sql for what replaced it —
-- a per-day quantity on Frame/Door manufacture instead).
--
-- tracks_quantity (see 0013) marks Frame manufacture and Door
-- manufacture specifically: clocking off asks "how many did you
-- complete", since that count is what lets the floor board work out how
-- many cabinets' worth of frames/doors are ready for Cabinet bench today
-- — each one is worth half a cabinet, the same day's cabinets need both.

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
  ('Frame manufacture', 2, false, true),
  ('Door manufacture', 3, false, true),
  ('Cabinet bench', 4, true, false),
  ('Drawer manufacture', 5, false, true),
  ('Skirting and cornice manufacture', 6, false, true),
  ('Spraying and finishing', 7, false, true),
  ('Cabinet reassembly', 8, true, false),
  ('Edgebanding', 9, false, true),
  ('Timber machining', 10, false, true),
  ('Production prep', 11, false, true),
  ('Remakes and fix-ups', 12, true, false),
  ('Delivery and logistics', 13, false, false),
  ('Design and admin', 14, false, false);
