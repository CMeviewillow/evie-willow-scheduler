-- Time tracker: cabinet_accessories
--
-- Bought-in accessories called out on the Spec Sheet and loosely tied to
-- a cabinet number — cutlery/utensil dividers, spice racks, veg crates,
-- bins, and similar. Confirmed against a real job's cutlist that a
-- divider that IS actually built (timber, cut on the bench) is absorbed
-- into its host drawer's own cutlist with no separate schedule line —
-- there is no standalone "Cutlery Divider" part. So these carry no bench
-- time of their own and this is a simple ordered/fitted checklist, not a
-- time-tracked stage. Not every job has any of these; where a job's Spec
-- Sheet mentions none, no rows exist for it.
--
-- The Spec Sheet is also the ONLY source for these — nothing in the
-- Production file (A3 or A4) mentions them. Presence there should also
-- get sense-checked against the same job's numbered items during import
-- review: chopping boards, trays and spice racks in particular tend to
-- appear on BOTH the Spec Sheet and as their own numbered item in the
-- Production schedule (their own full CNC → bench → paint shop build,
-- same as any cabinet — see cabinets/cabinet_types), so a Spec Sheet
-- mention with no matching Production item (or vice versa) is worth a
-- human double-check, not a silent import.
--
-- cabinet_id is nullable because the Spec Sheet sometimes leaves the
-- cabinet undecided at spec stage ("TBC") — a real, common case, not an
-- import error; the office resolves it once the design settles.
-- raw_spec_text is kept verbatim, same reasoning as cabinets.raw_description.

create table if not exists cabinet_accessories (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  cabinet_id uuid references cabinets(id),
  label text not null,
  product_code text,
  raw_spec_text text,
  ordered boolean not null default false,
  fitted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cabinet_accessories_job_id on cabinet_accessories (job_id);
create index if not exists idx_cabinet_accessories_cabinet_id on cabinet_accessories (cabinet_id);

-- RLS: matches every other table's permissive anon-key policy — see
-- 0012_rls.sql for why. Enabled here, not there, since this table is
-- created after 0012 runs.
alter table cabinet_accessories enable row level security;
create policy "allow all - cabinet_accessories" on cabinet_accessories for all using (true) with check (true);
