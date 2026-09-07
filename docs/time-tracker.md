# Time tracker — phase 1

Replaces Clockify for job costing. Time will land against structured job, room,
cabinet, cabinet type, stage and person IDs instead of free text task strings.

Phase 1 is schema only: the tables, the master cabinet type list, and the
guard rails that make the later phases safe to build on. Phase 2 (the A4
import screen) and phase 3 (clock on/off on the floor board) are separate,
later branches.

## The core idea

**Cabinets are identified and typed in the office before the job reaches the
workshop, never on the floor.** The A4 production schedule already lists
every cabinet with its number and its Cabinet Vision description, and it
exists before anyone touches timber. Phase 2 will let Abi import and review
it at job release. By the time it's on the floor board, a cabinet already
reads `#7 Base 3 Drawers 60` — nobody on the floor ever picks or types a
cabinet type.

## Tables

Migrations live in `supabase/migrations/`, numbered, and are meant to be
reviewed before being run against the live database — nothing here has been
executed yet.

| # | Table | What it's for |
|---|-------|----------------|
| 0001 | `people` | The team. Leavers are set `active = false`, never deleted — history stays intact and they drop off the board. Seeded with the current team list. |
| 0002 | `person_aliases` | Every Clockify name variant maps to one person row, so imported history pools correctly after a rename. Small admin screen at `?admin=aliases`. |
| 0003 | `jobs` | `da_number`, client, and a status ladder: `quoted → setup → released → in_production → delivered → complete`. `setup` means an A4 import is under way; `released` means every cabinet on the job has a type. |
| 0004 | `rooms` | Cabinet numbering restarts per room (`Kitchen`, `Utility`, ...), so cabinet numbers are only unique within a room. |
| 0005 | `cabinet_types` | The master list — the thing that makes cross-job pooling possible. Only ever created via the phase 2 import review screen or an admin screen, both office-side. Anything created during an import is flagged `needs_office_review`. |
| 0006 | `stages` | The 11 production stages. `is_cabinet_stage` (only `Cabinet bench` and `Cabinet reassembly`) drives whether the floor board asks which cabinet a timer is against. |
| 0007 | `a4_imports` | One row per A4 import attempt (phase 2 writes here). Keeps the raw extracted text so a parse can be re-run without asking for the file again. |
| 0008 | `cabinets` | One row per physical cabinet. `cabinet_type_id` is nullable at import, required before the job can release. Decimal numbers (`#14`, `#14.1`) are real, distinct components — confirmed against a real Cabinet Vision export — not a typo or a duplicate. |
| 0009 | `time_entries` | The actual clock on/off records. See concurrency rules below. |
| 0010 | `cabinet_stage_totals` (view) | Rolls `time_entries` up per cabinet/stage into both labour minutes and elapsed minutes, for costing and capacity respectively. |
| 0011 | job release guard (trigger) | Blocks `jobs.status` moving to `released` while any cabinet on the job still has `cabinet_type_id = null`. Enforced in the database, not just the UI. |
| 0012 | RLS | Enables row level security on every new table with a permissive allow-all policy, matching how the existing `kv_store` table already runs (anon key, no `auth.*` calls anywhere in the app). See "Auth" below. |

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
`cabinet_stage_totals` view, all from a single file. Note this repo has no
TypeScript build step (Vite + plain `.jsx`, no `tsconfig.json`) — these
types aren't checked against any consuming code yet. They're the source of
truth for the schema's shape ahead of phases 2 and 3.

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

- Phase 2: the A4 PDF/ZIP importer, description-to-type matching, and the
  review screen Abi uses before releasing a job.
- Phase 3: clock on/off on the floor board, the live-timer view, break
  deduction, the runaway-timer auto-close cron, and the manual-edit review
  queue.
- Reporting views and the quoting tool — planned for a later branch, after
  phases 2 and 3.
