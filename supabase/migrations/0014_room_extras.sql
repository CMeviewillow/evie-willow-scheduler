-- Time tracker: room_extras (skirting, cornice)
--
-- Skirting and cornice are NOT cabinets — confirmed against a real job
-- (DA1277 Anna Reid): they're a continuous run, ordered/cut in linear
-- metres for the whole room, not itemized per numbered item. The A3
-- schedule's "...ShP Skirting..." items are a different thing (see
-- 0008_cabinets.sql) and are excluded from cabinets entirely.
--
-- A figure can be derived from the room's item list plus its drawing
-- notes (front of every floor-sitting cabinet, plus any side that's
-- genuinely exposed rather than meeting a wall or another cabinet, for
-- skirting; tall cabinets over 1800mm plus counter-top cabinets plus
-- wall cabinets, for cornice) — validated against Anna Reid's real
-- figures and landed within a few percent by hand. But reading "exposed
-- vs joined" off drawing notes is a real judgement call, not a
-- mechanical parse, so this is always a starting figure for the office
-- to confirm, never applied to an order automatically — same posture as
-- cabinet_types.needs_office_review.

create table if not exists room_extras (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id),
  kind text not null check (kind in ('skirting', 'cornice')),
  metres numeric not null,
  source text not null default 'calculated' check (source in ('calculated', 'manual')),
  needs_office_review boolean not null default true,
  calculation_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_room_extras_room_id on room_extras (room_id);

-- RLS: matches every other table's permissive anon-key policy — see
-- 0012_rls.sql for why. Enabled here, not there, since this table is
-- created after 0012 runs.
alter table room_extras enable row level security;
create policy "allow all - room_extras" on room_extras for all using (true) with check (true);
