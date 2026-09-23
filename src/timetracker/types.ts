// Time tracker, phase 1: types for every table, in one place.
//
// This repo has no TypeScript build step (Vite + plain .jsx, no
// tsconfig) — these types aren't type-checked against any consuming
// code yet. They exist as the single source of truth for the schema's
// shape ahead of phases 2 and 3, and for editor autocomplete in the
// meantime.

export interface Person {
  id: string;
  name: string;
  active: boolean;
  pin: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonAlias {
  id: string;
  person_id: string;
  alias: string;
  created_at: string;
  updated_at: string;
}

export type JobStatus =
  | "quoted"
  | "setup"
  | "released"
  | "in_production"
  | "delivered"
  | "complete";

export interface Job {
  id: string;
  da_number: string;
  client_name: string;
  status: JobStatus;
  delivery_date: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Room {
  id: string;
  job_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type CabinetTypeCategory =
  | "base"
  | "tall"
  | "wall"
  | "island"
  | "counter_top"
  | "housing"
  | "panel"
  | "component"
  | "other";

export interface CabinetType {
  id: string;
  name: string;
  category: CabinetTypeCategory;
  carries_reassembly: boolean;
  needs_office_review: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Cabinet {
  id: string;
  room_id: string;
  cabinet_number: number;
  cabinet_type_id: string | null;
  raw_description: string | null;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Stage {
  id: string;
  name: string;
  sort_order: number;
  is_cabinet_stage: boolean;
  is_overhead: boolean;
  tracks_quantity: boolean;
  created_at: string;
  updated_at: string;
}

export type TimeEntrySource = "board" | "manual" | "auto_closed" | "imported";

export interface TimeEntry {
  id: string;
  person_id: string;
  job_id: string;
  room_id: string | null;
  cabinet_id: string | null;
  stage_id: string;
  // Required once stopped_at is set, for a tracks_quantity stage (Frame
  // manufacture, Door manufacture) — "how many did you complete" this
  // session. Null for every other stage.
  quantity_completed: number | null;
  started_at: string;
  stopped_at: string | null;
  break_minutes_deducted: number;
  net_minutes: number | null;
  source: TimeEntrySource;
  needs_review: boolean;
  review_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ProductionImportStatus = "parsed" | "reviewed" | "applied";

// The job's "Production" file — confirmed against a real job (DA1277
// Anna Reid) that the reliable per-cabinet table actually lives on the
// A3, not the A4 (a per-cabinet manufacturing cutlist, not needed for
// cabinet identity) — see docs/time-tracker.md. Named source-agnostically
// rather than "A4Import" so a future format change doesn't repeat that
// mistake.
export interface ProductionImport {
  id: string;
  job_id: string;
  room_id: string;
  filename: string;
  imported_by: string;
  imported_at: string;
  raw_text: string | null;
  cabinet_count: number | null;
  status: ProductionImportStatus;
  created_at: string;
  updated_at: string;
}

export interface CabinetStageTotals {
  cabinet_id: string;
  stage_id: string;
  labour_minutes: number | null;
  elapsed_minutes: number | null;
  distinct_people: number;
  session_count: number;
}

// What the floor board would read for Frame/Door manufacture: how many
// cabinets' worth of each are done for a job/room/day, and the smaller
// of the two — the number genuinely ready for Cabinet bench, since a
// cabinet needs both. Backed by the frame_door_progress_by_day view.
// Confirmed against a real Clockify export that frame/door manufacture
// is always batch work, never logged against one specific cabinet — see
// docs/time-tracker.md and 0013_manufacture_quantities.sql.
export interface FrameDoorProgressByDay {
  job_id: string;
  room_id: string | null;
  work_date: string;
  frames_completed: number | null;
  doors_completed: number | null;
  cabinets_ready_for_bench: number;
}

export type RoomExtraKind = "skirting" | "cornice";

// Skirting/cornice — a linear-metreage figure for the whole room, never
// itemized per cabinet (see docs/time-tracker.md for why, and the real
// worked example it's based on). needs_office_review defaults true: a
// calculated figure is always a starting point, never applied to an
// order automatically.
export interface RoomExtra {
  id: string;
  room_id: string;
  kind: RoomExtraKind;
  metres: number;
  source: "calculated" | "manual";
  needs_office_review: boolean;
  calculation_notes: string | null;
  created_at: string;
  updated_at: string;
}

// A bought-in accessory (cutlery divider, spice rack insert, veg crate,
// bin, etc.) called out on the Spec Sheet and loosely tied to a cabinet
// number. Carries no bench time of its own — it's a simple ordered/
// fitted checklist, not a time-tracked stage. cabinet_id is nullable for
// the real, common "TBC" case where the Spec Sheet hasn't settled on a
// cabinet yet.
export interface CabinetAccessory {
  id: string;
  job_id: string;
  cabinet_id: string | null;
  label: string;
  product_code: string | null;
  raw_spec_text: string | null;
  ordered: boolean;
  fitted: boolean;
  created_at: string;
  updated_at: string;
}
