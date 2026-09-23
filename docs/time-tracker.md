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
| 0006 | `stages` | The 12 production stages (including `Drawer making`, its own overhead stage — see "Bench prep: frame and door" below for why it's not a cabinet stage). `is_cabinet_stage` (`Bench prep`, `Cabinet bench`, `Cabinet reassembly`, `Remakes and fix-ups`) drives whether the floor board asks which cabinet a timer is against; `has_parts` (added in 0013) narrows that further for Bench prep. |
| 0007 | `production_imports` | One row per Production-schedule import attempt (phase 2 writes here). Keeps the raw extracted text so a parse can be re-run without asking for the file again. Named source-agnostically, not `a4_imports` — see "The core idea" above. |
| 0008 | `cabinets` | One row per physical cabinet. `cabinet_type_id` is nullable at import, required before the job can release. Decimal numbers (`#14`, `#14.1`) are real, distinct components — confirmed against a real Cabinet Vision export — not a typo or a duplicate. Rows with "Skirting" in the description are never created here — see "Skirting and cornice" below. |
| 0009 | `time_entries` | The actual clock on/off records. See concurrency rules below. `part` (added in 0013) is required exactly when the stage `has_parts`. |
| 0010 | `cabinet_stage_totals` (view) | Rolls `time_entries` up per cabinet/stage into both labour minutes and elapsed minutes, for costing and capacity respectively. |
| 0011 | job release guard (trigger) | Blocks `jobs.status` moving to `released` while any cabinet on the job still has `cabinet_type_id = null`. Enforced in the database, not just the UI. |
| 0012 | RLS (phase 1 tables) | Enables row level security on every phase 1 table with a permissive allow-all policy, matching how the existing `kv_store` table already runs (anon key, no `auth.*` calls anywhere in the app). See "Auth" below. Tables added after this migration enable their own RLS inline instead (0013–0015), since they don't exist yet when this one runs. |
| 0013 | `stage_completions` (+ `has_parts`, `time_entries.part`, `cabinet_stage_progress` view) | The discrete "this is actually done" event that `time_entries` never had — see "Bench prep: frame and door" below. |
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

## Bench prep: frame and door

A cabinet isn't complete at Bench prep until **both its frame and its door**
are done — so unlike Cabinet bench or Cabinet reassembly (where one done
event means the whole cabinet), Bench prep needs two, each worth half.
Drawer making is deliberately **not** a third part here — it's its own
stage (`Drawer making`, `is_overhead = true`), not tied to any cabinet at
all: a drawer box isn't numbered/typed against one specific cabinet the way
a frame or door is. It exists purely so real clocked time can eventually be
costed against it, same as CNC or Edgebanding. The floor board's existing
"Drawers" tab (Harry's daily batch counts by label + quantity) is a
separate, real-time production-visibility tool and stays exactly as it is
— there's no person or precise time on a batch count to derive labour
minutes from, so it runs alongside this stage rather than feeding it.

This also exposed a real gap: `time_entries` only ever recorded continuous
clock-on/clock-off **time**, with no discrete "this is actually done" event
— but the floor board counts finished cabinets, not minutes. `time_entries`
stays exactly as it was (still the source for costing), and
`stage_completions` (0013) is the new, separate discrete event Phase 3's
floor board tap will write to. `stages.has_parts` marks which stages need a
completion row **per part** instead of one for the whole cabinet — today
that's Bench prep only, with exactly `frame`/`door`. `cabinet_stage_progress`
(a view) is what the floor board actually reads: a fraction per cabinet per
stage, `0.5`/`1` for a has-parts stage, `1` for a plain one.

Cutlery/utensil dividers built into a drawer are **not** a separate part —
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
line of its own (see "Bench prep" above), so these carry no bench time —
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
`cabinet_stage_totals` and `cabinet_stage_progress` views, all from a single
file. Note this repo has no TypeScript build step (Vite + plain `.jsx`, no
`tsconfig.json`) — these types aren't checked against any consuming code
yet. They're the source of truth for the schema's shape ahead of phases 2
and 3.

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
- Phase 3: clock on/off on the floor board, the discrete "mark this
  frame/door/cabinet done" tap that writes `stage_completions`, the
  live-timer view, break deduction, the runaway-timer auto-close cron, and
  the manual-edit review queue.
- Wiring the floor board's "This week" plan to read `cabinet_stage_progress`
  instead of (or alongside) its current auto-computed suggestion — the
  actual point of all of this, still ahead once phases 2 and 3 exist.
- Reporting views and the quoting tool — planned for a later branch, after
  phases 2 and 3.
