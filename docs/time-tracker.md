# Time tracker — phase 1

Replaces Clockify for job costing. Time will land against structured job, room,
cabinet, cabinet type, stage and person IDs instead of free text task strings.

Phase 1 is schema only: the tables, the master cabinet type list, and the
guard rails that make the later phases safe to build on. Phase 2 (the
Production-file import screen) and phase 3 (clock on/off on the floor board)
are separate, later branches. Migrations 0013–0015 are a second round of
schema groundwork, added once the floor board's own "This week" plan
surfaced a real need: Harry/Jon need to be able to replace an auto-computed
target with the real one, and the natural next step is having clocking data
feed that target directly instead of a manual number. See each of those
migrations, and the sections below, for what real job files (DA1277 Anna
Reid) actually confirmed once checked, several times correcting what phase 1
had assumed.

## The core idea

**Cabinets are identified and typed in the office before the job reaches the
workshop, never on the floor.** The job's **A3** "Production" file has a
clean per-room table — `Item # | Part No./Description | Width | Height |
Depth` — that's the reliable source for cabinet identity. (Phase 1's
original assumption was the **A4** file; a real sample proved that wrong —
the A4 is a multi-page-per-cabinet manufacturing cutlist, frame/door/drawer
detail useful later for costing, not a flat list, and much harder to parse
reliably. Both files exist per room; import from the A3.) Phase 2 will let
Abi import and review it at job release. By the time it's on the floor
board, a cabinet already reads `#7 Base 3 Drawers 60` — nobody on the floor
ever picks or types a cabinet type.

Decimal numbers in the A3 table (`#14`, `#14.1`) are usually real, distinct
components — **except** anything with "Skirting" in its description
(`Base ShP Skirting`, `Base DBL ShP Skirting RH`), which is an end panel
with a skirting-attachment strip built in for site fitting, not a real
cabinet at all. The importer must skip these rows outright — see "Skirting
and cornice" below for what they actually mean.

## Tables

Migrations live in `supabase/migrations/`, numbered, and are meant to be
reviewed before being run against the live database — nothing here has been
executed yet.

| # | Table | What it's for |
|---|-------|----------------|
| 0001 | `people` | The team. Leavers are set `active = false`, never deleted — history stays intact and they drop off the board. Seeded with the current team list. |
| 0002 | `person_aliases` | Every Clockify name variant maps to one person row, so imported history pools correctly after a rename. Small admin screen at `?admin=aliases`. |
| 0003 | `jobs` | `da_number`, client, and a status ladder: `quoted → setup → released → in_production → delivered → complete`. `setup` means a Production import is under way; `released` means every cabinet on the job has a type. |
| 0004 | `rooms` | Cabinet numbering restarts per room (`Kitchen`, `Utility`, ...), so cabinet numbers are only unique within a room. |
| 0005 | `cabinet_types` | The master list — the thing that makes cross-job pooling possible. Only ever created via the phase 2 import review screen or an admin screen, both office-side. Anything created during an import is flagged `needs_office_review`. |
| 0006 | `stages` | The 14 production stages, confirmed against a real Clockify export (see "Frame and Door manufacture" below) — `Frame manufacture`, `Door manufacture`, `Drawer manufacture` and `Skirting and cornice manufacture` are real categories the office already uses, none of them cabinet-specific. `is_cabinet_stage` (`Cabinet bench`, `Cabinet reassembly`, `Remakes and fix-ups`) drives whether the floor board asks which cabinet a timer is against; `tracks_quantity` (added in 0013) marks Frame/Door manufacture as needing a completed-count when clocking off. |
| 0007 | `production_imports` | One row per Production-schedule import attempt (phase 2 writes here). Keeps the raw extracted text so a parse can be re-run without asking for the file again. Named source-agnostically, not `a4_imports` — see "The core idea" above. |
| 0008 | `cabinets` | One row per physical cabinet. `cabinet_type_id` is nullable at import, required before the job can release. Decimal numbers (`#14`, `#14.1`) are real, distinct components — confirmed against a real Cabinet Vision export — not a typo or a duplicate. Rows with "Skirting" in the description are never created here — see "Skirting and cornice" below. |
| 0009 | `time_entries` | The actual clock on/off records. See concurrency rules below. `quantity_completed` (added in 0013) is required when stopping a `tracks_quantity` stage. |
| 0010 | `cabinet_stage_totals` (view) | Rolls `time_entries` up per cabinet/stage into both labour minutes and elapsed minutes, for costing and capacity respectively. |
| 0011 | job release guard (trigger) | Blocks `jobs.status` moving to `released` while any cabinet on the job still has `cabinet_type_id = null`. Enforced in the database, not just the UI. |
| 0012 | RLS (phase 1 tables) | Enables row level security on every phase 1 table with a permissive allow-all policy, matching how the existing `kv_store` table already runs (anon key, no `auth.*` calls anywhere in the app). See "Auth" below. Tables added after this migration enable their own RLS inline instead (0014–0015), since they don't exist yet when this one runs. |
| 0013 | `tracks_quantity`, `time_entries.quantity_completed`, `frame_door_progress_by_day` (view) | How many cabinets' worth of frames/doors are done per job/room/day, and the smaller of the two — see "Frame and Door manufacture" below. |
| 0014 | `room_extras` | Skirting/cornice linear metreage, per room — see "Skirting and cornice" below. |
| 0015 | `cabinet_accessories` | Spec Sheet-sourced bought-in extras (dividers, racks, inserts, bins) — see "Spec Sheet extras" below. |

## Concurrency rules

- **One cabinet per timer.** A running entry is always against exactly one
  cabinet when the stage is a cabinet stage. No batching, no splitting
  minutes across cabinets.
- **Multiple people may work the same cabinet at once** — two people on one
  island is normal. There's a partial unique index stopping one *person*
  from having two running timers (`person_id where stopped_at is null`), but
  deliberately no constraint on how many people can run against the same
  cabinet.
- This means cabinet totals are **labour minutes**, not elapsed time — two
  people for two hours is four labour hours. That already matches how the
  existing benchmark library was built from Clockify, so no conversion is
  needed. `cabinet_stage_totals` exposes both labour and elapsed minutes,
  because the scheduler needs elapsed span for capacity while costing needs
  labour minutes.

## Remedials

A remedial coming back from site is logged the same way as any other cabinet
time, just against the `Remakes and fix-ups` stage instead of `Cabinet bench`
or `Cabinet reassembly` — so it never dilutes the normal production rate for
that cabinet type. Two things make that work:

- `Remakes and fix-ups` is a cabinet stage (`is_cabinet_stage = true`), so
  the floor board always asks which cabinet the remedial is against, the
  same as bench/reassembly. Loose, un-attributed remedial hours were the
  alternative and were deliberately ruled out — pinning it to a cabinet
  means the office can later see which cabinet or type comes back for
  rework most often.
- The floor board's job picker isn't limited to `released`/`in_production`
  jobs — any released job stays selectable regardless of `status`, since a
  remedial can land months after a job shows `delivered` or `complete`.

## Frame and Door manufacture

An earlier version of this doc had a `Bench prep` cabinet stage with a
frame/door split per cabinet (a frame tap + a door tap = one cabinet done,
each worth half). **A real Clockify export proved that wrong.** Checked
every task category in a full-year detailed report (Helen & Alex
Siviter-Platts, DA1198): `Frame manufacture and assembly`, `Door
manufacture and assembly` and `Drawer Box manufacture and assembly` never
once carry a cabinet number in real history — they're batch work, someone
spends a session making a batch of frames or doors, not "frame for #7".
Every `Cabinet bench` and `Cabinet reassembly` entry, by contrast, always
does (`A4s Bench # 7`, `A4s Reassembly # 27`) — confirming `Cabinet bench`
was already correctly modelled from day one (plain `is_cabinet_stage`, no
parts); the mistake was inventing a parts-model for the wrong stage.

What's real instead: `Frame manufacture` and `Door manufacture` are plain
overhead stages like CNC, but each is `tracks_quantity = true` — clocking
off asks "how many did you complete" (mirrors the floor board's existing
Drawers-tab pattern of a label + a count, just per session instead of per
batch-label). The point of counting at all: a cabinet still isn't ready
for Cabinet bench until **both** its frame and its door exist, so the
"half each" idea from the original ask survives — it's just applied **per
day**, not per cabinet-tap. If today's frame batch finishes 9 units and
today's door batch finishes 9 units, that's 9 cabinets' worth of both,
ready for bench; if frames only reach 5, only 5 are genuinely ready
regardless of how many doors exist. `frame_door_progress_by_day` (0013,
per job/room/day) exposes the frame total, the door total, and
`cabinets_ready_for_bench` (the smaller of the two) — separately, not
blended into one number, since a lopsided day (doors way ahead of frames)
should stay visible, not hidden.

`Drawer manufacture` (renamed from `Drawer making` to match the real
Clockify label) and `Skirting and cornice manufacture` (new, also
confirmed from the same export) are plain time-tracked overhead stages —
no quantity, no cabinet. Skirting/cornice specifically: `room_extras`
(0014) already holds the *material* side (linear metres to order); this
stage is the *labour* side (time spent manufacturing/fitting it) — related
concepts, deliberately separate tables. The floor board's existing
"Drawers" tab (Harry's daily batch counts by label + quantity) stays
exactly as it is regardless — it's a separate, real-time
production-visibility tool with no person or precise time on a count to
derive labour minutes from, so it runs alongside `Drawer manufacture`
rather than feeding it.

Cutlery/utensil dividers built into a drawer are **not** their own line —
confirmed against a real cutlist that a divider that's genuinely built (not
bought-in, see "Spec Sheet extras" below) is absorbed into its host drawer's
own cutlist with no distinct schedule line of its own.

## Skirting and cornice

**Not cabinets, not itemized per-cabinet at all.** Confirmed against a real
job (DA1277 Anna Reid, cross-checked against the office's own hand-worked
figures and landing within a few percent): skirting and cornice are a
continuous run, ordered/cut in linear metres for the whole room.
`room_extras` (0014) holds that figure, one row per room per kind.

The Spec Sheet's own skirting/cornice fields (e.g. "0m") mean **extra
required beyond standard coverage**, not the total — don't read them as the
metreage figure directly.

A figure can be derived from the room's A3 item table plus its drawing/
installer notes:

- **Skirting** = the front (width) of every floor-sitting cabinet, **plus**
  the depth of any side that's genuinely exposed rather than meeting a wall
  or returning into another cabinet (a "breakfront"). The drawing's own
  installer notes are the tell: a side finished in a decorative "shaker
  panel" (as opposed to a plain "frame") that's noted as scribed to a wall
  is an exposed end needing skirting; a panel explicitly noted as running
  into another cabinet number is an internal return, not exposed, and
  doesn't count. An island's panels/posts are called out as needing scribe
  "to floor" on every side, since nothing around it is a wall.
- **Cornice** = the front (and any exposed side, same rule as skirting) of:
  any cabinet taller than 1800mm, any cabinet whose description is literally
  `Counter Top ...`, and any wall cabinet (this job had none — only
  "Floating Wall Shelf" items, which do **not** count; confirm per job
  whether "wall cabinet" means something present).
- The `...ShP Skirting...` items excluded from `cabinets` (see "The core
  idea") are exactly the exposed island-end panels — their own real
  dimensions (not a standard cabinet's depth column) are the true skirting
  run for that end, and need including in the total, not skipping just
  because the panel itself isn't imported as a cabinet.

Reading "exposed vs. joined" off drawing notes is a real judgement call, not
a mechanical parse — `room_extras.needs_office_review` defaults `true` for
exactly this reason. A calculated figure is always a starting point for the
office to confirm, never applied to an order automatically — same posture as
`cabinet_types.needs_office_review`.

## Spec Sheet extras

Cutlery dividers, utensil dividers, spice rack inserts, veg crates, bins,
and similar **bought-in** accessories are called out on the **Spec Sheet
only** — never on the Production file (A3 or A4). Confirmed against a real
cutlist that a divider actually built by the bench has no distinct schedule
line of its own (see "Frame and Door manufacture" above), so these carry no bench time —
`cabinet_accessories` (0015) is a plain ordered/fitted checklist, not
another time-tracked stage.

Not every job has any of these, and the Spec Sheet sometimes leaves the
cabinet undecided ("TBC") — `cabinet_id` is nullable for exactly that case,
a real and common one, not an import error.

**Sense-check, don't just import:** spice racks, chopping boards and trays
are a different case from dividers — they're a full standalone build (CNC →
bench → paint shop), get their own numbered item in the A3 table exactly
like a cabinet (e.g. `#6 — Base 2 Oak Chopping Boards + 1 Oak Tray` in the
Anna Reid job), and belong in `cabinets`/`cabinet_types`, not
`cabinet_accessories`. But they're *also* usually mentioned on the Spec
Sheet. The phase 2 review screen should surface both sources side by side
for these: a Spec Sheet mention with no matching A3 item (or the reverse) is
worth a human double-check before the import is applied, not a silent
pass-through.

## Auth

`src/storage.js` calls `createClient` with just the anon key and never calls
any `supabase.auth.*` method, so the existing `kv_store` table runs on
permissive RLS today. The new tables match that exactly — RLS is enabled but
every policy is `using (true) with check (true)`. That's not real access
control: anyone with the anon key can read and write everything. Proper auth
(per-role policies, PIN-gated writes from the floor board) is a `TODO` in
`0012_rls.sql`, out of scope for this branch.

## TypeScript types

`src/timetracker/types.ts` exports one interface per table plus the
`cabinet_stage_totals` and `frame_door_progress_by_day` views, all from a
single file. Note this repo has no TypeScript build step (Vite + plain
`.jsx`, no `tsconfig.json`) — these types aren't checked against any
consuming code yet. They're the source of truth for the schema's shape
ahead of phases 2 and 3.

## Extending the cabinet type master list

The seeded list (`0005_cabinet_types.sql`) is a deliberate starting point —
the 12 types confirmed in the benchmark library, plus 7 more that don't
carry reassembly time (panels, housings, ship-out units). It's nowhere near
the full range Cabinet Vision produces.

Naming convention: `PD` means Pair of Doors, `SD` means Single Door, and a
trailing number is the width in cm — so `Tall PD 120` is a tall cabinet with
a pair of doors, 120cm wide.

New types get added two ways, both office-side: through the phase 2 import
review screen (when a cabinet's description doesn't match anything in the
list) or through an admin screen. Either way the new row is flagged
`needs_office_review = true` so the list can't drift silently — nobody
should end up with two near-duplicate type names because a match wasn't
found.

`category` on the seeded rows is a first guess from the name alone, not
verified against real drawings beyond the one sample file used to build
phase 1 — the office should correct any that are wrong.

## What's not here yet

- Phase 2: the A3 Production-file PDF importer, description-to-type
  matching, the skirting/cornice calculation surfaced for office review, the
  Spec Sheet extras cross-check, and the review screen Abi uses before
  releasing a job.
- Phase 3: clock on/off on the floor board, the "how many did you
  complete" prompt that writes `time_entries.quantity_completed` when
  stopping a Frame/Door manufacture session, the live-timer view, break
  deduction, the runaway-timer auto-close cron, and the manual-edit review
  queue.
- Wiring the floor board's "This week" plan to read
  `frame_door_progress_by_day` (and `cabinet_stage_totals` for Cabinet
  bench/reassembly) instead of (or alongside) its current auto-computed
  suggestion — the actual point of all of this, still ahead once phases 2
  and 3 exist.
- Reporting views and the quoting tool — planned for a later branch, after
  phases 2 and 3.
