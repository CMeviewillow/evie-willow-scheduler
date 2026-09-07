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

export type A4ImportStatus = "parsed" | "reviewed" | "applied";

export interface A4Import {
  id: string;
  job_id: string;
  room_id: string;
  filename: string;
  imported_by: string;
  imported_at: string;
  raw_text: string | null;
  cabinet_count: number | null;
  status: A4ImportStatus;
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
