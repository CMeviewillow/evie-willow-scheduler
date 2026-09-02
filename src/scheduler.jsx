import React, { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Trash2, AlertTriangle, Calendar, Settings, Download, Upload, X, Truck, Undo2, Redo2 } from "lucide-react";
import "./storage.js"; // installs window.storage backed by Supabase

// Read-only mode: append ?readonly=1 to the URL to disable all edits.
const IS_READONLY = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("readonly") === "1";

// Workshop floor board: a wall-mounted touchscreen view reached with
// ?board=1 on the same URL, same pattern as ?readonly=1. No router here — it
// isn't worth adding one for a second view.
const IS_BOARD = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("board") === "1";

// ============================================================
// EVIE WILLOW WORKSHOP SCHEDULER
// ============================================================
// Models the workshop pipeline: Machining -> Bench -> Finishing
// -> Delivery -> Worktop Template -> Worktop Install -> Install
// Uses constraint-based forward scheduling with capacity smoothing
// to detect "bunching" of big jobs.
// ============================================================

// --- Cabinet types and bench rates (cabinets per day) ---
const CABINET_TYPES = {
  painted_shaker: { label: "Painted Shaker", rate: 9, color: "#c9a961" },
  beaded_shaker:  { label: "Beaded Shaker",  rate: 6, color: "#a67c52" },
  oak_shaker:     { label: "Oak Shaker",     rate: 5, color: "#8b6f3f" },
  fluted_reeded:  { label: "Fluted/Reeded",  rate: 4, color: "#6b4f2a" },
};

const STAGE_COLORS = {
  machining:      "#8a9670",  // soft sage
  bench:          "#6e8794",  // muted slate-blue
  finishing:      "#c9a961",  // honey
  reassembly:     "#9c8aaa",  // muted lavender
  install:        "#b88a5c",  // warm tan (overridden by fitter)
  template:       "#9e7a5a",  // warm taupe
  worktop_install:"#a5614f",  // soft terracotta
  final_survey:   "#c89060",  // soft amber
  buffer:         "#a8a094",  // warm grey
};

const STAGE_LABELS = {
  machining:      "Machining",
  bench:          "Bench",
  finishing:      "Finishing",
  reassembly:     "Re-assembly",
  install:        "Cabinet Install (incl. delivery)",
  template:       "Worktop Template",
  worktop_install:"Worktop Install",
  final_survey:   "Final Survey Reminder",
  buffer:         "Buffer / Hold",
};

// Stages the Gantt can drag (change start date) and resize (change duration).
// Drag writes dateField, resize writes daysField — both opt-in overrides on
// the job, empty/0 meaning "auto". One generic pair of Gantt callbacks
// (onStageDrag/onStageResize/onStageReset) looks stage behavior up here
// instead of branching on hardcoded stage names.
// usedField only applies to the three stages that actually run on the
// fractional-day bench/finishing model (machining and install use whole-day
// math, no half-day start position to speak of).
const DRAGGABLE_STAGES = {
  machining:  { dateField: "machiningOverride",  daysField: "machiningDaysOverride" },
  bench:      { dateField: "benchOverride",      daysField: "benchDaysOverride", usedField: "benchOverrideUsed" },
  finishing:  { dateField: "finishingOverride",  daysField: "finishingDaysOverride", usedField: "finishingOverrideUsed" },
  reassembly: { dateField: "reassemblyOverride", daysField: "reassemblyDaysOverride", usedField: "reassemblyOverrideUsed" },
  install:    { dateField: "installOverride",    daysField: "installDaysOverride" },
};

const FITTERS = ["Steve", "Thompson", "Chris"];
const NON_FITTERS = ["Callum"];

// UK bank holidays for 2025-2027 (England & Wales). These are always respected
// by the scheduler. Users can add additional closures via Settings.
const UK_BANK_HOLIDAYS = [
  // 2025
  "2025-01-01", // New Year's Day
  "2025-04-18", // Good Friday
  "2025-04-21", // Easter Monday
  "2025-05-05", // Early May bank holiday
  "2025-05-26", // Spring bank holiday
  "2025-08-25", // Summer bank holiday
  "2025-12-25", // Christmas Day
  "2025-12-26", // Boxing Day
  // 2026
  "2026-01-01", // New Year's Day
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday
  "2026-05-04", // Early May bank holiday
  "2026-05-25", // Spring bank holiday
  "2026-08-31", // Summer bank holiday
  "2026-12-25", // Christmas Day
  "2026-12-28", // Boxing Day substitute (26th is Saturday)
  // 2027
  "2027-01-01", // New Year's Day
  "2027-03-26", // Good Friday
  "2027-03-29", // Easter Monday
  "2027-05-03", // Early May bank holiday
  "2027-05-31", // Spring bank holiday
  "2027-08-30", // Summer bank holiday
  "2027-12-27", // Christmas Day substitute (25th is Saturday)
  "2027-12-28", // Boxing Day substitute (26th is Sunday)
];

// Fitter-specific config: colour for install bars and role
const FITTER_CONFIG = {
  Steve:    { color: "#c97540", role: "lead",    canSolo: true,  order: 1 }, // warm orange
  Thompson: { color: "#c73838", role: "second",  canSolo: true,  order: 2 }, // proper red
  Chris:    { color: "#7a9eaa", role: "support", canSolo: false, order: 3 }, // soft slate-blue
};

// --- Date helpers ---
const MS_DAY = 86400000;
const fmtISO = (d) => {
  // Format as local-time YYYY-MM-DD. Using toISOString() would shift by timezone
  // offset, so during BST a local midnight May 4 would become "2026-05-03".
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const parseISO = (s) => { const d = new Date(s + "T00:00:00"); return d; };
const addDays = (d, n) => {
  // DST-safe: manipulate local date components rather than absolute ms offsets,
  // so crossing DST boundaries doesn't leave us at 23:00 or 01:00.
  const r = new Date(d.getTime());
  r.setDate(r.getDate() + n);
  return r;
};
// Calendar-day difference between two dates, DST-safe (rounds to nearest whole day)
const diffDays = (a, b) => Math.round((a - b) / MS_DAY);
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const dayKey = (d) => fmtISO(d);

// The most recent Monday-6:30am checkpoint at or before `now` — the weekly
// gate for the floor board variance review. Monday itself before 6:30am
// still resolves to the PREVIOUS week's checkpoint, since that week's hasn't
// opened yet.
function mostRecentMondayGate(now) {
  const gate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 30, 0, 0);
  const dow = gate.getDay(); // 0 = Sun
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  gate.setDate(gate.getDate() - daysSinceMonday);
  if (gate > now) gate.setDate(gate.getDate() - 7);
  return gate;
}

// Format a date as dd/mm/yy for UK display.
const fmtUK = (d) => {
  if (!d) return "";
  const date = (typeof d === "string") ? parseISO(d) : d;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const yr = String(date.getFullYear()).slice(2);
  return `${day}/${month}/${yr}`;
};

// Skip weekends and bank holidays when advancing
function nextWorkingDay(d, holidays) {
  let cur = new Date(d.getTime());
  while (isWeekend(cur) || holidays.has(dayKey(cur))) {
    cur = addDays(cur, 1);
  }
  return cur;
}

function workingDaysBetween(start, end, holidays) {
  let count = 0;
  let cur = new Date(start.getTime());
  while (cur < end) {
    if (!isWeekend(cur) && !holidays.has(dayKey(cur))) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

// Generate sequential working days starting from 'start', count of 'n'
function workingDaysSeq(start, n, holidays) {
  const out = [];
  let cur = nextWorkingDay(start, holidays);
  while (out.length < n) {
    out.push(new Date(cur.getTime()));
    cur = addDays(cur, 1);
    cur = nextWorkingDay(cur, holidays);
  }
  return out;
}

// FRACTIONAL-DAY MODEL
// Bench/finishing use continuous fractional-day precision. A position is
// { date: Date, used: number }, where `used` is how much of that day's
// capacity is already consumed (0 up to that day's capacity). A working day
// is Mon-Thu 07:00-16:30 less 1h of breaks = 8.5h ("1.0" of a day); Friday is
// 07:00-11:00 less the 10:00 break = 3.75h, i.e. a day with LESS capacity, not
// a day that gets truncated in half. This lets two different jobs share the
// same day at arbitrary fractions (4 oak cabinets at 0.8 of a day, then 2
// painted cabinets filling the remaining 0.2) instead of rounding a job up to
// the next half-day and leaving the remainder idle.
const FULL_DAY_HOURS = 8.5;
const FRIDAY_DAY_HOURS = 3.75;
const FRIDAY_DAY_FRACTION = FRIDAY_DAY_HOURS / FULL_DAY_HOURS;
const DAY_EPSILON = 1e-9;

// Core scheduling treats Friday as a HALF working day (matching the
// half-day-slot model this app used before the fractional rewrite), not
// Friday's real ~44% hours (fridayAwareCapacity below). Folding the real
// figure into month-spanning date math compounds across the backlog
// (settings.startDate deliberately sits far in the past) into large,
// disruptive drift versus the positions the workshop is used to seeing —
// this keeps core scheduling's calendar positions matching that history.
function dayCapacity(date) {
  return date.getDay() === 5 ? 0.5 : 1;
}

// Friday's REAL capacity (07:00-11:00 minus a break = 3.75 of an 8.5-hour
// day) — used only for the floor board's own day-by-day cabinet breakdown
// (dayLayoutForRatedInterval), never for the core scheduler's date math.
function fridayAwareCapacity(date) {
  return date.getDay() === 5 ? FRIDAY_DAY_FRACTION : 1;
}
// Floating point add/subtract of day-fractions (cabinets/rate) drifts over a
// long chain of jobs — round to a fixed precision after every arithmetic step
// so that drift can't accumulate into a wrong day.
function roundDay(x) {
  return Math.round(x * 1e9) / 1e9;
}

// Snap a position forward onto a valid working day, and roll over to the next
// working day if `used` has already reached (or exceeded) capacity there.
function normalizeToWorkingDay(slot, holidays) {
  let { date, used } = slot;
  const nwd = nextWorkingDay(date, holidays);
  if (dayKey(nwd) !== dayKey(date)) {
    date = nwd;
    used = 0;
  }
  if (used >= dayCapacity(date) - DAY_EPSILON) {
    date = nextWorkingDay(addDays(date, 1), holidays);
    used = 0;
  }
  return { date, used: roundDay(used) };
}

// Snap a position BACKWARD onto a valid working day — used when a desired
// "latest start" lands on a weekend/holiday, where moving earlier is always
// safe (never violates a deadline) but moving later would defeat the point.
function normalizeToWorkingDayBackward(slot, holidays) {
  let { date, used } = slot;
  while (isWeekend(date) || holidays.has(dayKey(date))) {
    date = addDays(date, -1);
    used = 0;
  }
  return { date, used: roundDay(Math.min(used, dayCapacity(date))) };
}

// Advance a fractional cursor forward by `daysToAdvance` days of work,
// skipping weekends/holidays and respecting Friday's reduced capacity.
function advanceFractionalDay(start, daysToAdvance, holidays) {
  let { date, used } = normalizeToWorkingDay(start, holidays);
  let remaining = daysToAdvance;
  while (remaining > DAY_EPSILON) {
    const cap = dayCapacity(date);
    const availableToday = cap - used;
    if (availableToday <= DAY_EPSILON) {
      date = nextWorkingDay(addDays(date, 1), holidays);
      used = 0;
      continue;
    }
    if (remaining <= availableToday + DAY_EPSILON) {
      used = roundDay(used + remaining);
      remaining = 0;
    } else {
      remaining = roundDay(remaining - availableToday);
      date = nextWorkingDay(addDays(date, 1), holidays);
      used = 0;
    }
  }
  return { date, used: roundDay(used) };
}

// Compute the fractional end position from a start, given a duration in days.
function endFromStart(start, days, holidays) {
  return advanceFractionalDay(start, days, holidays);
}

// Retreat a fractional cursor backward by `daysToRetreat` days of work. Exact
// inverse of advanceFractionalDay. Used to find the latest possible start for
// a duration that must END by a given point (just-in-time / backward scheduling).
function retreatFractionalDay(end, daysToRetreat, holidays) {
  let { date, used } = end;
  let remaining = daysToRetreat;
  while (remaining > DAY_EPSILON) {
    if (used <= DAY_EPSILON) {
      date = addDays(date, -1);
      while (isWeekend(date) || holidays.has(dayKey(date))) date = addDays(date, -1);
      used = dayCapacity(date);
      continue;
    }
    if (remaining <= used + DAY_EPSILON) {
      used = roundDay(used - remaining);
      remaining = 0;
    } else {
      remaining = roundDay(remaining - used);
      used = 0;
    }
  }
  // Canonicalize: landing exactly at this day's full capacity is the same
  // instant as the start of the next working day at used=0 — advance never
  // returns the "full capacity" form, so retreat can't either, or the two
  // would compare as different positions for what is really the same instant.
  if (used >= dayCapacity(date) - DAY_EPSILON) {
    date = nextWorkingDay(addDays(date, 1), holidays);
    used = 0;
  }
  return { date, used: roundDay(used) };
}

// Compare two fractional positions: negative if a < b, positive if a > b, 0 if equal.
function compareFractionalSlot(a, b) {
  const dk = a.date.getTime() - b.date.getTime();
  if (dk !== 0) return dk;
  return a.used - b.used;
}

// Get the Monday of the week containing date d, formatted as ISO date string
function getWeekKey(d) {
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  const monday = addDays(d, offset);
  return dayKey(monday);
}

// Format a date as "w/c Mon 4 May" (week-commencing label)
function fmtWeekCommencing(d) {
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  const monday = addDays(d, offset);
  return "w/c " + monday.toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short"
  });
}

// --- Complexity features (preset menu of common extras) ---
// Each feature adds time. 'perCab' adds days × the count entered.
// 'flat' adds a fixed number of days regardless of count.
// You can add as many features to a job as you like.
const COMPLEXITY_FEATURES = {
  stained_internals:  { label: "Stained internals",        type: "perCab", days: 0.5 },
  stained_externals:  { label: "Stained externals",        type: "perCab", days: 0.75 },
  curved_doors:       { label: "Curved doors",             type: "perCab", days: 1.0 },
  glazed_doors:       { label: "Glazed doors",             type: "perCab", days: 0.5 },
  integrated_appl:    { label: "Integrated appliance housing", type: "perCab", days: 0.5 },
  custom_inlay:       { label: "Custom inlay / detailing", type: "perCab", days: 0.75 },
  oversize_island:    { label: "Oversize island",          type: "flat",   days: 2 },
  bespoke_dresser:    { label: "Bespoke dresser",          type: "flat",   days: 2 },
  client_choices_pending: { label: "Awaiting client choices", type: "hold", days: 5 },
  worktop_long_lead:  { label: "Long-lead worktop (stone/special)", type: "templateExtra", days: 7 },
  custom:             { label: "Custom (set days manually)", type: "custom", days: 1 },
};

// --- Job model ---
function newJob() {
  return {
    id: "job_" + Math.random().toString(36).slice(2, 9),
    name: "",
    cabinets: { painted_shaker: 0, beaded_shaker: 0, oak_shaker: 0, fluted_reeded: 0 },
    features: [],            // array of { id, key, count, customDays, customLabel }
    targetInstallWeek: "",   // ISO date for target install start
    installOverride: "",     // ISO date for manual drag-and-drop override (takes priority over target)
    installDaysOverride: 0,  // manual override of install duration (0 = use formula)
    teamInstall: false,      // if true, all 3 fitters on site for this install (rare, e.g. distant jobs needing a hotel)
    secondaryInstaller: "",  // optional second fitter on the same install (empty = solo)
    deliveryDate: "",        // ISO date of when the van delivers (empty = day 1 of install)
    machiningOverride: "",   // ISO date — manual machining start, overrides auto-calc
    machiningDaysOverride: 0,// manual machining duration in days (0 = use auto-calc)
    benchOverride: "",          // ISO date, empty = auto (flows from bench cursor)
    benchDaysOverride: 0,       // days, 0 = auto (from cabinet counts and rates)
    benchOverrideUsed: 0,       // 0 = start of day, 0.5 = half a day in (from dragging to a half-day position)
    finishingOverride: "",
    finishingDaysOverride: 0,
    finishingOverrideUsed: 0,
    reassemblyOverride: "",
    reassemblyDaysOverride: 0,
    reassemblyOverrideUsed: 0,
    installer: "auto",       // "auto" | "Steve" | "Thompson" | "Chris"
    machiningDays: 3,        // default machining duration
    notes: "",
    locked: false,           // if true, scheduler won't move it
    manualStart: "",         // optional manual start date (ISO)
    colour: { name: "", hex: "" }, // paint/finish colour — floor board groups booth runs by this
    boothRunId: "",          // jobs sprayed together to save a colour changeover (see booth-run warnings)
  };
}

// Compute total time impact of features, broken down by where it lands
function featureImpact(features) {
  let perCabExtra = 0;   // adds to bench/finishing (per-cabinet work)
  let flatExtra = 0;     // adds to bench/finishing as a flat amount
  let holdExtra = 0;     // adds hold/wait time at the start
  let templateExtra = 0; // adds to gap between delivery and template
  for (const f of (features || [])) {
    const def = COMPLEXITY_FEATURES[f.key];
    if (!def) continue;
    const days = f.key === "custom" ? (f.customDays || 0) : def.days;
    if (def.type === "perCab") perCabExtra += days * (f.count || 0);
    else if (def.type === "flat") flatExtra += days;
    else if (def.type === "hold") holdExtra += days;
    else if (def.type === "templateExtra") templateExtra += days;
    else if (def.type === "custom") flatExtra += days;
  }
  return { perCabExtra, flatExtra, holdExtra, templateExtra };
}

// Convert cabinet mix into bench-days using each type's own rate.
// Each cabinet type takes (count / rate) days. Mixed jobs add up. Returns the
// true fractional day count — no rounding to a half-day minimum, so a small
// job doesn't force capacity to be wasted rounding it up.
// Core scheduling rounds each job's total bench/finishing/reassembly time up
// to the nearest half day (with a 0.5-day floor), same as before the
// fractional rewrite. The floor board's own day-by-day cabinet breakdown
// (dayLayoutForRatedInterval/cabinetEntriesFor) still works from each style's
// EXACT count and rate, independent of this rounding — so partial-day
// sharing between jobs still displays precisely. Rounding here is about
// keeping the overall schedule's month-spanning positions stable: an exact,
// unrounded total compounds small savings across months of backlog into
// large, disruptive drift versus what the workshop is used to seeing.
function roundToHalf(days) {
  return Math.max(0.5, Math.round(days * 2) / 2);
}
function benchDaysForJob(job) {
  let days = 0;
  for (const [type, count] of Object.entries(job.cabinets)) {
    if (count > 0) days += count / CABINET_TYPES[type].rate;
  }
  const impact = featureImpact(job.features);
  days += impact.perCabExtra;
  return roundToHalf(days);
}

function totalCabinets(job) {
  return Object.values(job.cabinets).reduce((a, b) => a + b, 0);
}

// ============================================================
// DAY LAYOUT
// ============================================================
// The scheduler positions each stage as one interval per job — a start, an
// end, a duration. That can't answer "what's on the bench Tuesday", which is
// the question the floor board asks. The day layout is a by-product of the
// same fractional-day fill used to position bench/finishing: walking each
// job's cabinet mix, style by style, across the calendar produces exactly
// the day-by-day breakdown the board needs, batches included for free (a
// batch is simply whatever landed on one day).
//
// Padding only touches painted finishes — painted shaker and beaded shaker.
// Oak and fluted/reeded pass straight through with no padding days at all.
const PADDED_STYLES = ["painted_shaker", "beaded_shaker"];

// rateScale lets the day layout reflect a job that's been overbooked — extra
// hours/hands thrown at it so it clears faster than the standard rate. 1
// (the default) means the standard rate; computeDayLayout passes a scaled
// value derived from how much smaller a stage's actual (possibly
// benchDaysOverride'd) duration is than its nominal cabinet-math duration.
function cabinetEntriesFor(job, rateScale = 1) {
  return Object.keys(CABINET_TYPES)
    .map(style => ({ style, count: job.cabinets[style] || 0, rate: CABINET_TYPES[style].rate * rateScale }))
    .filter(e => e.count > 0);
}

// Walk a job's cabinet mix, style by style at that style's own rate, across a
// fractional-day interval starting at `startSlot`. Returns
// Map<dateKey, [{style, cabinets}]> — used for bench, finishing and
// reassembly, which all run at real per-style rates and can share a day
// across two different jobs.
function dayLayoutForRatedInterval(startSlot, cabinetEntries, holidays) {
  const byDate = new Map();
  let cursor = normalizeToWorkingDay(startSlot, holidays);
  for (const { style, count, rate } of cabinetEntries) {
    let remaining = count;
    while (remaining > DAY_EPSILON) {
      const availableToday = fridayAwareCapacity(cursor.date) - cursor.used;
      if (availableToday <= DAY_EPSILON) {
        cursor = normalizeToWorkingDay({ date: nextWorkingDay(addDays(cursor.date, 1), holidays), used: 0 }, holidays);
        continue;
      }
      const daysForRemaining = remaining / rate;
      const daysConsumedToday = Math.min(daysForRemaining, availableToday);
      const cabinetsToday = roundDay(daysConsumedToday * rate);
      const k = dayKey(cursor.date);
      if (!byDate.has(k)) byDate.set(k, []);
      byDate.get(k).push({ style, cabinets: cabinetsToday });
      remaining = roundDay(remaining - cabinetsToday);
      cursor = advanceFractionalDay(cursor, daysConsumedToday, holidays);
    }
  }
  return byDate;
}

// Machining has no per-style rate in the domain model — its duration is
// matched to bench days or set by hand, not derived from cabinet counts. So
// its day-by-day breakdown is simpler: divide the job's total cabinets evenly
// across the block's whole days, carrying the same style mix each day.
function dayLayoutForMachining(task, job, holidays) {
  const byDate = new Map();
  const entries = cabinetEntriesFor(job);
  const totalCabs = entries.reduce((a, e) => a + e.count, 0);
  if (totalCabs <= 0 || !task.days) return byDate;
  // task.start is already the first real working day of machining (set by
  // workingDaysSeq in scheduleSingleJob) — walking from it directly, not a
  // day earlier, is what actually lines the CNC/prep display up with the
  // real scheduled dates. The previous -1 here only ever looked right when
  // machining happened to start the day after a weekend/holiday (nextWorkingDay
  // rolling it back to the same date by coincidence); any other start day
  // silently pulled the whole display back one working day.
  const days = workingDaysSeq(task.start, Math.ceil(task.days), holidays);
  const perDayTotal = totalCabs / days.length;
  days.forEach(d => {
    byDate.set(dayKey(d), entries.map(e => ({
      style: e.style,
      cabinets: roundDay(perDayTotal * (e.count / totalCabs)),
    })));
  });
  return byDate;
}

function mixFromEntries(entries) {
  const mix = {};
  (entries || []).forEach(e => { mix[e.style] = roundDay((mix[e.style] || 0) + e.cabinets); });
  return mix;
}

// Build the full day layout: { dateKey: { stage: [{jobId,jobName,batch,cabinets,colour,mix}] } }.
// Machining is split into "cnc" and "prep" for display (prep is the last
// working day, leading into bench, exactly mirroring machining's own 3-day
// lead on bench) and finishing into "spray" and "pad" (pad is whichever
// painted-family cabinets land on a given finishing day) — both splits are
// display-only, the scheduler itself still has one machining stage and one
// finishing stage.
function computeDayLayout(scheduled, holidays) {
  const layout = {};
  const addEntry = (dateKey, stage, entry) => {
    if (!layout[dateKey]) layout[dateKey] = {};
    if (!layout[dateKey][stage]) layout[dateKey][stage] = [];
    layout[dateKey][stage].push(entry);
  };

  scheduled.forEach(job => {
    if (!job.tasks?.length) return;
    if (totalCabinets(job) === 0) return;
    const colour = job.colour || { name: "", hex: "" };
    // A stage whose actual days (task.days, which reflects any
    // benchDaysOverride/finishingDaysOverride/reassemblyDaysOverride) is
    // smaller than its nominal cabinet-math days has been overbooked — extra
    // hours/hands thrown at it to clear faster than the standard rate. Scale
    // that stage's own day-layout rate up to match, so the floor board's
    // cabinets/day reflects the actual pace rather than the standard one.
    // Unoverridden stages have task.days === nominal, so scale is exactly 1.
    const nominalBenchDays = benchDaysForJob(job);
    const nominalFinishDays = nominalBenchDays + featureImpact(job.features).flatExtra;

    const benchTask = job.tasks.find(t => t.stage === "bench");
    if (benchTask?.startSlot) {
      const benchScale = benchTask.days > 0 ? nominalBenchDays / benchTask.days : 1;
      const dl = dayLayoutForRatedInterval(benchTask.startSlot, cabinetEntriesFor(job, benchScale), holidays);
      let batch = 0;
      [...dl.keys()].sort().forEach(k => {
        batch++;
        const dayEntries = dl.get(k);
        const cabinets = Math.round(dayEntries.reduce((a, e) => a + e.cabinets, 0));
        if (cabinets > 0) addEntry(k, "bench", { jobId: job.id, jobName: job.name, batch, cabinets, colour, mix: mixFromEntries(dayEntries) });
      });
    }

    const machTask = job.tasks.find(t => t.stage === "machining");
    if (machTask) {
      const mdl = dayLayoutForMachining(machTask, job, holidays);
      const keys = [...mdl.keys()].sort();
      keys.forEach((k, i) => {
        const isPrep = i === keys.length - 1; // last day leads into bench, umbrella'd under machining
        const dayEntries = mdl.get(k);
        const cabinets = Math.round(dayEntries.reduce((a, e) => a + e.cabinets, 0));
        if (cabinets > 0) addEntry(k, isPrep ? "prep" : "cnc", { jobId: job.id, jobName: job.name, batch: i + 1, cabinets, colour, mix: mixFromEntries(dayEntries) });
      });
    }

    const finishTask = job.tasks.find(t => t.stage === "finishing");
    if (finishTask?.startSlot) {
      const finishScale = finishTask.days > 0 ? nominalFinishDays / finishTask.days : 1;
      const fdl = dayLayoutForRatedInterval(finishTask.startSlot, cabinetEntriesFor(job, finishScale), holidays);
      let batch = 0;
      [...fdl.keys()].sort().forEach(k => {
        batch++;
        const dayEntries = fdl.get(k);
        const padEntries = dayEntries.filter(e => PADDED_STYLES.includes(e.style));
        const sprayCabinets = Math.round(dayEntries.reduce((a, e) => a + e.cabinets, 0));
        const padCabinets = Math.round(padEntries.reduce((a, e) => a + e.cabinets, 0));
        if (sprayCabinets > 0) addEntry(k, "spray", { jobId: job.id, jobName: job.name, batch, cabinets: sprayCabinets, colour, mix: mixFromEntries(dayEntries) });
        if (padCabinets > 0) addEntry(k, "pad", { jobId: job.id, jobName: job.name, batch, cabinets: padCabinets, colour, mix: mixFromEntries(padEntries) });
      });
    }

    const reasmTask = job.tasks.find(t => t.stage === "reassembly");
    if (reasmTask?.startSlot) {
      const reasmScale = reasmTask.days > 0 ? nominalBenchDays / reasmTask.days : 1;
      const rdl = dayLayoutForRatedInterval(reasmTask.startSlot, cabinetEntriesFor(job, reasmScale), holidays);
      let batch = 0;
      [...rdl.keys()].sort().forEach(k => {
        batch++;
        const dayEntries = rdl.get(k);
        const cabinets = Math.round(dayEntries.reduce((a, e) => a + e.cabinets, 0));
        if (cabinets > 0) addEntry(k, "reasm", { jobId: job.id, jobName: job.name, batch, cabinets, colour, mix: mixFromEntries(dayEntries) });
      });
    }
  });

  return layout;
}

// Extract customer name from a job name by stripping common trailing room-name suffixes.
// "Smith Kitchen" → "Smith", "Cromwell House Living Room" → "Cromwell House", "Belchamber" → "Belchamber"
const ROOM_SUFFIXES = [
  "kitchen", "utility", "living room", "laundry", "bathroom", "bathrooms",
  "dressing room", "pantry", "boot room", "boot-room", "wet room",
];
function customerFromJobName(name) {
  if (!name) return "";
  let n = name.trim();
  const lower = n.toLowerCase();
  for (const suffix of ROOM_SUFFIXES) {
    if (lower.endsWith(" " + suffix)) {
      return n.slice(0, n.length - suffix.length - 1).trim();
    }
  }
  return n;
}

// Compute install days from total cabinet count using a tiered rule.
// ≤20 cabs = 4 days, 21-27 = 5 days, 28-33 = 6 days, 34+ = 7 days.
// Matches real-world fit timings better than a linear formula.
function installDaysForCabinets(totalCabs) {
  if (totalCabs <= 0) return 0.5;
  if (totalCabs <= 20) return 4;
  if (totalCabs <= 27) return 5;
  if (totalCabs <= 33) return 6;
  return 7;
}

// Determine the dominant type for a job (for finishing rate)
function dominantType(job) {
  let best = "painted_shaker", bestCount = -1;
  for (const [t, c] of Object.entries(job.cabinets)) {
    if (c > bestCount) { bestCount = c; best = t; }
  }
  return best;
}

// Find the earliest date from 'earliest' onwards where 'fitter' has a continuous
// block of 'days' working days with no existing install booking.
// Check if a fitter has any holiday that overlaps the given date range [start, end).
// fitterHolidays is an array of { fitter, start, end } where dates are ISO strings.
function fitterOnHolidayDuring(fitter, start, end, fitterHolidays) {
  if (!fitterHolidays || fitterHolidays.length === 0) return null;
  for (const h of fitterHolidays) {
    if (h.fitter !== fitter) continue;
    const hStart = parseISO(h.start);
    const hEnd = addDays(parseISO(h.end), 1); // h.end is inclusive
    if (start < hEnd && end > hStart) return h;
  }
  return null;
}

// Earliest date a fitter is actually free to take this on — used to pick the
// best available fitter when auto-assigning, and to find an alternative when
// the chosen one is on holiday. Still avoids existing bookings here: that's
// load-balancing between fitters (a good thing, never part of the "rigid"
// complaint), not the collision-blocking that got removed elsewhere. Once a
// fitter+date is actually decided, a clash with it is allowed and just
// produces a warning — see the collision check below where installer is set.
function findEarliestInstallSlot(fitter, earliest, days, state, holidays, fitterHolidays) {
  const sched = state.installerSchedules[fitter] || [];
  let proposedStart = earliest;
  let collision = true;
  let safety = 0;
  while (collision && safety < 100) {
    collision = false;
    const proposedSeq = workingDaysSeq(proposedStart, days, holidays);
    const propEnd = addDays(proposedSeq[proposedSeq.length - 1], 1);
    // Check existing fitter bookings
    for (const booked of sched) {
      if (proposedSeq[0] < booked.end && propEnd > booked.start) {
        collision = true;
        proposedStart = nextWorkingDay(booked.end, holidays);
        break;
      }
    }
    if (collision) { safety++; continue; }
    // Check fitter holidays
    const onHol = fitterOnHolidayDuring(fitter, proposedSeq[0], propEnd, fitterHolidays);
    if (onHol) {
      collision = true;
      proposedStart = nextWorkingDay(addDays(parseISO(onHol.end), 1), holidays);
    }
    safety++;
  }
  return proposedStart;
}

// ============================================================
// OCCUPIED-INTERVAL HELPERS (bench / finishing capacity)
// ============================================================
// Bench and finishing are shared linear resources — only one job can occupy
// a given half-slot. Pinned jobs (benchOverride / finishingOverride) reserve
// a fixed interval; unpinned jobs flow around whatever's already reserved,
// filling gaps rather than just queuing after the last thing scheduled.
// ============================================================

// Do two fractional intervals [aStart,aEnd) and [bStart,bEnd) overlap?
function slotsOverlap(aStart, aEnd, bStart, bEnd) {
  return compareFractionalSlot(aStart, bEnd) < 0 && compareFractionalSlot(bStart, aEnd) < 0;
}

// Compute the fixed {startSlot, endSlot} for a pinned (overridden) interval.
// Pure — depends only on the job's own override fields, never on other jobs'
// state — so pass 1 (pinning) and pass 2 (scheduling) always agree. An
// override date always pins the START of a working day (used: 0) — you can
// pin which day a stage starts, not which fraction of it it starts at.
// usedOverride lets a dragged/pinned override start partway through its day
// (e.g. after lunch) instead of only ever at the start of it — capped to
// that day's own capacity (relevant for Friday, whose capacity is already
// less than a full day) and otherwise passed straight to normalizeToWorkingDay,
// which already knows how to roll over if `used` reaches or exceeds capacity.
function computeOverrideInterval(overrideISO, daysOverride, autoDays, holidays, usedOverride = 0) {
  const parsed = parseISO(overrideISO);
  const normDate = (isWeekend(parsed) || holidays.has(dayKey(parsed)))
    ? nextWorkingDay(parsed, holidays)
    : parsed;
  const cappedUsed = Math.max(0, Math.min(usedOverride || 0, dayCapacity(normDate)));
  const startSlot = normalizeToWorkingDay({ date: normDate, used: cappedUsed }, holidays);
  const days = (daysOverride && daysOverride > 0) ? daysOverride : autoDays;
  const endSlot = advanceFractionalDay(startSlot, days, holidays);
  return { startSlot, endSlot };
}

// Walk forward from afterSlot and return the first position where `daysNeeded`
// days of work fit without overlapping anything in `occupied`
// ([{startSlot, endSlot}, ...]). Generic — reused for both bench and finishing
// capacity, since both are single shared resources with the same "no overlap,
// fill gaps" rule.
function findFreeBenchSlot(afterSlot, daysNeeded, occupied, holidays) {
  let candidate = normalizeToWorkingDay(afterSlot, holidays);
  const sorted = [...occupied].sort((a, b) => compareFractionalSlot(a.startSlot, b.startSlot));
  for (const block of sorted) {
    if (compareFractionalSlot(block.endSlot, candidate) <= 0) continue; // already behind us
    const candidateEnd = advanceFractionalDay(candidate, daysNeeded, holidays);
    if (compareFractionalSlot(candidateEnd, block.startSlot) <= 0) {
      return candidate; // fits entirely before this block
    }
    candidate = normalizeToWorkingDay(block.endSlot, holidays); // jump past it
  }
  return candidate;
}

// Backward mirror of findFreeBenchSlot: walk backward from beforeSlot and
// return the LATEST position at or before it where `daysNeeded` days of work
// fit without overlapping anything in `occupied`. Used to schedule jobs with
// slack "as late as safely possible" instead of "as early as possible", so
// jobs with a distant deadline don't needlessly claim near-term capacity that
// more urgent work could use.
function findLatestFreeBenchSlot(beforeSlot, daysNeeded, occupied, holidays) {
  let candidateStart = normalizeToWorkingDayBackward(beforeSlot, holidays);
  // Descending by end: the block reaching latest into the future is checked
  // first — clearing it also clears any block nested inside its range, and
  // any block starting after it must have an even later end (so it would
  // already have been sorted, and checked, before it).
  const sorted = [...occupied].sort((a, b) => compareFractionalSlot(b.endSlot, a.endSlot));
  for (const block of sorted) {
    const candidateEnd = advanceFractionalDay(candidateStart, daysNeeded, holidays);
    if (compareFractionalSlot(block.startSlot, candidateEnd) >= 0) continue; // entirely ahead of us
    if (compareFractionalSlot(candidateStart, block.endSlot) >= 0) {
      return candidateStart; // fits entirely after this block ends
    }
    // Overlaps — retreat so our window ends exactly when this block starts.
    candidateStart = normalizeToWorkingDayBackward(
      retreatFractionalDay(block.startSlot, daysNeeded, holidays), holidays
    );
  }
  return candidateStart;
}

// ============================================================
// SCHEDULER
// ============================================================
// Forward-schedules all jobs in order, respecting:
//  - bench capacity (1 job at a time on bench, occupies benchDays)
//  - finishing starts day after bench starts, runs same length + flatBuffer
//  - finishing capacity treated as same-rate parallel to bench but offset
//  - hold/buffer days before machining
//  - machining days before bench
//  - delivery 1 day after finishing ends
//  - worktop template 7 working days after delivery
//  - install 1 working day after template (configurable)
//  - installer availability (no double-booking fitters)
//  - bank holidays and weekends
// ============================================================

function scheduleJobs(jobs, holidays, settings) {
  const sorted = [...jobs].sort((a, b) => {
    // Pinned jobs (installOverride or targetInstallWeek) come first as hard
    // commitments. Then manual-start jobs, then flexible jobs.
    const aPin = a.installOverride || a.targetInstallWeek;
    const bPin = b.installOverride || b.targetInstallWeek;
    if (!!aPin !== !!bPin) return aPin ? -1 : 1;
    const aDate = aPin || a.manualStart || "9999-12-31";
    const bDate = bPin || b.manualStart || "9999-12-31";
    return aDate.localeCompare(bDate);
  });

  const state = {
    benchOccupied: [],      // [{startSlot, endSlot, jobName, jobId}] — pinned + placed bench blocks
    finishingOccupied: [],  // same shape, for finishing capacity
    installerSchedules: {},
    installBookings: [],   // [{customer, jobName, start, end, installer, cabCount, weekKey}]
    vanBookings: [],       // [{date, jobName, isSibling}] — 1 van can do 1 delivery per day
  };
  FITTERS.forEach(f => state.installerSchedules[f] = []);

  const scheduled = [];
  const warnings = [];

  // PASS 1: pin every job with a bench/finishing override into the occupied
  // arrays before anything else is scheduled. Pinned jobs are fixed points —
  // unpinned jobs (pass 2) flow tight around them, filling gaps.
  for (const job of sorted) {
    const impact = featureImpact(job.features);
    if (totalCabinets(job) === 0 && impact.holdExtra === 0) continue;
    const nominalBenchDays = benchDaysForJob(job);

    if (job.benchOverride) {
      const interval = computeOverrideInterval(job.benchOverride, job.benchDaysOverride, nominalBenchDays, holidays, job.benchOverrideUsed);
      for (const existing of state.benchOccupied) {
        if (slotsOverlap(interval.startSlot, interval.endSlot, existing.startSlot, existing.endSlot)) {
          warnings.push({
            jobId: job.id,
            jobName: job.name,
            type: "buffer_too_tight",
            message: `Bench pinned to ${fmtUK(interval.startSlot.date)} overlaps ${existing.jobName}'s pinned bench — both left in place, resolve manually`,
          });
        }
      }
      state.benchOccupied.push({ ...interval, jobName: job.name, jobId: job.id });
    }
    if (job.finishingOverride) {
      const nominalFinishDays = nominalBenchDays + impact.flatExtra;
      const interval = computeOverrideInterval(job.finishingOverride, job.finishingDaysOverride, nominalFinishDays, holidays, job.finishingOverrideUsed);
      for (const existing of state.finishingOccupied) {
        if (slotsOverlap(interval.startSlot, interval.endSlot, existing.startSlot, existing.endSlot)) {
          warnings.push({
            jobId: job.id,
            jobName: job.name,
            type: "buffer_too_tight",
            message: `Finishing pinned to ${fmtUK(interval.startSlot.date)} overlaps ${existing.jobName}'s pinned finishing — both left in place, resolve manually`,
          });
        }
      }
      state.finishingOccupied.push({ ...interval, jobName: job.name, jobId: job.id });
    }
  }

  // PASS 2: schedule every job in the existing sort order. Pinned bench/
  // finishing jobs land on their recorded interval; unpinned jobs search for
  // the earliest free slot, which naturally fills gaps between pinned blocks.
  for (const job of sorted) {
    const impact = featureImpact(job.features);
    if (totalCabinets(job) === 0 && impact.holdExtra === 0) {
      scheduled.push({ ...job, tasks: [], warning: "No cabinets entered" });
      continue;
    }

    const result = scheduleSingleJob(job, state, holidays, settings, impact);
    if (!result.benchWasPinned) {
      state.benchOccupied.push({ ...result.benchInterval, jobName: job.name, jobId: job.id });
    }
    if (!result.finishWasPinned) {
      state.finishingOccupied.push({ ...result.finishingInterval, jobName: job.name, jobId: job.id });
    }
    if (result.installerBooking) {
      if (result.installer === "Team") {
        // Team install: claim all three fitters' time
        FITTERS.forEach(f => {
          state.installerSchedules[f].push({
            ...result.installerBooking,
            jobName: result.installerBooking.jobName + " (team)",
          });
        });
      } else if (state.installerSchedules[result.installer]) {
        state.installerSchedules[result.installer].push(result.installerBooking);
        // If there's a secondary fitter, claim their time too
        if (result.secondaryInstaller && state.installerSchedules[result.secondaryInstaller]) {
          state.installerSchedules[result.secondaryInstaller].push({
            ...result.installerBooking,
            jobName: result.installerBooking.jobName + " (support)",
          });
        }
      }
    }
    if (result.installBooking) {
      state.installBookings.push(result.installBooking);
    }
    if (result.vanBookings) {
      state.vanBookings.push(...result.vanBookings);
    }
    scheduled.push({
      ...job,
      tasks: result.tasks,
      benchDays: result.benchDays,
      finishDays: result.finishDays,
    });
    warnings.push(...result.warnings);
  }

  // Detect bunching: 3+ jobs whose finishing overlaps significantly in same week
  const finishingByDate = {};
  scheduled.forEach(job => {
    job.tasks?.filter(t => t.stage === "finishing").forEach(t => {
      let cur = new Date(t.start.getTime());
      while (cur < t.end) {
        const k = dayKey(cur);
        finishingByDate[k] = (finishingByDate[k] || 0) + 1;
        cur = addDays(cur, 1);
      }
    });
  });
  const heavyDays = Object.entries(finishingByDate).filter(([_, c]) => c >= 3);
  if (heavyDays.length > 0) {
    warnings.push({
      type: "load",
      message: `Heavy finishing load: ${heavyDays.length} day(s) with 3+ jobs in finishing simultaneously`,
    });
  }

  // Detect install bunching: 2+ installs starting in the same calendar week
  const installsByWeek = {};
  scheduled.forEach(job => {
    const installTask = job.tasks?.find(t => t.stage === "install");
    if (!installTask) return;
    // Get ISO week key (year-week)
    const d = new Date(installTask.start.getTime());
    const wk = getWeekKey(d);
    if (!installsByWeek[wk]) installsByWeek[wk] = [];
    installsByWeek[wk].push(job.name || "(unnamed)");
  });
  Object.entries(installsByWeek).forEach(([wk, names]) => {
    if (names.length >= 2) {
      warnings.push({
        type: "install_load",
        message: `Week of ${fmtUK(wk)}: ${names.length} installs scheduled (${names.join(", ")})`,
      });
    }
  });

  // Detect bench gaps caused by pinning: 2+ working days idle between
  // consecutive bench blocks. This can only happen when a pin creates a hole
  // in what would otherwise be a wall-to-wall bench queue — routine notice,
  // bell only, never auto-pops.
  {
    const sortedBench = [...state.benchOccupied].sort((a, b) => compareFractionalSlot(a.startSlot, b.startSlot));
    for (let i = 1; i < sortedBench.length; i++) {
      const prevEnd = sortedBench[i - 1].endSlot;
      const prevEndDate = prevEnd.used <= DAY_EPSILON ? prevEnd.date : addDays(prevEnd.date, 1);
      const nextStartDate = sortedBench[i].startSlot.date;
      const gap = workingDaysBetween(prevEndDate, nextStartDate, holidays);
      if (gap >= 2) {
        warnings.push({
          type: "bench_gap",
          message: `Bench gap of ${gap} working days between ${sortedBench[i - 1].jobName} and ${sortedBench[i].jobName}`,
        });
      }
    }
  }

  // Booth runs: jobs sprayed together to save a colour changeover. Warn if
  // the grouping doesn't actually make sense — mismatched colours defeat the
  // point, and installs too far apart just delays the earlier job for no
  // reason. Routine notice, bell only, never auto-pops.
  {
    const boothGroups = {};
    scheduled.forEach(job => {
      if (job.boothRunId) {
        (boothGroups[job.boothRunId] = boothGroups[job.boothRunId] || []).push(job);
      }
    });
    Object.entries(boothGroups).forEach(([boothRunId, members]) => {
      if (members.length < 2) return;
      const colourKeys = new Set(members.map(j => `${j.colour?.hex || ""}|${j.colour?.name || ""}`));
      if (colourKeys.size > 1) {
        warnings.push({
          type: "booth_run_mismatch",
          message: `Booth run "${boothRunId}" pairs jobs with different colours: ${members.map(j => `${j.name} (${j.colour?.name || "no colour set"})`).join(", ")}`,
        });
      }
      const installStarts = members
        .map(j => j.tasks?.find(t => t.stage === "install"))
        .filter(Boolean)
        .map(t => t.start);
      if (installStarts.length >= 2) {
        const minD = new Date(Math.min(...installStarts.map(d => d.getTime())));
        const maxD = new Date(Math.max(...installStarts.map(d => d.getTime())));
        const spreadDays = workingDaysBetween(minD, maxD, holidays);
        if (spreadDays > 14) {
          warnings.push({
            type: "booth_run_mismatch",
            message: `Booth run "${boothRunId}" installs are ${spreadDays} working days apart (${members.map(j => j.name).join(", ")}) — more than the 14-day pairing window`,
          });
        }
      }
    });
  }

  // Once a job's install has fully finished, its warnings are done too —
  // nothing about a completed job needs manual review, and re-surfacing it
  // (e.g. because upstream drift nudged its computed dates slightly) is just
  // noise. Doesn't touch scheduling itself, only which warnings are reported.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const installDoneJobIds = new Set(
    scheduled
      .filter(j => {
        const installTask = j.tasks?.find(t => t.stage === "install");
        return installTask && installTask.end <= today;
      })
      .map(j => j.id)
  );
  const liveWarnings = warnings.filter(w => !(w.jobId && installDoneJobIds.has(w.jobId)));

  return { scheduled, warnings: liveWarnings, dayLayout: computeDayLayout(scheduled, holidays) };
}

// Given a target install ISO date, return the Monday of that week.
function mondayOfWeek(isoDate, holidays) {
  let d = parseISO(isoDate);
  const dow = d.getDay();
  const offsetToMon = dow === 0 ? -6 : 1 - dow;
  d = addDays(d, offsetToMon);
  // If Monday is a bank holiday, roll forward to next working day
  while (isWeekend(d) || holidays.has(dayKey(d))) d = addDays(d, 1);
  return d;
}

// Count deliveries a job requires. Over 25 cabinets = 2 deliveries.
function deliveriesForJob(cabCount) {
  return cabCount > 25 ? 2 : 1;
}

// Find a suitable install start date given a target date.
// The target is interpreted as the EXACT install start day.
// If the target has a van/fitter clash with other jobs, stagger by +2 working days.
// Returns { date, installer, overflowed, movedForward }
//  - movedForward: true if we moved past the exact target due to a clash
function findInstallDayInTargetWeek(targetISO, cabCount, state, holidays, preferredFitter, fitterHolidays, isUserPick) {
  let target = parseISO(targetISO);
  // If target is a non-working day, bump to next working day (and flag)
  if (isWeekend(target) || holidays.has(dayKey(target))) {
    target = nextWorkingDay(target, holidays);
  }
  const dels = deliveriesForJob(cabCount);
  const roughInstallDays = Math.ceil(installDaysForCabinets(cabCount));

  // Build ordered list of fitters to try.
  // If the user explicitly picked a fitter, ONLY search for that fitter (don't
  // silently fall back to a different one). The scheduler will stagger the date
  // forward to find a slot where their picked fitter is free.
  // If auto / no preference, try Steve first, then Thompson.
  const fitterOrder = [];
  if (isUserPick && preferredFitter && FITTERS.includes(preferredFitter)) {
    fitterOrder.push(preferredFitter);
  } else {
    if (preferredFitter && FITTERS.includes(preferredFitter)) fitterOrder.push(preferredFitter);
    for (const f of ["Steve", "Thompson"]) {
      if (!fitterOrder.includes(f)) fitterOrder.push(f);
    }
  }

  const hasVanClash = (candidate) => {
    let cur = new Date(candidate.getTime());
    let checked = 0;
    while (checked < dels) {
      while (isWeekend(cur) || holidays.has(dayKey(cur))) cur = addDays(cur, 1);
      const k = dayKey(cur);
      for (const v of state.vanBookings || []) {
        if (dayKey(v.date) === k && !v.isSibling) return true;
      }
      cur = addDays(cur, 1);
      checked++;
    }
    return false;
  };

  const fitterFree = (fitter, candidate) => {
    const fitterSched = state.installerSchedules[fitter] || [];
    const seq = workingDaysSeq(candidate, roughInstallDays, holidays);
    const end = addDays(seq[seq.length - 1], 1);
    for (const booked of fitterSched) {
      if (seq[0] < booked.end && end > booked.start) return false;
    }
    // Reject if fitter is on holiday during this install
    if (fitterOnHolidayDuring(fitter, seq[0], end, fitterHolidays)) return false;
    return true;
  };

  // First try the exact target date with each fitter (preferred first)
  if (!hasVanClash(target)) {
    for (const fitter of fitterOrder) {
      if (fitterFree(fitter, target)) {
        return { date: target, installer: fitter, overflowed: false, movedForward: false };
      }
    }
  }

  // Exact target clashed — stagger by +2 working days and retry
  const candidates = [];
  let c = new Date(target.getTime());
  for (let i = 0; i < 10; i++) {
    // Advance 2 working days from current
    let step = 2;
    while (step > 0) {
      c = addDays(c, 1);
      if (!isWeekend(c) && !holidays.has(dayKey(c))) step--;
    }
    candidates.push(new Date(c.getTime()));
  }

  for (const candidate of candidates) {
    if (hasVanClash(candidate)) continue;
    for (const fitter of fitterOrder) {
      if (fitterFree(fitter, candidate)) {
        return {
          date: candidate,
          installer: fitter,
          overflowed: false,
          movedForward: true,
        };
      }
    }
  }

  // Give up — return target anyway, caller will warn
  return { date: target, installer: fitterOrder[0], overflowed: true, movedForward: false };
}

// Work backwards from an install Monday to determine the machining start date.
// pipelineDays describes the length of bench/finishing/reassembly.
// Structure (backwards from install):
//   Install day D
//   ← "hold in workshop" buffer (5 working days = 1 week)
//   ← reassembly ends on day D - 5 working days
//   ← reassembly starts ~ benchDays before its end
//   ← finishing ends 1 working day before reassembly ends, starts ~ benchDays before that
//   ← bench ends 1 working day before finishing ends
//   ← machining ends 1 working day before bench starts
//   ← machining starts machiningDays before its end
// This returns the required machining start date.
function backwardFromInstall(installDate, benchDays, machiningDays, impact, holidays, settings) {
  const weekBuffer = settings.workshopBufferIdealDays ?? 3;
  // Step back weekBuffer working days from install: that's the day reassembly ENDS
  let d = new Date(installDate.getTime());
  let stepped = 0;
  while (stepped < weekBuffer) {
    d = addDays(d, -1);
    if (!isWeekend(d) && !holidays.has(dayKey(d))) stepped++;
  }
  // d is now the reassembly-end date. Reassembly takes benchDays (fractional,
  // at bench's own pace) — retreat that far using the same fractional-day
  // stepping the real schedule uses, so this stays exact instead of
  // approximating fractional days as whole ones.
  const reassemblyEndDate = d;
  const reassemblyStart = retreatFractionalDay({ date: d, used: 0 }, benchDays, holidays).date;
  // Reassembly starts 1 working day after finishing starts → finishing starts 1 WD earlier
  let finishStart = reassemblyStart;
  finishStart = addDays(finishStart, -1);
  while (isWeekend(finishStart) || holidays.has(dayKey(finishStart))) finishStart = addDays(finishStart, -1);
  // Finishing starts 1 WD after bench starts → bench starts 1 WD earlier
  let benchStart = addDays(finishStart, -1);
  while (isWeekend(benchStart) || holidays.has(dayKey(benchStart))) benchStart = addDays(benchStart, -1);
  // Machining ends ON benchStart (bench starts nextWorkingDay after machiningEnd,
  // so machiningEnd = benchStart - 1 working day)
  let machiningEnd = addDays(benchStart, -1);
  while (isWeekend(machiningEnd) || holidays.has(dayKey(machiningEnd))) machiningEnd = addDays(machiningEnd, -1);
  // Machining spans machiningDays ending on machiningEnd, so start = machiningEnd - (machiningDays - 1) WD
  let machiningStart = machiningEnd;
  let back = machiningDays - 1;
  while (back > 0) {
    machiningStart = addDays(machiningStart, -1);
    if (!isWeekend(machiningStart) && !holidays.has(dayKey(machiningStart))) back--;
  }
  // Account for hold/wait days at start (subtract further back)
  if (impact.holdExtra > 0) {
    let h = impact.holdExtra;
    while (h > 0) {
      machiningStart = addDays(machiningStart, -1);
      if (!isWeekend(machiningStart) && !holidays.has(dayKey(machiningStart))) h--;
    }
  }
  return { machiningStart, benchStart };
}

// Schedule a single job into the current state. Returns the tasks and updated state.
// Used by both scheduleJobs (real schedule) and the What-If tool (hypothetical).
function scheduleSingleJob(job, state, holidays, settings, impact, opts = {}) {
  const benchDays = benchDaysForJob(job);
  const finishDays = benchDays + impact.flatExtra;
  const warnings = [];
  const tasks = [];

  // If the job has a target install date, treat it as the EXACT install start day.
  // We pin install to that date (or the nearest available working day) and work
  // backwards through the pipeline to determine machining start.
  let pinnedInstallDate = null;
  let pinnedInstaller = null;
  let targetOverflowWarning = null;

  if (job.installOverride) {
    // Drag-set override: pin to the EXACT date the user dropped on.
    // No stagger, no shifting. Production reflows around this date.
    // If there's a van or fitter clash, just warn — the user picked this date deliberately.
    let exactDate = parseISO(job.installOverride);
    // Only nudge if landed on a non-working day (weekend / bank holiday)
    if (isWeekend(exactDate) || holidays.has(dayKey(exactDate))) {
      const nudged = nextWorkingDay(exactDate, holidays);
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "target_stagger",
        message: `Install date ${fmtUK(job.installOverride)} is a non-working day — nudged to ${fmtUK(nudged)}`,
      });
      exactDate = nudged;
    }
    pinnedInstallDate = exactDate;
    // Pick a fitter: user's choice if set, otherwise Steve as default. Don't reassign for clashes.
    pinnedInstaller = (job.installer && FITTERS.includes(job.installer))
      ? job.installer
      : "Steve";

    // Check for van/fitter clashes and warn (but don't move the date)
    const cabCount = totalCabinets(job);
    const installDur = Math.ceil(
      (job.installDaysOverride && job.installDaysOverride > 0)
        ? job.installDaysOverride
        : installDaysForCabinets(cabCount)
    );
    const proposedSeq = workingDaysSeq(exactDate, installDur, holidays);
    const propEnd = addDays(proposedSeq[proposedSeq.length - 1], 1);
    // Van conflict?
    const dels = deliveriesForJob(cabCount);
    let vanClash = null;
    // Van clash check should use the actual delivery date, not the install date.
    // If user set a custom deliveryDate, check from there; otherwise check from install start.
    let vanCheckStart;
    if (job.deliveryDate) {
      const parsed = parseISO(job.deliveryDate);
      vanCheckStart = (isWeekend(parsed) || holidays.has(dayKey(parsed)))
        ? nextWorkingDay(parsed, holidays)
        : parsed;
    } else {
      vanCheckStart = exactDate;
    }
    let vanCur = new Date(vanCheckStart.getTime());
    let dChecked = 0;
    while (dChecked < dels && !vanClash) {
      while (isWeekend(vanCur) || holidays.has(dayKey(vanCur))) vanCur = addDays(vanCur, 1);
      const k = dayKey(vanCur);
      for (const v of state.vanBookings || []) {
        if (dayKey(v.date) === k && !v.isSibling && v.customer !== customerFromJobName(job.name)) {
          vanClash = v;
          break;
        }
      }
      vanCur = addDays(vanCur, 1);
      dChecked++;
    }
    if (vanClash) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "installer_conflict",
        message: `Van clash on ${fmtUK(vanCheckStart)} with ${vanClash.jobName}`,
      });
    }
    // Fitter conflict?
    const fitterSched = state.installerSchedules[pinnedInstaller] || [];
    for (const booked of fitterSched) {
      if (proposedSeq[0] < booked.end && propEnd > booked.start) {
        warnings.push({
          jobId: job.id,
          jobName: job.name,
          type: "installer_conflict",
          message: `${pinnedInstaller} already booked on ${fmtUK(booked.start)} for ${booked.jobName} — overlap`,
        });
        break;
      }
    }
  } else if (job.targetInstallWeek) {
    // Form-set target: softer commitment — scheduler may stagger by +2 WD if there's
    // a clash, since the user typed a date but expects the system to find a good slot.
    const jobCabs = totalCabinets(job);
    const candidateFitter = (job.installer && FITTERS.includes(job.installer))
      ? job.installer
      : null;
    const isUserPick = !!candidateFitter && job.installer !== "auto";
    const slot = findInstallDayInTargetWeek(
      job.targetInstallWeek, jobCabs, state, holidays, candidateFitter, settings.fitterHolidays, isUserPick
    );
    pinnedInstallDate = slot.date;
    pinnedInstaller = slot.installer;
    if (slot.movedForward) {
      targetOverflowWarning = `Target ${fmtUK(job.targetInstallWeek)} clashed with another install — moved to ${fmtUK(slot.date)}`;
    } else if (slot.overflowed) {
      targetOverflowWarning = `Target ${fmtUK(job.targetInstallWeek)} not achievable — scheduled for ${fmtUK(slot.date)} as fallback`;
    }
  }

  // Machining start derives from the bench start (machining runs in parallel,
  // starting 3 working days before bench). Computed AFTER bench is positioned —
  // see the machining block further down. Here we just leave a placeholder.
  let machiningStart = nextWorkingDay(parseISO(settings.startDate), holidays);
  if (job.manualStart) {
    machiningStart = nextWorkingDay(parseISO(job.manualStart), holidays);
  }

  let curStart = machiningStart;

  // Hold/wait at the start (from features) — sits before everything else
  if (impact.holdExtra > 0) {
    const holdSeq = workingDaysSeq(curStart, impact.holdExtra, holidays);
    tasks.push({
      stage: "buffer",
      start: holdSeq[0],
      end: addDays(holdSeq[holdSeq.length - 1], 1),
      days: impact.holdExtra,
    });
    curStart = addDays(holdSeq[holdSeq.length - 1], 1);
    curStart = nextWorkingDay(curStart, holidays);
  }

  // Bench - the constrained shared resource. Pinned jobs (job.benchOverride)
  // land on their fixed interval regardless of what else is going on.
  //
  // Everyone else claims the EARLIEST free slot by default — that's the safe,
  // predictable behaviour, and it's what keeps every job's workshop buffer as
  // generous as possible. The one exception: a job with a deadline that's
  // MONTHS away doesn't need to claim near-term capacity just because it's
  // next in the queue — that's capacity more urgent or flexible work could
  // use. So we only defer to a backward/just-in-time slot when the job has
  // SUBSTANTIAL slack (comfortably more than the ideal buffer needs); a job
  // with only a few days of slack stays on the safe ASAP path unchanged,
  // since eating into a small buffer for no real benefit just makes targets
  // more fragile.
  const benchWasPinned = !!job.benchOverride;
  // Date and duration overrides are independent — a resize-only drag sets
  // benchDaysOverride with no benchOverride date, and must still apply.
  const benchActualDays = (job.benchDaysOverride && job.benchDaysOverride > 0)
    ? job.benchDaysOverride
    : benchDays;
  const earliestBenchSlot = { date: parseISO(settings.startDate), used: 0 };
  const SLACK_THRESHOLD_WORKING_DAYS = 15; // ~3 working weeks before deferral kicks in
  let benchStartSlot, benchEndSlot;
  if (benchWasPinned) {
    const interval = computeOverrideInterval(job.benchOverride, job.benchDaysOverride, benchDays, holidays, job.benchOverrideUsed);
    benchStartSlot = interval.startSlot;
    benchEndSlot = interval.endSlot;
  } else {
    const asapSlot = findFreeBenchSlot(earliestBenchSlot, benchActualDays, state.benchOccupied, holidays);
    benchStartSlot = asapSlot;
    if (pinnedInstallDate) {
      const { benchStart: latestBenchStartDate } = backwardFromInstall(
        pinnedInstallDate, benchDays, job.machiningDays || 1, impact, holidays, settings
      );
      const desiredLatestBenchStart = { date: latestBenchStartDate, used: 0 };
      const slackWorkingDays = workingDaysBetween(asapSlot.date, desiredLatestBenchStart.date, holidays);
      if (slackWorkingDays >= SLACK_THRESHOLD_WORKING_DAYS) {
        const latestSlot = findLatestFreeBenchSlot(desiredLatestBenchStart, benchActualDays, state.benchOccupied, holidays);
        // Only actually defer if the backward search landed later than ASAP —
        // if congestion pushed it back to (or before) the ASAP slot anyway,
        // there's no benefit, just use ASAP.
        if (compareFractionalSlot(latestSlot, asapSlot) > 0) {
          benchStartSlot = latestSlot;
        }
      }
    }
  }
  benchEndSlot = advanceFractionalDay(benchStartSlot, benchActualDays, holidays);
  const benchInterval = { startSlot: benchStartSlot, endSlot: benchEndSlot };
  tasks.push({
    stage: "bench",
    start: benchStartSlot.date,
    end: addDays(benchEndSlot.date, benchEndSlot.used <= DAY_EPSILON ? 0 : 1),
    startSlot: benchStartSlot,
    endSlot: benchEndSlot,
    days: benchActualDays,
    isOverridden: !!(job.benchOverride || (job.benchDaysOverride && job.benchDaysOverride > 0)),
  });

  // Machining - starts 3 working days BEFORE bench start, runs in parallel.
  // Duration rule:
  //   - Jobs under 9 cabinets: machining = bench duration (rounded up to whole days)
  //     — tiny jobs don't need a separate machining run, just match bench
  //   - Jobs 9+ cabinets: max(bench days rounded up, machining days field)
  //
  // Both start date and duration can be MANUALLY OVERRIDDEN via:
  //   job.machiningOverride (ISO date) — explicit start date
  //   job.machiningDaysOverride (number) — explicit duration in days
  // When set, the auto-calc is replaced. Bench stays where it is regardless.
  const cabCountForMach = totalCabinets(job);
  const autoMachDays = (cabCountForMach < 9)
    ? Math.max(1, Math.ceil(benchDays))
    : Math.max(Math.ceil(benchDays), job.machiningDays || 0);
  const machDays = (job.machiningDaysOverride && job.machiningDaysOverride > 0)
    ? job.machiningDaysOverride
    : autoMachDays;

  let machiningStartActual;
  if (job.machiningOverride) {
    const parsed = parseISO(job.machiningOverride);
    machiningStartActual = (isWeekend(parsed) || holidays.has(dayKey(parsed)))
      ? nextWorkingDay(parsed, holidays)
      : parsed;
  } else {
    // Auto: 3 working days before bench start
    machiningStartActual = benchStartSlot.date;
    for (let i = 0; i < 3; i++) {
      machiningStartActual = addDays(machiningStartActual, -1);
      while (isWeekend(machiningStartActual) || holidays.has(dayKey(machiningStartActual))) {
        machiningStartActual = addDays(machiningStartActual, -1);
      }
    }
    // Don't allow machining to start before today (or settings.startDate)
    const earliestMach = nextWorkingDay(parseISO(settings.startDate), holidays);
    if (machiningStartActual < earliestMach) machiningStartActual = earliestMach;
  }

  const machiningSeq = workingDaysSeq(machiningStartActual, machDays, holidays);
  const machiningEnd = addDays(machiningSeq[machiningSeq.length - 1], 1);

  // Sanity warning: if user has manually positioned machining such that it ends
  // AFTER bench has started, flag it (production order broken). Same physical
  // problem can be caused from either side — machining pinned too late, or
  // bench pinned too early — so check both, but only warn once.
  if (machiningEnd > benchStartSlot.date) {
    if (job.machiningOverride) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "buffer_too_tight",
        message: `Machining ends ${fmtUK(addDays(machiningEnd, -1))} but bench starts ${fmtUK(benchStartSlot.date)} — production order broken`,
      });
    } else if (benchWasPinned) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "buffer_too_tight",
        message: `Bench pinned to start ${fmtUK(benchStartSlot.date)} but machining doesn't finish until ${fmtUK(addDays(machiningEnd, -1))} — production order broken`,
      });
    }
  }

  tasks.push({
    stage: "machining",
    start: machiningSeq[0],
    end: machiningEnd,
    days: machDays,
    isOverridden: !!(job.machiningOverride || (job.machiningDaysOverride && job.machiningDaysOverride > 0)),
  });

  // Finishing - desired start is 1 working day after bench begins, half-slot
  // precision. The "1 day after bench starts" rule means: finishing AM-slot
  // starts the working day after the day bench began. So if bench starts Mon
  // AM, finishing starts Tue AM — unless finishing capacity (state.finishingOccupied)
  // is busy there, in which case it's pushed forward to the next free slot.
  // Pinned jobs (job.finishingOverride) land on their fixed interval instead.
  const finishWasPinned = !!job.finishingOverride;
  // Date and duration overrides are independent — a resize-only drag sets
  // finishingDaysOverride with no finishingOverride date, and must still apply.
  const finishActualDays = (job.finishingDaysOverride && job.finishingDaysOverride > 0)
    ? job.finishingDaysOverride
    : finishDays;
  const desiredFinishStart = {
    date: nextWorkingDay(addDays(benchStartSlot.date, 1), holidays),
    used: 0,
  };
  let finishStartSlot, finishEndSlot;
  let finishingPushed = false;
  if (finishWasPinned) {
    const interval = computeOverrideInterval(job.finishingOverride, job.finishingDaysOverride, finishDays, holidays, job.finishingOverrideUsed);
    finishStartSlot = interval.startSlot;
    finishEndSlot = interval.endSlot;
    if (compareFractionalSlot(finishStartSlot, benchStartSlot) < 0) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "buffer_too_tight",
        message: `Finishing pinned to ${fmtUK(finishStartSlot.date)} but bench doesn't start until ${fmtUK(benchStartSlot.date)} — production order broken`,
      });
    }
  } else {
    finishStartSlot = findFreeBenchSlot(desiredFinishStart, finishActualDays, state.finishingOccupied, holidays);
    if (compareFractionalSlot(finishStartSlot, desiredFinishStart) > 0) {
      finishingPushed = true;
      // Only warn if the push actually moves to a different day
      if (dayKey(finishStartSlot.date) !== dayKey(desiredFinishStart.date)) {
        warnings.push({
          jobId: job.id,
          jobName: job.name,
          type: "bunching",
          message: `Finishing capacity overlap: pushed back from ${fmtUK(desiredFinishStart.date)} to ${fmtUK(finishStartSlot.date)}`,
        });
      }
    }
    finishEndSlot = advanceFractionalDay(finishStartSlot, finishActualDays, holidays);
  }
  const finishingInterval = { startSlot: finishStartSlot, endSlot: finishEndSlot };
  tasks.push({
    stage: "finishing",
    start: finishStartSlot.date,
    end: addDays(finishEndSlot.date, finishEndSlot.used <= DAY_EPSILON ? 0 : 1),
    startSlot: finishStartSlot,
    endSlot: finishEndSlot,
    days: finishActualDays,
    isOverridden: !!(job.finishingOverride || (job.finishingDaysOverride && job.finishingDaysOverride > 0)),
  });

  // Re-assembly - starts 1 day after finishing starts, runs at the same pace
  // as bench (its nominal, cabinet-based length — not whatever bench's own
  // override says). Has its own capacity (parallel resource, doesn't gate on
  // others), so unlike bench/finishing there's no shared occupied-interval
  // search — pinning just fixes this one job's own reassembly in place.
  const reassemblyWasPinned = !!job.reassemblyOverride;
  // Date and duration overrides are independent — a resize-only drag sets
  // reassemblyDaysOverride with no reassemblyOverride date, and must still apply.
  const reassemblyActualDays = (job.reassemblyDaysOverride && job.reassemblyDaysOverride > 0)
    ? job.reassemblyDaysOverride
    : benchDays;
  const desiredReassemblyStart = {
    date: nextWorkingDay(addDays(finishStartSlot.date, 1), holidays),
    used: 0,
  };
  let reassemblyStartSlot, reassemblyEndSlot;
  if (reassemblyWasPinned) {
    const interval = computeOverrideInterval(job.reassemblyOverride, job.reassemblyDaysOverride, benchDays, holidays, job.reassemblyOverrideUsed);
    reassemblyStartSlot = interval.startSlot;
    reassemblyEndSlot = interval.endSlot;
    if (compareFractionalSlot(reassemblyStartSlot, finishStartSlot) < 0) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "buffer_too_tight",
        message: `Re-assembly pinned to ${fmtUK(reassemblyStartSlot.date)} but finishing doesn't start until ${fmtUK(finishStartSlot.date)} — production order broken`,
      });
    }
  } else {
    reassemblyStartSlot = desiredReassemblyStart;
    reassemblyEndSlot = advanceFractionalDay(reassemblyStartSlot, reassemblyActualDays, holidays);
  }
  // The "fully fitted" date is when re-assembly ends — used as anchor for install
  const reassemblyEndDate = reassemblyEndSlot.used <= DAY_EPSILON
    ? reassemblyEndSlot.date            // ended at end of previous day, so this is the next day
    : addDays(reassemblyEndSlot.date, 1); // still occupies part of this day, so next day is when it's complete
  tasks.push({
    stage: "reassembly",
    start: reassemblyStartSlot.date,
    end: addDays(reassemblyEndSlot.date, reassemblyEndSlot.used <= DAY_EPSILON ? 0 : 1),
    startSlot: reassemblyStartSlot,
    endSlot: reassemblyEndSlot,
    days: reassemblyActualDays,
    isOverridden: !!(job.reassemblyOverride || (job.reassemblyDaysOverride && job.reassemblyDaysOverride > 0)),
  });

  // Cabinet install - starts after re-assembly is done.
  // Two cases:
  //   TARGETED: install date = max(target date, reassembly end + minimum buffer)
  //     If production can finish on time, install hits the target. If production
  //     runs late, install gets pushed back to the soonest feasible date and a
  //     warning fires. (We never install earlier than the customer's promised date.)
  //   NON-TARGETED: install date = reassembly end + ideal buffer (3 days)
  const dispatchGap = settings.dispatchGapDays ?? 1;
  const workshopBufferIdeal = settings.workshopBufferIdealDays ?? 3;
  const workshopBufferMin = settings.workshopBufferMinDays ?? 1;

  // Earliest feasible install date = reassembly end + minimum buffer (working days)
  let earliestFeasible = nextWorkingDay(reassemblyEndDate, holidays);
  for (let i = 0; i < Math.max(dispatchGap, workshopBufferMin); i++) {
    earliestFeasible = addDays(earliestFeasible, 1);
    earliestFeasible = nextWorkingDay(earliestFeasible, holidays);
  }

  let earliestInstallStart;
  if (job.installOverride) {
    // Drag-overridden install: lands EXACTLY where the user put it, with one
    // exception — production finishing AFTER install has started isn't a
    // scheduling choice, it's physically impossible, so a too-tight date gets
    // nudged forward to the earliest date production can actually hit.
    // Everything else about the drag (the fitter, skipping auto-move/pairing)
    // still behaves exactly as dropped.
    if (pinnedInstallDate < earliestFeasible) {
      earliestInstallStart = earliestFeasible;
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "install_nudged",
        message: `Install nudged from ${fmtUK(pinnedInstallDate)} to ${fmtUK(earliestFeasible)} — production doesn't finish until ${fmtUK(reassemblyEndDate)}`,
      });
    } else {
      earliestInstallStart = pinnedInstallDate;
    }
  } else if (pinnedInstallDate) {
    // Form-typed target (softer commitment): honour unless production can't finish in time.
    if (pinnedInstallDate >= earliestFeasible) {
      earliestInstallStart = pinnedInstallDate;
    } else {
      // Target unreachable — production runs past it. Push install to earliest feasible.
      earliestInstallStart = earliestFeasible;
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "target_unreachable",
        message: `Target ${fmtUK(pinnedInstallDate)} can't be hit — production finishes ${fmtUK(reassemblyEndDate)}, earliest install ${fmtUK(earliestFeasible)}`,
      });
    }
    if (targetOverflowWarning) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "target_stagger",
        message: targetOverflowWarning,
      });
    }
  } else {
    // Non-targeted: install = reassembly end + ideal workshop buffer.
    earliestInstallStart = nextWorkingDay(reassemblyEndDate, holidays);
    const bufferDays = Math.max(dispatchGap, workshopBufferIdeal);
    for (let i = 0; i < bufferDays; i++) {
      earliestInstallStart = addDays(earliestInstallStart, 1);
      earliestInstallStart = nextWorkingDay(earliestInstallStart, holidays);
    }
  }

  // Determine install duration using the cabinet-count formula.
  // This can be overridden per job later if needed.
  const jobCabCount = totalCabinets(job);
  let installDays = (job.installDaysOverride && job.installDaysOverride > 0)
    ? job.installDaysOverride
    : installDaysForCabinets(jobCabCount);

  // Customer-sibling detection: if an already-scheduled job shares this customer
  // name, run them on site in parallel. We deliberately match on customer alone
  // (not week) because the sibling's install date becomes the anchor.
  // This handles cases like "Smith Kitchen" and "Smith Utility" — we want both
  // fitted at the same time, even if one would naturally be ready earlier.
  const customer = customerFromJobName(job.name);
  let sibling = null;
  // Drag-overridden or locked jobs are deliberate standalone installs — never
  // auto-pair them with another customer's room. The user has positioned this
  // install themselves and expects it to land exactly where they put it.
  const skipSiblingPairing = !!job.installOverride || !!job.locked;
  if (customer && !skipSiblingPairing) {
    // Find the most recent sibling (in case there are multiple)
    for (const s of state.installBookings || []) {
      if (s.customer === customer) {
        if (!sibling || s.start > sibling.start) sibling = s;
      }
    }
    // Only treat as sibling if production pipeline finished before sibling's install
    // (otherwise this job is so big it needs its own week)
    if (sibling && earliestInstallStart > sibling.start) {
      // Check: is earliest install within say 2 weeks of sibling's install?
      const daysBetween = diffDays(earliestInstallStart, sibling.start);
      if (daysBetween > 14) {
        sibling = null; // too far apart, treat as separate
      }
    }
  }

  // Determine primary candidate fitter from user selection or auto-assign
  // Rules: Steve is lead (preferred), Thompson is second, Chris is support (sibling only).
  // "auto" or empty → pick best available; otherwise respect user choice.
  // Team installs: all three fitters on site — skip the per-fitter logic.
  const userPick = job.installer;
  const isAuto = !userPick || userPick === "auto";
  const isTeam = !!job.teamInstall;
  let installer;

  if (isTeam) {
    // Team install: all three fitters on site. Use a special installer label so
    // the rest of the pipeline knows this is a team booking. Skip sibling
    // and auto-assign logic.
    installer = "Team";
  } else if (userPick && NON_FITTERS.includes(userPick)) {
    // Non-fitter explicitly chosen (e.g. Callum) — reassign with warning
    installer = "Steve";
    warnings.push({
      jobId: job.id,
      jobName: job.name,
      type: "installer",
      message: `${userPick} is not a fitter — auto-assigned`,
    });
  } else if (pinnedInstaller && (isAuto || pinnedInstaller === userPick)) {
    // Use the fitter that the target-week slot finder picked
    installer = pinnedInstaller;
  } else if (isAuto) {
    // Auto-assign: try Steve, then Thompson. Chris never auto-assigned as primary.
    installer = null; // decided below based on availability
  } else if (FITTERS.includes(userPick)) {
    installer = userPick;
  } else {
    installer = "Steve";
  }

  let proposedStart = earliestInstallStart;

  if (isTeam) {
    // Team install: all fitters on site. No sibling pairing, no per-fitter
    // auto-assign — the install just claims its date for all three fitters.
    // Date comes from earliestInstallStart (or pinned override).
  } else if (sibling) {
    // Run in parallel with the sibling: start on the same day.
    proposedStart = sibling.start;

    // Rule: NEVER override the user's deliberate fitter pick. If the user
    // explicitly chose a fitter for this job, respect it absolutely — even if
    // it conflicts with the sibling.
    if (isAuto) {
      // No user pick: auto-assign. Prefer Chris as support, then Thompson/Steve
      // — anyone who ISN'T the sibling's fitter.
      const preferredOrder = ["Chris", "Thompson", "Steve"].filter(f => f !== sibling.installer);
      installer = preferredOrder[0];
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "sibling",
        message: `Parallel install with ${sibling.jobName} — assigned to ${installer}`,
      });
    } else if (installer === sibling.installer) {
      // User picked the same fitter as the sibling — flag the conflict, don't change anything
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "installer_conflict",
        message: `${installer} can't fit both ${sibling.jobName} and this job at the same time — change one of them`,
      });
    } else {
      // User picked a different fitter to the sibling — perfect
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "sibling",
        message: `Parallel install with ${sibling.jobName} — you're using ${installer}`,
      });
    }
  } else {
    // No sibling: need to pick a primary fitter
    // Warn if Chris was manually assigned as solo (he's support-only)
    if (installer === "Chris" && !isAuto) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "installer",
        message: `Chris is a support fitter — solo install flagged for review`,
      });
    }
    if (isAuto) {
      // Find the fitter who's free earliest from earliestInstallStart,
      // preferring Steve, then Thompson (not Chris).
      const candidates = ["Steve", "Thompson"];
      let best = null;
      for (const f of candidates) {
        const earliestForThis = findEarliestInstallSlot(
          f, earliestInstallStart, Math.ceil(installDays), state, holidays, settings.fitterHolidays
        );
        if (!best || earliestForThis < best.date ||
            (earliestForThis.getTime() === best.date.getTime() &&
             FITTER_CONFIG[f].order < FITTER_CONFIG[best.fitter].order)) {
          best = { fitter: f, date: earliestForThis };
        }
      }
      installer = best.fitter;
      proposedStart = best.date;
    }
  }

  // Date/fitter double-booking is allowed board-wide — the workshop may
  // deliberately overschedule, and the scheduler shouldn't silently reshuffle
  // jobs to avoid it. We only ever auto-move for genuine fitter unavailability
  // (holiday), and only for jobs the user hasn't manually drag-positioned.
  const skipAutoMove = !!job.installOverride;

  if (isTeam) {
    // Team install: check ALL fitters for collisions and holidays at this date.
    // Don't auto-move — just warn so the user can decide.
    const proposedSeq = workingDaysSeq(proposedStart, Math.ceil(installDays), holidays);
    const propEnd = addDays(proposedSeq[proposedSeq.length - 1], 1);
    for (const f of FITTERS) {
      // Collision with another booking?
      const fSched = state.installerSchedules[f] || [];
      for (const booked of fSched) {
        if (proposedSeq[0] < booked.end && propEnd > booked.start) {
          warnings.push({
            jobId: job.id,
            jobName: job.name,
            type: "installer_conflict",
            message: `Team install conflicts with ${f}'s booking on ${fmtUK(booked.start)} (${booked.jobName})`,
          });
        }
      }
      // Holiday clash?
      const onHol = fitterOnHolidayDuring(f, proposedSeq[0], propEnd, settings.fitterHolidays);
      if (onHol) {
        warnings.push({
          jobId: job.id,
          jobName: job.name,
          type: "installer_conflict",
          message: `Team install: ${f} on holiday ${fmtUK(onHol.start)}–${fmtUK(onHol.end)}`,
        });
      }
    }
  } else {
  // Normal (non-team) collision check — flag a clash with this fitter's
  // existing bookings, but never move anything because of it. Overlapping
  // installs are the workshop's call, not something the scheduler resolves.
  const sched = state.installerSchedules[installer] || [];
  {
    const proposedSeq = workingDaysSeq(proposedStart, Math.ceil(installDays), holidays);
    const propEnd = addDays(proposedSeq[proposedSeq.length - 1], 1);
    for (const booked of sched) {
      if (proposedSeq[0] < booked.end && propEnd > booked.start) {
        warnings.push({
          jobId: job.id,
          jobName: job.name,
          type: "installer_conflict",
          message: `${installer} already booked ${fmtUK(booked.start)}–${fmtUK(addDays(booked.end, -1))} for ${booked.jobName} — overlaps this install`,
        });
        break;
      }
    }
  }
  // Holiday check (after fitter chosen): if assigned fitter is on holiday,
  // auto-reassign to an available alternative — UNLESS the job is locked
  // or has been manually drag-positioned, in which case we warn but don't move.
  if (!skipAutoMove) {
  {
    const proposedSeq = workingDaysSeq(proposedStart, Math.ceil(installDays), holidays);
    const propEnd = addDays(proposedSeq[proposedSeq.length - 1], 1);
    const onHol = fitterOnHolidayDuring(installer, proposedSeq[0], propEnd, settings.fitterHolidays);
    if (onHol) {
      const oldInstaller = installer;
      if (job.locked) {
        // Job is locked — don't move anything, just warn loudly
        warnings.push({
          jobId: job.id,
          jobName: job.name,
          type: "installer_conflict",
          message: `LOCKED job: ${oldInstaller} now on holiday ${fmtUK(onHol.start)}–${fmtUK(onHol.end)} — needs manual review`,
        });
      } else if (!isAuto) {
        // User picked this fitter explicitly — respect their choice, just warn
        warnings.push({
          jobId: job.id,
          jobName: job.name,
          type: "installer_conflict",
          message: `${oldInstaller} on holiday ${fmtUK(onHol.start)}–${fmtUK(onHol.end)} but you've assigned them — change fitter or move date`,
        });
      } else {
        // Auto-assigned: try to find an alternative quietly
        const alternatives = ["Steve", "Thompson"].filter(f => f !== oldInstaller);
        let reassigned = null;
        for (const altF of alternatives) {
          const altSlot = findEarliestInstallSlot(
            altF, proposedStart, Math.ceil(installDays), state, holidays, settings.fitterHolidays
          );
          const altSeq = workingDaysSeq(altSlot, Math.ceil(installDays), holidays);
          const altEnd = addDays(altSeq[altSeq.length - 1], 1);
          if (!fitterOnHolidayDuring(altF, altSeq[0], altEnd, settings.fitterHolidays)) {
            reassigned = { fitter: altF, date: altSlot };
            break;
          }
        }
        if (reassigned) {
          installer = reassigned.fitter;
          proposedStart = reassigned.date;
          warnings.push({
            jobId: job.id,
            jobName: job.name,
            type: "installer",
            message: `${oldInstaller} on holiday ${fmtUK(onHol.start)}–${fmtUK(onHol.end)} — reassigned to ${installer}`,
          });
        } else {
          warnings.push({
            jobId: job.id,
            jobName: job.name,
            type: "installer_conflict",
            message: `${oldInstaller} on holiday and no alternative available — install needs manual review`,
          });
        }
      }
    }
  }
  } // end if (!skipAutoMove) for holiday check
  } // end else (non-team) wrapper

  // For siblings, recompute install duration based on combined cabinet count.
  // Manual override on this job (if set) wins over the formula.
  if (sibling) {
    const combinedCabs = (sibling.combinedCabs || sibling.cabCount) + jobCabCount;
    installDays = (job.installDaysOverride && job.installDaysOverride > 0)
      ? job.installDaysOverride
      : installDaysForCabinets(combinedCabs);
    sibling.combinedCabs = combinedCabs;
    sibling.combinedInstallDays = installDays;
  }

  if (!sibling && proposedStart > earliestInstallStart) {
    warnings.push({
      jobId: job.id,
      jobName: job.name,
      type: "installer",
      message: `${installer} unavailable on earliest install date — pushed to ${fmtUK(proposedStart)}`,
    });
  }

  // Resolve secondary fitter (an optional second fitter on the same install).
  // Only applies to non-team, non-sibling jobs. Must be a real fitter and
  // different from the primary.
  let secondaryInstaller = "";
  if (!isTeam && !sibling && job.secondaryInstaller && FITTERS.includes(job.secondaryInstaller)
      && job.secondaryInstaller !== installer) {
    secondaryInstaller = job.secondaryInstaller;
    // Check the secondary fitter's availability and warn if there's a clash
    const proposedSeq = workingDaysSeq(proposedStart, Math.ceil(installDays), holidays);
    const propEnd = addDays(proposedSeq[proposedSeq.length - 1], 1);
    const secSched = state.installerSchedules[secondaryInstaller] || [];
    for (const booked of secSched) {
      if (proposedSeq[0] < booked.end && propEnd > booked.start) {
        warnings.push({
          jobId: job.id,
          jobName: job.name,
          type: "installer_conflict",
          message: `Secondary fitter ${secondaryInstaller} already booked on ${fmtUK(booked.start)} for ${booked.jobName} — needs review`,
        });
        break;
      }
    }
    // Holiday check for secondary
    const secOnHol = fitterOnHolidayDuring(secondaryInstaller, proposedSeq[0], propEnd, settings.fitterHolidays);
    if (secOnHol) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "installer_conflict",
        message: `Secondary fitter ${secondaryInstaller} on holiday ${fmtUK(secOnHol.start)}–${fmtUK(secOnHol.end)}`,
      });
    }
  }

  const installSeq = workingDaysSeq(proposedStart, Math.ceil(installDays), holidays);
  const installEnd = addDays(installSeq[installSeq.length - 1], 1);
  // Resolve actual delivery date: user-set if provided (snapped to working day), else day 1 of install
  let deliveryDate;
  if (job.deliveryDate) {
    const parsed = parseISO(job.deliveryDate);
    deliveryDate = (isWeekend(parsed) || holidays.has(dayKey(parsed)))
      ? nextWorkingDay(parsed, holidays)
      : parsed;
  } else {
    deliveryDate = installSeq[0];
  }
  tasks.push({
    stage: "install",
    start: installSeq[0],
    end: installEnd,
    days: installDays,
    installer,
    secondaryInstaller: secondaryInstaller || null,
    siblingOf: sibling ? sibling.jobName : null,
    deliveryDate,
    isOverridden: !!(job.installOverride || (job.installDaysOverride && job.installDaysOverride > 0)),
  });

  // Buffer check: count working days between reassembly end and install start.
  // Warn if below the ideal workshop buffer; refuse if below minimum.
  {
    let bufferActual = 0;
    let cur = new Date(reassemblyEndDate.getTime());
    cur = nextWorkingDay(cur, holidays);
    while (cur < installSeq[0]) {
      bufferActual++;
      cur = addDays(cur, 1);
      cur = nextWorkingDay(cur, holidays);
    }
    if (bufferActual < workshopBufferIdeal) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "buffer_tight",
        message: `Workshop buffer is ${bufferActual} working day${bufferActual === 1 ? "" : "s"} (ideal: ${workshopBufferIdeal}). Tight squeeze.`,
      });
    }
    if (bufferActual < workshopBufferMin) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "buffer_too_tight",
        message: `Workshop buffer below minimum (${bufferActual}d vs ${workshopBufferMin}d min). Job needs review.`,
      });
    }
  }

  // Final Survey Reminder — 25 working days (5 working weeks) before install
  let surveyDay = installSeq[0];
  let back = 25;
  while (back > 0) {
    surveyDay = addDays(surveyDay, -1);
    if (!isWeekend(surveyDay) && !holidays.has(dayKey(surveyDay))) back--;
  }
  tasks.push({
    stage: "final_survey",
    start: surveyDay,
    end: addDays(surveyDay, 1),
    days: 1,
  });

  // Record van bookings (deliveries). Jobs >25 cabs = 2 deliveries over 2 working days.
  const vanBookings = [];
  const numDeliveries = deliveriesForJob(jobCabCount);
  // Delivery starts on the user-set deliveryDate if provided, otherwise day 1 of install
  let vanDay;
  if (job.deliveryDate) {
    const parsed = parseISO(job.deliveryDate);
    // Snap to working day if user picked a weekend/holiday
    if (isWeekend(parsed) || holidays.has(dayKey(parsed))) {
      vanDay = nextWorkingDay(parsed, holidays);
    } else {
      vanDay = parsed;
    }
  } else {
    vanDay = installSeq[0];
  }
  for (let d = 0; d < numDeliveries; d++) {
    vanBookings.push({
      date: new Date(vanDay.getTime()),
      jobName: job.name,
      customer,
      isSibling: !!sibling,
    });
    vanDay = addDays(vanDay, 1);
    vanDay = nextWorkingDay(vanDay, holidays);
  }

  // Worktop template - default 7 working days after install starts (+ template extra from features)
  let templateDay = installSeq[0];
  const templateGap = (settings.templateDaysAfterInstall ?? 7) + (impact.templateExtra || 0);
  for (let i = 0; i < templateGap; i++) {
    templateDay = addDays(templateDay, 1);
    templateDay = nextWorkingDay(templateDay, holidays);
  }
  tasks.push({
    stage: "template",
    start: templateDay,
    end: addDays(templateDay, 1),
    days: 1,
  });

  // Worktop install - default 7 working days after template
  let worktopInstallDay = templateDay;
  const worktopGap = settings.worktopInstallDaysAfterTemplate ?? 7;
  for (let i = 0; i < worktopGap; i++) {
    worktopInstallDay = addDays(worktopInstallDay, 1);
    worktopInstallDay = nextWorkingDay(worktopInstallDay, holidays);
  }
  tasks.push({
    stage: "worktop_install",
    start: worktopInstallDay,
    end: addDays(worktopInstallDay, 1),
    days: 1,
  });

  // Check if install slipped PAST the target week (not just the target day).
  // Same-week stagger (Mon → Wed) is fine — only flag week-level overflow.
  if (job.targetInstallWeek) {
    const targetMon = mondayOfWeek(job.targetInstallWeek, holidays);
    const targetWk = getWeekKey(targetMon);
    const actualWk = getWeekKey(installSeq[0]);
    if (actualWk > targetWk) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "slip",
        message: `Install slipped past target week (target: w/c ${fmtUK(targetMon)}, actual: w/c ${fmtUK(mondayOfWeek(dayKey(installSeq[0]), holidays))})`,
      });
    }
  }

  return {
    tasks,
    benchDays,
    finishDays,
    benchInterval,
    benchWasPinned,
    finishingInterval,
    finishWasPinned,
    installer,
    secondaryInstaller,
    installerBooking: { start: installSeq[0], end: installEnd, jobName: job.name },
    installBooking: {
      customer,
      jobName: job.name,
      start: installSeq[0],
      end: installEnd,
      installer,
      cabCount: jobCabCount,
      weekKey: getWeekKey(installSeq[0]),
      isSibling: !!sibling,
    },
    vanBookings,
    warnings,
    finishingPushed,
    installStart: installSeq[0],
    installEnd,
  };
}

// ============================================================
// WHAT-IF SLOT FINDER
// ============================================================
// Given a hypothetical job and a list of existing scheduled jobs, find:
//  1. The earliest possible install date (best case)
//  2. The earliest install date that doesn't cause finishing bunching
//  3. The earliest install date that hits a target window without compromise
// Returns multiple options so the user can pick.
// ============================================================

function findBestSlot(hypoJob, existingJobs, holidays, settings, options = {}) {
  // First, build the current state by scheduling all existing jobs
  const { scheduled } = scheduleJobs(existingJobs, holidays, settings);

  // Build state snapshot from scheduled jobs
  const state = {
    benchOccupied: [],
    finishingOccupied: [],
    installerSchedules: {},
    installBookings: [],
    vanBookings: [],
  };
  FITTERS.forEach(f => state.installerSchedules[f] = []);

  for (const job of scheduled) {
    if (!job.tasks?.length) continue;
    const benchTask = job.tasks.find(t => t.stage === "bench");
    const finishTask = job.tasks.find(t => t.stage === "finishing");
    const installTask = job.tasks.find(t => t.stage === "install");
    if (benchTask?.startSlot && benchTask?.endSlot) {
      state.benchOccupied.push({ startSlot: benchTask.startSlot, endSlot: benchTask.endSlot, jobName: job.name, jobId: job.id });
    }
    if (finishTask?.startSlot && finishTask?.endSlot) {
      state.finishingOccupied.push({ startSlot: finishTask.startSlot, endSlot: finishTask.endSlot, jobName: job.name, jobId: job.id });
    }
    if (installTask && installTask.installer) {
      // Team installs claim all three fitters, same as the live scheduling
      // loop in scheduleJobs — installerSchedules has no "Team" key of its
      // own, so indexing it directly would throw.
      if (installTask.installer === "Team") {
        FITTERS.forEach(f => {
          state.installerSchedules[f].push({
            start: installTask.start,
            end: installTask.end,
            jobName: job.name + " (team)",
          });
        });
      } else if (state.installerSchedules[installTask.installer]) {
        state.installerSchedules[installTask.installer].push({
          start: installTask.start,
          end: installTask.end,
          jobName: job.name,
        });
      }
      state.installBookings.push({
        customer: customerFromJobName(job.name),
        jobName: job.name,
        start: installTask.start,
        end: installTask.end,
        installer: installTask.installer,
        cabCount: totalCabinets(job),
        weekKey: getWeekKey(installTask.start),
      });
      // Reconstruct van bookings from install task
      const jobCabs = totalCabinets(job);
      const numDels = deliveriesForJob(jobCabs);
      let vd = installTask.start;
      for (let d = 0; d < numDels; d++) {
        state.vanBookings.push({
          date: new Date(vd.getTime()),
          jobName: job.name,
          customer: customerFromJobName(job.name),
          isSibling: !!installTask.siblingOf,
        });
        vd = addDays(vd, 1);
        vd = nextWorkingDay(vd, holidays);
      }
    }
  }

  // Try a few placement strategies and return the best ones
  const impact = featureImpact(hypoJob.features);

  // Option A: Auto-assigned (scheduler picks best fitter) — this is the headline
  const optionA = scheduleSingleJob(
    { ...hypoJob, installer: "auto" },
    deepCloneState(state), holidays, settings, impact
  );

  // Option B: Try each fitter individually — but Chris only shown if sibling exists
  // (support fitter rule). We still compute Chris for completeness but mark him.
  const fitterOptions = FITTERS.map(fitter => {
    const job = { ...hypoJob, installer: fitter };
    const result = scheduleSingleJob(job, deepCloneState(state), holidays, settings, impact);
    return {
      fitter,
      isSupport: FITTER_CONFIG[fitter].role === "support",
      ...result,
    };
  });
  // Best fitter for main display - prefer auto result
  const bestFitter = {
    fitter: optionA.installer,
    ...optionA,
  };

  // Option C: If user gave a target install date, see if any fitter can hit it
  let targetOption = null;
  if (hypoJob.targetInstallWeek) {
    const target = parseISO(hypoJob.targetInstallWeek);
    // Only consider non-support fitters for target-hit (Chris solo would need a flag)
    const eligible = fitterOptions.filter(o => !o.isSupport);
    const hits = eligible.filter(o =>
      workingDaysBetween(target, o.installStart, holidays) <= 0
    );
    if (hits.length) {
      targetOption = hits.reduce((a, b) =>
        a.installStart <= b.installStart ? a : b
      );
    }
  }

  return {
    earliest: optionA,
    bestFitter,
    fitterOptions,
    targetOption,
    state,
  };
}

function cloneSlot(slot) {
  return { date: new Date(slot.date.getTime()), used: slot.used };
}

function cloneOccupied(occupied) {
  return occupied.map(b => ({
    startSlot: cloneSlot(b.startSlot),
    endSlot: cloneSlot(b.endSlot),
    jobName: b.jobName,
    jobId: b.jobId,
  }));
}

function deepCloneState(state) {
  return {
    benchOccupied: cloneOccupied(state.benchOccupied),
    finishingOccupied: cloneOccupied(state.finishingOccupied),
    installerSchedules: Object.fromEntries(
      Object.entries(state.installerSchedules).map(([k, v]) => [
        k,
        v.map(b => ({ start: new Date(b.start.getTime()), end: new Date(b.end.getTime()), jobName: b.jobName })),
      ])
    ),
    installBookings: (state.installBookings || []).map(b => ({
      ...b,
      start: new Date(b.start.getTime()),
      end: new Date(b.end.getTime()),
    })),
    vanBookings: (state.vanBookings || []).map(b => ({
      ...b,
      date: new Date(b.date.getTime()),
    })),
  };
}

// ============================================================
// UI COMPONENTS
// ============================================================

function App() {
  const [jobs, setJobs] = useState([]);
  const [settings, setSettings] = useState({
    startDate: fmtISO(new Date()),
    installDays: 5,
    dispatchGapDays: 1,
    templateDaysAfterInstall: 7,
    worktopInstallDaysAfterTemplate: 7,
    workshopBufferIdealDays: 3,    // ideal days between reassembly end and install
    workshopBufferMinDays: 1,      // never go below this
    holidays: [], // array of ISO dates (workshop closures - all fitters/workshop)
    fitterHolidays: [], // array of { id, fitter, start, end, note? }
    lastUpdateDate: "", // ISO date of last weekly real-world check-in
    lastVarianceReviewDate: "", // ISO date the floor-board variance was last reviewed/accepted
  });
  const [floorActuals, setFloorActuals] = useState({}); // { "YYYY-MM-DD": {stage: {jobId: count}, offPlan: [...]} }
  const [showVarianceReview, setShowVarianceReview] = useState(false);
  const [editingJobId, setEditingJobId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showWhatIf, setShowWhatIf] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const [dismissedWarnings, setDismissedWarnings] = useState({}); // { fingerprint: true }
  const [showReminders, setShowReminders] = useState(false);
  const [dismissedReminders, setDismissedReminders] = useState({}); // { "jobId:surveyDate": true }
  const [showWeeklyUpdate, setShowWeeklyUpdate] = useState(false);
  const [updatePromptText, setUpdatePromptText] = useState("");
  const [updateFeedback, setUpdateFeedback] = useState(null); // { ok, message, updates, unparsed, offset }
  const [loading, setLoading] = useState(true);

  // Undo/redo history — a stack of { jobs, settings } snapshots. jobs/settings
  // are always replaced (never mutated) elsewhere in this component, so
  // storing the reference is enough; no cloning needed.
  const [historyStack, setHistoryStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const MAX_HISTORY = 20;
  const lastCommittedRef = useRef(null);
  const historyInitRef = useRef(false);
  // Set by undo()/redo() right before they call setJobs/setSettings, so the
  // capture effect below (which runs again on that resulting render) treats
  // it as an already-settled point rather than racing its own debounce timer
  // against the state undo/redo just restored.
  const isUndoRedoActionRef = useRef(false);

  // Track the timestamp of our last write so we can ignore realtime echoes
  // of our own changes (the Supabase realtime fires when WE save, which
  // would otherwise trigger a reload and overwrite local state).
  const lastWriteAtRef = useRef(0);

  // Load from storage (reusable function for realtime sync)
  const reloadFromStorage = async () => {
    try { const j = await window.storage.get("ew-jobs"); if (j?.value) setJobs(JSON.parse(j.value)); } catch {}
    try { const s = await window.storage.get("ew-settings"); if (s?.value) setSettings(JSON.parse(s.value)); } catch {}
    try { const r = await window.storage.get("ew-dismissed-reminders"); if (r?.value) setDismissedReminders(JSON.parse(r.value)); } catch {}
    try { const w = await window.storage.get("ew-dismissed-warnings"); if (w?.value) setDismissedWarnings(JSON.parse(w.value)); } catch {}
    await loadFloorActuals();
  };

  // Pull every floor:YYYY-MM-DD record (the floor board's daily tap counts) —
  // excluding the floor:wtd: week-to-date keys, which aren't per-day actuals.
  const loadFloorActuals = async () => {
    try {
      const listing = await window.storage.list("floor:");
      const dayKeys = (listing?.keys || []).filter(k => k.startsWith("floor:") && !k.startsWith("floor:wtd:"));
      const entries = {};
      for (const k of dayKeys) {
        try {
          const r = await window.storage.get(k);
          if (r?.value) entries[k.slice("floor:".length)] = JSON.parse(r.value);
        } catch {}
      }
      setFloorActuals(entries);
    } catch {}
  };

  // Wrap window.storage.set so it always records lastWriteAt (used by realtime
  // echo suppression below). Returns a promise that resolves when the save completes.
  const safeSet = (key, value) => {
    lastWriteAtRef.current = Date.now();
    return window.storage.set(key, value).catch(console.error);
  };

  useEffect(() => {
    (async () => { await reloadFromStorage(); setLoading(false); })();
  }, []);

  // Realtime sync — when ANOTHER device changes data, reload.
  // Suppress reloads if a realtime notification arrives within 3 seconds of
  // OUR own save (those are echoes, not real remote changes).
  useEffect(() => {
    if (loading) return;
    if (!window.storage.subscribe) return;
    let debounceTimer = null;
    const unsubscribe = window.storage.subscribe(() => {
      // Ignore notifications that arrive shortly after our own save —
      // they're just realtime echoes of changes we ourselves made.
      const sinceLastWrite = Date.now() - lastWriteAtRef.current;
      if (sinceLastWrite < 3000) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { reloadFromStorage(); }, 800);
    });
    return () => { clearTimeout(debounceTimer); unsubscribe(); };
  }, [loading]);

  // Undo history capture — DEBOUNCED (1s of no further change) so a burst of
  // edits (typing a field, dragging a bar) collapses into one undo step
  // rather than one per keystroke. The first run after load establishes the
  // baseline without recording a step. Known limitation: a remote change
  // from another device also produces an undo step — acceptable for a
  // single-workshop tool rather than building multi-device-aware history.
  useEffect(() => {
    if (loading || IS_READONLY) return;
    if (!historyInitRef.current) {
      lastCommittedRef.current = { jobs, settings };
      historyInitRef.current = true;
      return;
    }
    if (isUndoRedoActionRef.current) {
      // This render is undo()/redo() restoring a snapshot, not a new user
      // edit — treat it as already-settled instead of debouncing/capturing.
      // Don't reset the ref here: the save-jobs effect below also needs to
      // see it as true during this same commit (see undo()/redo(), which
      // schedule the reset for right after this tick instead).
      lastCommittedRef.current = { jobs, settings };
      return;
    }
    const timer = setTimeout(() => {
      const prev = lastCommittedRef.current;
      if (prev && (prev.jobs !== jobs || prev.settings !== settings)) {
        setHistoryStack(h => [...h.slice(-(MAX_HISTORY - 1)), prev]);
        setRedoStack([]);
        lastCommittedRef.current = { jobs, settings };
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [jobs, settings, loading]);

  // Undo/redo set isUndoRedoActionRef synchronously so every effect reacting
  // to this same jobs/settings change (history capture above, the save-jobs
  // empty-array guard below) can see it during this commit, then clear it
  // shortly after — asynchronously, so it's still true when those effects'
  // bodies run (effects run synchronously within the commit; a plain
  // "reset it in the first effect that reads it" would hide it from the
  // others, since effects for one commit run in declaration order).
  const undo = () => {
    if (historyStack.length === 0) return;
    const prev = historyStack[historyStack.length - 1];
    setRedoStack(r => [...r, { jobs, settings }]);
    setHistoryStack(h => h.slice(0, -1));
    isUndoRedoActionRef.current = true;
    setJobs(prev.jobs);
    setSettings(prev.settings);
    setTimeout(() => { isUndoRedoActionRef.current = false; }, 0);
  };
  const redo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setHistoryStack(h => [...h, { jobs, settings }]);
    setRedoStack(r => r.slice(0, -1));
    isUndoRedoActionRef.current = true;
    setJobs(next.jobs);
    setSettings(next.settings);
    setTimeout(() => { isUndoRedoActionRef.current = false; }, 0);
  };

  // Save jobs — DEBOUNCED so rapid typing/dragging doesn't fire 20 saves.
  // Waits 600ms after the last change before writing. Includes the
  // empty-array safety guard so a transient empty state can't wipe data —
  // except when undo/redo deliberately restored an empty array, which is a
  // real historical state to persist, not a race to guard against.
  const wasUndoRedoForSave = isUndoRedoActionRef.current;
  useEffect(() => {
    if (loading || IS_READONLY) return;
    const t = setTimeout(() => {
      if (jobs.length === 0 && !wasUndoRedoForSave) {
        // Safety check: don't overwrite non-empty Supabase data with an empty array
        window.storage.get("ew-jobs").then(r => {
          if (!r || !r.value) {
            safeSet("ew-jobs", JSON.stringify(jobs));
            return;
          }
          try {
            const existing = JSON.parse(r.value);
            if (Array.isArray(existing) && existing.length === 0) return;
            console.warn("Refusing to save empty jobs array over existing data. Reloading from Supabase.");
            setJobs(existing);
          } catch (e) {
            console.error("Failed to parse existing jobs:", e);
          }
        }).catch(console.error);
        return;
      }
      safeSet("ew-jobs", JSON.stringify(jobs));
    }, 600);
    return () => clearTimeout(t);
  }, [jobs, loading]);

  // Save settings (debounced too — same reasoning)
  useEffect(() => {
    if (loading || IS_READONLY) return;
    const t = setTimeout(() => safeSet("ew-settings", JSON.stringify(settings)), 600);
    return () => clearTimeout(t);
  }, [settings, loading]);

  useEffect(() => {
    if (loading || IS_READONLY) return;
    const t = setTimeout(() => safeSet("ew-dismissed-reminders", JSON.stringify(dismissedReminders)), 600);
    return () => clearTimeout(t);
  }, [dismissedReminders, loading]);

  useEffect(() => {
    if (loading || IS_READONLY) return;
    const t = setTimeout(() => safeSet("ew-dismissed-warnings", JSON.stringify(dismissedWarnings)), 600);
    return () => clearTimeout(t);
  }, [dismissedWarnings, loading]);

  const holidaySet = useMemo(() => {
    const set = new Set(UK_BANK_HOLIDAYS);
    (settings.holidays || []).forEach(h => set.add(h));
    return set;
  }, [settings.holidays]);

  const { scheduled, warnings, dayLayout } = useMemo(
    () => scheduleJobs(jobs, holidaySet, settings),
    [jobs, holidaySet, settings]
  );

  // Build warning fingerprints. A warning's identity = type + job + message,
  // so when the schedule shifts and produces a different message for the same
  // job, the warning re-fires automatically (different fingerprint).
  const fingerprintFor = (w) => `${w.type}|${w.jobName || ""}|${w.message}`;

  // Active warnings: those not in the dismissed map.
  const activeWarnings = useMemo(() =>
    warnings.filter(w => !dismissedWarnings[fingerprintFor(w)]),
    [warnings, dismissedWarnings]
  );

  // Nothing auto-pops the warnings modal any more — every warning, including a
  // genuinely unreachable customer-promised date, just sits quietly in the
  // bell until you choose to open it. The schedule can move fast when a lot
  // of jobs are being rearranged at once, and a popup firing mid-edit was
  // pure interruption; the badge count is enough to know something's there.
  // Still used to decide what counts as "worth surfacing" in the variance
  // review's before/after preview.
  const SERIOUS_WARNING_TYPES = new Set([
    "target_unreachable",
  ]);

  // Garbage-collect dismissed warnings whose fingerprint is no longer produced
  // (e.g. job deleted, or warning resolved). Keeps the storage tidy.
  useEffect(() => {
    if (loading) return;
    const liveFingerprints = new Set(warnings.map(fingerprintFor));
    const cleaned = {};
    let changed = false;
    for (const fp of Object.keys(dismissedWarnings)) {
      if (liveFingerprints.has(fp)) {
        cleaned[fp] = true;
      } else {
        changed = true;
      }
    }
    if (changed) setDismissedWarnings(cleaned);
  }, [warnings, loading]);

  // Compute active survey reminders: those whose survey date has arrived
  // (today or earlier) AND haven't been dismissed yet AND install hasn't
  // already happened.
  const activeReminders = useMemo(() => {
    const today = dayKey(new Date());
    const out = [];
    scheduled.forEach(job => {
      const surveyTask = job.tasks?.find(t => t.stage === "final_survey");
      const installTask = job.tasks?.find(t => t.stage === "install");
      if (!surveyTask || !installTask) return;
      const surveyKey = dayKey(surveyTask.start);
      const dismissKey = `${job.id}:${surveyKey}`;
      if (dismissedReminders[dismissKey]) return;
      // Only show if survey date has arrived and install hasn't passed
      if (surveyKey <= today && dayKey(installTask.start) >= today) {
        out.push({
          jobId: job.id,
          jobName: job.name,
          surveyDate: surveyTask.start,
          installDate: installTask.start,
          dismissKey,
        });
      }
    });
    return out;
  }, [scheduled, dismissedReminders]);

  // Survey reminders no longer auto-pop on load — same reasoning as the
  // warnings modal above. The badge (reminderCount in the header) still
  // shows how many are outstanding; opening the list is a deliberate click.

  // Figure out whether the floor board has recorded anything since the last
  // variance review, and if so, which job it says was actually on the bench
  // most recently (the one with the most tapped cabinets on the latest
  // recorded day). That job becomes the "anchor" for the SAME offset math
  // applyWeeklyUpdate already uses for the manual check-in — today vs. where
  // the scheduler currently has that job's bench start.
  //
  // Gated to once a week (Monday 6:30am) rather than continuous: a single
  // rough day on the floor shouldn't nudge the whole schedule mid-week — this
  // gives the workshop the rest of the week to catch back up on its own, and
  // only asks "where are we" once, at the start of the next week.
  const varianceReview = useMemo(() => {
    const empty = { unreviewedDays: 0, anchorJobId: null, anchorJobName: "", offsetDays: 0, latestDate: null, notes: [] };
    // Compare as plain ISO date strings (lastVarianceReviewDate has no time
    // component) so a review actioned any time Monday closes the gate for
    // the rest of that week, rather than re-opening later the same day.
    const gateDate = fmtISO(mostRecentMondayGate(new Date()));
    const gateOpen = !settings.lastVarianceReviewDate || settings.lastVarianceReviewDate < gateDate;
    if (!gateOpen) return empty;

    const floorDates = Object.keys(floorActuals).sort();
    if (!floorDates.length) return empty;
    const unreviewed = floorDates.filter(d => !settings.lastVarianceReviewDate || d > settings.lastVarianceReviewDate);
    if (!unreviewed.length) return empty;

    // Notes the floor board logged on any day covered by this review —
    // read-only context alongside the offset, never itself a trigger for
    // anything.
    const notes = unreviewed.flatMap(d => (floorActuals[d]?.notes || []).map(text => ({ date: d, text })));

    const latestDate = unreviewed[unreviewed.length - 1];
    const benchTaps = floorActuals[latestDate]?.bench || {};
    let anchorJobId = null, anchorCount = -1;
    Object.entries(benchTaps).forEach(([jobId, count]) => {
      if (count > anchorCount) { anchorCount = count; anchorJobId = jobId; }
    });
    if (!anchorJobId) return { ...empty, unreviewedDays: unreviewed.length, latestDate, notes };

    const anchorJob = scheduled.find(j => j.id === anchorJobId);
    const benchTask = anchorJob?.tasks?.find(t => t.stage === "bench");
    if (!benchTask) return { ...empty, unreviewedDays: unreviewed.length, latestDate, notes };

    const latest = parseISO(latestDate);
    latest.setHours(0, 0, 0, 0);
    const schedOnly = new Date(benchTask.start.getTime());
    schedOnly.setHours(0, 0, 0, 0);
    const offsetDays = diffDays(latest, schedOnly);

    return { unreviewedDays: unreviewed.length, anchorJobId, anchorJobName: anchorJob.name, offsetDays, latestDate, notes };
  }, [floorActuals, settings.lastVarianceReviewDate, scheduled]);

  // Only worth surfacing if there's an actual mismatch to look at, OR the
  // floor left a note — a day that hit its target exactly but still had a
  // note worth reading (e.g. "close call, needed the extra hour") shouldn't
  // go unseen just because it didn't move the schedule.
  const varianceCount = (varianceReview.notes.length > 0 || (varianceReview.anchorJobId && varianceReview.offsetDays !== 0))
    ? varianceReview.unreviewedDays
    : 0;

  // Dry-run preview of what accepting the variance would change: which jobs'
  // install dates would move, and whether any NEW serious warnings would
  // appear. Nothing here touches real state — it's a hypothetical scheduleJobs
  // run purely for display, computed only while the review modal is open.
  const variancePreview = useMemo(() => {
    if (!showVarianceReview) return null;
    if (!varianceReview.anchorJobId || varianceReview.offsetDays === 0) return null;
    const newStartDate = fmtISO(addDays(parseISO(settings.startDate), varianceReview.offsetDays));
    const hypothetical = scheduleJobs(jobs, holidaySet, { ...settings, startDate: newStartDate });

    const moved = [];
    hypothetical.scheduled.forEach(job => {
      const before = scheduled.find(j => j.id === job.id);
      const installBefore = before?.tasks?.find(t => t.stage === "install");
      const installAfter = job.tasks?.find(t => t.stage === "install");
      if (!installBefore || !installAfter) return;
      const days = diffDays(installAfter.start, installBefore.start);
      if (days !== 0) {
        moved.push({ jobId: job.id, jobName: job.name, days, before: installBefore.start, after: installAfter.start });
      }
    });
    moved.sort((a, b) => Math.abs(b.days) - Math.abs(a.days));

    const beforeFP = new Set(warnings.filter(w => SERIOUS_WARNING_TYPES.has(w.type)).map(fingerprintFor));
    const newSerious = hypothetical.warnings.filter(w =>
      SERIOUS_WARNING_TYPES.has(w.type) && !beforeFP.has(fingerprintFor(w))
    );

    return { moved, newSerious, newStartDate };
  }, [showVarianceReview, varianceReview, jobs, holidaySet, settings, scheduled, warnings]);

  // Apply a weekly real-world check-in. Given today's date and the job that's
  // currently on the bench, compute the offset between where the scheduler had
  // that job and reality, then shift the global startDate by that offset so
  // every job slides forward (or back) by the same amount.
  const applyWeeklyUpdate = ({ benchJobId, machiningJobId, asOfDate, extraSettings }) => {
    if (!benchJobId && !machiningJobId) return;
    // Anchor on the bench job if given (more reliable), otherwise machining.
    const anchorJobId = benchJobId || machiningJobId;
    const anchorJob = scheduled.find(j => j.id === anchorJobId);
    if (!anchorJob) return;
    // "Today" defaults to right now (the manual check-in flow) — but the
    // variance review passes the actual floor-board date it previewed
    // against, so Accept applies exactly the offset that was shown, even if
    // the review happens a day or two after the floor data was recorded.
    const today = asOfDate ? new Date(asOfDate.getTime()) : new Date();
    today.setHours(0, 0, 0, 0);
    let scheduledStart;
    if (benchJobId) {
      const benchTask = anchorJob.tasks?.find(t => t.stage === "bench");
      if (!benchTask) return;
      scheduledStart = new Date(benchTask.start.getTime());
    } else {
      const machTask = anchorJob.tasks?.find(t => t.stage === "machining");
      if (!machTask) return;
      scheduledStart = new Date(machTask.start.getTime());
    }
    scheduledStart.setHours(0, 0, 0, 0);
    const offset = diffDays(today, scheduledStart);
    if (offset === 0) {
      setSettings({ ...settings, lastUpdateDate: fmtISO(today), ...extraSettings });
      return;
    }
    const newStartDate = addDays(parseISO(settings.startDate), offset);
    setSettings({
      ...settings,
      startDate: fmtISO(newStartDate),
      lastUpdateDate: fmtISO(today),
      ...extraSettings,
    });
  };

  // Parse a natural-language status update like:
  //   "Mr Smith started on the bench Friday and Mr Jones started machining today"
  // Returns { updates: [{jobId, jobName, stage, actualDate}], unparsed: [clause] }
  const parseStatusUpdate = (text) => {
    const updates = [];
    const unparsed = [];
    if (!text || !text.trim()) return { updates, unparsed };

    // Split on " and ", commas, semicolons, periods, " then " — these are clause boundaries
    const clauses = text.split(/\s+and\s+|,|;|\.\s+|\s+then\s+/i).map(c => c.trim()).filter(Boolean);

    for (const clause of clauses) {
      const lower = clause.toLowerCase();

      // Find which job is mentioned by looking for any job name (or distinctive
      // word from it) in the clause
      let matchedJob = null;
      let bestMatchLen = 0;
      for (const j of scheduled) {
        if (!j.name) continue;
        const jn = j.name.toLowerCase();
        // Try whole-name match first
        if (lower.includes(jn) && jn.length > bestMatchLen) {
          matchedJob = j;
          bestMatchLen = jn.length;
          continue;
        }
        // Then try matching distinctive name fragments (e.g. "smith" matches "Smith Kitchen")
        const namePieces = jn.split(/\s+/).filter(p => p.length >= 3 && !["the", "and", "kitchen", "living", "room", "house", "pantry", "utility", "bathrooms", "bathroom", "laundry", "office", "wic"].includes(p));
        for (const piece of namePieces) {
          const wordRegex = new RegExp(`\\b${piece}\\b`, "i");
          if (wordRegex.test(clause) && piece.length > bestMatchLen) {
            matchedJob = j;
            bestMatchLen = piece.length;
          }
        }
      }

      // Find which stage is mentioned
      let stage = null;
      if (/\bmachin/i.test(clause)) stage = "machining";
      else if (/\bbench/i.test(clause)) stage = "bench";
      else if (/\bfinish/i.test(clause)) stage = "finishing";
      else if (/\bre-?assembl/i.test(clause)) stage = "reassembly";
      else if (/\binstall/i.test(clause) || /\bfit/i.test(clause)) stage = "install";

      // Find the date phrase
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let actualDate = null;
      if (/\btoday\b|\bthis (?:morning|afternoon)\b/i.test(clause)) {
        actualDate = new Date(today.getTime());
      } else if (/\byesterday\b/i.test(clause)) {
        actualDate = addDays(today, -1);
      } else if (/\btomorrow\b/i.test(clause)) {
        actualDate = addDays(today, 1);
      } else {
        // Day names: monday, tuesday, etc.
        // Default to "most recent past instance" but flip to future if the
        // clause uses future-tense language ("will", "starting", "begins").
        const dayMatch = lower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
        if (dayMatch) {
          const targetDow = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"].indexOf(dayMatch[1]);
          const todayDow = today.getDay();
          const isFutureTense = /\b(will|begins?|gonna|going to)\b/i.test(clause)
                                || /\bnext\b/i.test(clause);
          if (isFutureTense) {
            // Future: next occurrence of that day
            let diff = targetDow - todayDow;
            if (diff <= 0) diff += 7;
            actualDate = addDays(today, diff);
          } else {
            // Past: most recent instance of that day
            let diff = todayDow - targetDow;
            if (diff <= 0) diff += 7;
            actualDate = addDays(today, -diff);
          }
        }
        // Explicit dd/mm or dd/mm/yy
        if (!actualDate) {
          const ddmm = clause.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
          if (ddmm) {
            const d = parseInt(ddmm[1]);
            const m = parseInt(ddmm[2]) - 1;
            let y = ddmm[3] ? parseInt(ddmm[3]) : today.getFullYear();
            if (y < 100) y += 2000;
            actualDate = new Date(y, m, d);
          }
        }
      }
      // Default date = today if "started" or "starting" or "started today" implied
      if (!actualDate && (/\bstart/i.test(clause) || /\bon the\b/i.test(clause))) {
        actualDate = new Date(today.getTime());
      }

      if (matchedJob && stage && actualDate) {
        updates.push({
          jobId: matchedJob.id,
          jobName: matchedJob.name,
          stage,
          actualDate,
        });
      } else {
        unparsed.push({
          clause,
          reason: !matchedJob ? "couldn't find a matching job"
                : !stage ? "couldn't find a stage (bench/machining/etc.)"
                : "couldn't find a date",
        });
      }
    }
    return { updates, unparsed };
  };

  // Take parsed updates and apply them as a startDate shift.
  // We use the FIRST update as the anchor (bench preferred, then machining).
  const applyParsedUpdates = (updates) => {
    if (!updates || updates.length === 0) return null;
    // Prefer a bench update as the anchor (more reliable), else machining
    const benchUpdate = updates.find(u => u.stage === "bench");
    const machUpdate = updates.find(u => u.stage === "machining");
    const anchor = benchUpdate || machUpdate || updates[0];
    const anchorJob = scheduled.find(j => j.id === anchor.jobId);
    if (!anchorJob) return null;
    const anchorTask = anchorJob.tasks?.find(t => t.stage === anchor.stage);
    if (!anchorTask) return null;
    const scheduledStart = new Date(anchorTask.start.getTime());
    scheduledStart.setHours(0, 0, 0, 0);
    const actualStart = new Date(anchor.actualDate.getTime());
    actualStart.setHours(0, 0, 0, 0);
    const offset = diffDays(actualStart, scheduledStart);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (offset === 0) {
      setSettings({ ...settings, lastUpdateDate: fmtISO(today) });
      return { offset: 0, anchor };
    }
    const newStartDate = addDays(parseISO(settings.startDate), offset);
    setSettings({
      ...settings,
      startDate: fmtISO(newStartDate),
      lastUpdateDate: fmtISO(today),
    });
    return { offset, anchor };
  };

  const addJob = () => {
    const j = newJob();
    setJobs(prev => [...prev, j]);
    setEditingJobId(j.id);
  };

  const updateJob = (id, patch) => {
    // Use the functional form so rapid successive updates (e.g. typing into a
    // text field) always see the latest state, not a stale closure value.
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
  };

  const deleteJob = (id) => {
    if (confirm("Delete this job?")) {
      setJobs(prev => prev.filter(j => j.id !== id));
      if (editingJobId === id) setEditingJobId(null);
    }
  };

  const [exportText, setExportText] = useState(null); // when set, shows export modal with raw JSON

  const exportData = () => {
    const data = JSON.stringify({ jobs, settings }, null, 2);
    // Try the download route first
    try {
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `evie-willow-schedule-${fmtISO(new Date())}.json`;
      // Must be in the DOM to be clickable in some browsers / sandboxes
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Give browsers a moment, then revoke
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error("Download failed:", err);
    }
    // ALWAYS also open the export modal as a guaranteed fallback —
    // user can copy from there if the download didn't actually trigger.
    setExportText(data);
  };

  const importData = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.jobs) setJobs(data.jobs);
        if (data.settings) setSettings(data.settings);
      } catch (err) { alert("Invalid file"); }
    };
    reader.readAsText(file);
  };

  if (loading) {
    return <div style={styles.loading}>Loading workshop schedule…</div>;
  }

  if (IS_BOARD) {
    return <FloorBoard scheduled={scheduled} dayLayout={dayLayout} jobs={jobs} />;
  }

  return (
    <div style={styles.app}>
      <Header
        onAddJob={addJob}
        onSettings={() => setShowSettings(true)}
        onWhatIf={() => setShowWhatIf(true)}
        onExport={exportData}
        onImport={importData}
        jobCount={jobs.length}
        warningCount={activeWarnings.length}
        onShowWarnings={() => setShowWarnings(true)}
        reminderCount={activeReminders.length}
        onShowReminders={() => setShowReminders(true)}
        onWeeklyUpdate={() => setShowWeeklyUpdate(true)}
        lastUpdateDate={settings.lastUpdateDate}
        varianceCount={varianceCount}
        onShowVarianceReview={() => setShowVarianceReview(true)}
        canUndo={historyStack.length > 0}
        canRedo={redoStack.length > 0}
        onUndo={undo}
        onRedo={redo}
      />

      {IS_READONLY && (
        <div style={{
          padding: "8px 24px",
          background: "#3a342c",
          color: "#faf6ec",
          fontSize: 11,
          letterSpacing: "0.12em",
          textAlign: "center",
          textTransform: "uppercase",
          fontWeight: 500,
        }}>
          Read-only · workshop view
        </div>
      )}

      {/* Status update prompt bar - only when editing */}
      {!IS_READONLY && (<>
      <div style={styles.updatePromptBar}>
        <div style={styles.updatePromptLabel}>
          <Calendar size={13} style={{ color: "#7a8b6f" }} />
          <span>What's happening today?</span>
        </div>
        <input
          type="text"
          style={styles.updatePromptInput}
          placeholder='e.g. "Smith Kitchen started on the bench today and Jones started machining today"'
          value={updatePromptText}
          onChange={e => setUpdatePromptText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              const { updates, unparsed } = parseStatusUpdate(updatePromptText);
              if (updates.length === 0) {
                setUpdateFeedback({
                  ok: false,
                  message: `Couldn't understand that. Try mentioning a job name + a stage (bench/machining) + a date.`,
                  updates: [],
                  unparsed,
                });
                return;
              }
              const result = applyParsedUpdates(updates);
              if (result) {
                setUpdateFeedback({
                  ok: true,
                  message: result.offset === 0
                    ? `Schedule is bang on. Recorded ${updates.length} update${updates.length === 1 ? "" : "s"}.`
                    : result.offset > 0
                    ? `Schedule was ${result.offset} day${result.offset === 1 ? "" : "s"} behind reality — slid everything forward.`
                    : `Schedule was ${Math.abs(result.offset)} day${result.offset === -1 ? "" : "s"} ahead — slid everything back.`,
                  updates,
                  unparsed,
                  offset: result.offset,
                });
                setUpdatePromptText("");
              }
            }
          }}
        />
        <button
          style={styles.btnPrimarySm}
          disabled={!updatePromptText.trim()}
          onClick={() => {
            const { updates, unparsed } = parseStatusUpdate(updatePromptText);
            if (updates.length === 0) {
              setUpdateFeedback({
                ok: false,
                message: `Couldn't understand that. Try mentioning a job name + a stage (bench/machining) + a date.`,
                updates: [],
                unparsed,
              });
              return;
            }
            const result = applyParsedUpdates(updates);
            if (result) {
              setUpdateFeedback({
                ok: true,
                message: result.offset === 0
                  ? `Schedule is bang on. Recorded ${updates.length} update${updates.length === 1 ? "" : "s"}.`
                  : result.offset > 0
                  ? `Schedule was ${result.offset} day${result.offset === 1 ? "" : "s"} behind reality — slid everything forward.`
                  : `Schedule was ${Math.abs(result.offset)} day${result.offset === -1 ? "" : "s"} ahead — slid everything back.`,
                updates,
                unparsed,
                offset: result.offset,
              });
              setUpdatePromptText("");
            }
          }}
        >Apply</button>
        {updateFeedback && (
          <button
            style={{ ...styles.iconBtn, color: "#9b8f7e" }}
            onClick={() => setUpdateFeedback(null)}
            title="Dismiss"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {updateFeedback && (
        <div style={{
          padding: "8px 24px",
          fontSize: 11,
          background: updateFeedback.ok ? "#ecf0e2" : "#f5e3dc",
          color: updateFeedback.ok ? "#5a6e50" : "#a5614f",
          borderBottom: "1px solid #d9cfba",
        }}>
          <strong>{updateFeedback.message}</strong>
          {updateFeedback.updates && updateFeedback.updates.length > 0 && (
            <span style={{ marginLeft: 10, color: "#7a6a55" }}>
              Updated: {updateFeedback.updates.map(u =>
                `${u.jobName} → ${u.stage} ${fmtUK(u.actualDate)}`
              ).join(" · ")}
            </span>
          )}
          {updateFeedback.unparsed && updateFeedback.unparsed.length > 0 && (
            <span style={{ marginLeft: 10, color: "#a5614f", fontStyle: "italic" }}>
              · Didn't parse: {updateFeedback.unparsed.map(u => `"${u.clause}" (${u.reason})`).join("; ")}
            </span>
          )}
        </div>
      )}
      </>)}{/* end of !IS_READONLY conditional */}

      <div style={styles.main}>
        <JobList
          jobs={scheduled}
          editingJobId={editingJobId}
          setEditingJobId={setEditingJobId}
          updateJob={updateJob}
          deleteJob={deleteJob}
        />
        <GanttView
          jobs={scheduled}
          startDate={parseISO(settings.startDate)}
          holidays={holidaySet}
          fitterHolidays={settings.fitterHolidays || []}
          onStageDrag={(jobId, stage, isoDate, usedFraction) => {
            const cfg = DRAGGABLE_STAGES[stage];
            if (!cfg) return;
            const patch = { [cfg.dateField]: isoDate };
            if (cfg.usedField) patch[cfg.usedField] = usedFraction || 0;
            updateJob(jobId, patch);
          }}
          onStageResize={(jobId, stage, days) => {
            const cfg = DRAGGABLE_STAGES[stage];
            if (!cfg) return;
            updateJob(jobId, { [cfg.daysField]: days });
          }}
          onStageReset={(jobId, stage) => {
            const cfg = DRAGGABLE_STAGES[stage];
            if (!cfg) return;
            const patch = { [cfg.dateField]: "", [cfg.daysField]: 0 };
            if (cfg.usedField) patch[cfg.usedField] = 0;
            updateJob(jobId, patch);
          }}
          onToggleLock={(jobId, scheduledJob) => {
            // When locking: snapshot the current install date, duration, and fitter
            // onto the job so the scheduler keeps them stable.
            const job = jobs.find(j => j.id === jobId);
            if (!job) return;
            if (job.locked) {
              // Unlocking — just clear the flag (keep overrides so the date doesn't jump)
              updateJob(jobId, { locked: false });
            } else {
              // Locking — snapshot current schedule values from the rendered job
              const installTask = scheduledJob?.tasks?.find(t => t.stage === "install");
              if (!installTask) {
                updateJob(jobId, { locked: true });
                return;
              }
              updateJob(jobId, {
                locked: true,
                installOverride: dayKey(installTask.start),
                installDaysOverride: Math.ceil(installTask.days),
                installer: installTask.installer || job.installer,
              });
            }
          }}
          onDeliveryDrag={(jobId, isoDate) => {
            updateJob(jobId, { deliveryDate: isoDate });
          }}
        />
      </div>

      {showWarnings && activeWarnings.length > 0 && (
        <WarningsModal
          warnings={activeWarnings}
          fingerprintFor={fingerprintFor}
          onApproveOne={(fp) => {
            setDismissedWarnings({ ...dismissedWarnings, [fp]: true });
          }}
          onApproveAll={() => {
            const all = { ...dismissedWarnings };
            activeWarnings.forEach(w => { all[fingerprintFor(w)] = true; });
            setDismissedWarnings(all);
            setShowWarnings(false);
          }}
          onClose={() => setShowWarnings(false)}
        />
      )}

      {showReminders && activeReminders.length > 0 && (
        <RemindersModal
          reminders={activeReminders}
          onDismissOne={(key) => {
            setDismissedReminders({ ...dismissedReminders, [key]: true });
          }}
          onDismissAll={() => {
            const all = { ...dismissedReminders };
            activeReminders.forEach(r => { all[r.dismissKey] = true; });
            setDismissedReminders(all);
            setShowReminders(false);
          }}
          onClose={() => setShowReminders(false)}
        />
      )}

      {showWeeklyUpdate && (
        <WeeklyUpdateModal
          jobs={scheduled}
          lastUpdateDate={settings.lastUpdateDate}
          onApply={(payload) => {
            applyWeeklyUpdate(payload);
            setShowWeeklyUpdate(false);
          }}
          onClose={() => setShowWeeklyUpdate(false)}
        />
      )}

      {showVarianceReview && (
        <VarianceReviewModal
          review={varianceReview}
          preview={variancePreview}
          onAccept={() => {
            // lastVarianceReviewDate records WHEN this week's check was
            // actioned (closing the weekly gate) — asOfDate keeps the offset
            // math anchored to the floor data actually being reviewed.
            applyWeeklyUpdate({
              benchJobId: varianceReview.anchorJobId,
              asOfDate: parseISO(varianceReview.latestDate),
              extraSettings: { lastVarianceReviewDate: fmtISO(new Date()) },
            });
            setShowVarianceReview(false);
          }}
          onDismiss={() => {
            setSettings({ ...settings, lastVarianceReviewDate: fmtISO(new Date()) });
            setShowVarianceReview(false);
          }}
          onClose={() => setShowVarianceReview(false)}
        />
      )}

      {exportText !== null && (
        <ExportTextModal text={exportText} onClose={() => setExportText(null)} />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          setSettings={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showWhatIf && (
        <WhatIfModal
          existingJobs={jobs}
          holidays={holidaySet}
          settings={settings}
          onClose={() => setShowWhatIf(false)}
          onConvertToJob={(hypoJob) => {
            setJobs([...jobs, hypoJob]);
            setEditingJobId(hypoJob.id);
            setShowWhatIf(false);
          }}
        />
      )}
    </div>
  );
}

function Header({ onAddJob, onSettings, onWhatIf, onExport, onImport, jobCount, warningCount, onShowWarnings, reminderCount, onShowReminders, onWeeklyUpdate, lastUpdateDate, varianceCount, onShowVarianceReview, canUndo, canRedo, onUndo, onRedo }) {
  const fileRef = useRef(null);
  // Show "needs check-in" hint if the last update was more than 7 days ago, or never
  const needsCheckin = (() => {
    if (!lastUpdateDate) return true;
    const last = parseISO(lastUpdateDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - last) / MS_DAY);
    return diff >= 7;
  })();
  return (
    <header style={styles.header}>
      <div>
        <div style={styles.brand}>EVIE WILLOW</div>
        <div style={styles.subbrand}>Workshop Production Schedule · {jobCount} jobs</div>
      </div>
      <div style={styles.headerActions}>
        {!IS_READONLY && (
          <>
            <button
              style={{ ...styles.btnGhost, opacity: canUndo ? 1 : 0.4, cursor: canUndo ? "pointer" : "default" }}
              onClick={onUndo}
              disabled={!canUndo}
              title="Undo"
            >
              <Undo2 size={14} />
            </button>
            <button
              style={{ ...styles.btnGhost, opacity: canRedo ? 1 : 0.4, cursor: canRedo ? "pointer" : "default" }}
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo"
            >
              <Redo2 size={14} />
            </button>
          </>
        )}
        <button
          style={needsCheckin ? styles.btnWarning : styles.btnGhost}
          onClick={onWeeklyUpdate}
          title={needsCheckin ? "Weekly check-in due" : "Weekly check-in"}
        >
          <Calendar size={14} />
          <span style={{ marginLeft: 4 }}>Check-in</span>
        </button>
        {reminderCount > 0 && (
          <button style={styles.btnReminder} onClick={onShowReminders} title="Survey reminders">
            <span style={{ fontSize: 13 }}>📋</span>
            <span style={{ marginLeft: 4 }}>{reminderCount}</span>
          </button>
        )}
        {varianceCount > 0 && (
          <button style={styles.btnReminder} onClick={onShowVarianceReview} title="Weekly floor board review">
            <span style={{ fontSize: 13 }}>📊</span>
            <span style={{ marginLeft: 4 }}>{varianceCount}</span>
          </button>
        )}
        {warningCount > 0 && (
          <button style={styles.btnWarning} onClick={onShowWarnings} title="Schedule notes">
            <AlertTriangle size={14} />
            <span style={{ marginLeft: 4 }}>{warningCount}</span>
          </button>
        )}
        <button style={styles.btnSecondary} onClick={onWhatIf}>
          <Calendar size={14} /> Quote a Job
        </button>
        <button style={styles.btnPrimary} onClick={onAddJob}>
          <Plus size={14} /> New Job
        </button>
        <button style={styles.btnGhost} onClick={onExport} title="Export">
          <Download size={14} />
        </button>
        <button style={styles.btnGhost} onClick={() => fileRef.current.click()} title="Import">
          <Upload size={14} />
        </button>
        <input
          type="file"
          ref={fileRef}
          accept=".json"
          style={{ display: "none" }}
          onChange={onImport}
        />
        <button style={styles.btnGhost} onClick={onSettings} title="Settings">
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
}

function ExportTextModal({ text, onClose }) {
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Fallback: select all and let user Ctrl+C
      if (textareaRef.current) {
        textareaRef.current.select();
        try {
          document.execCommand("copy");
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch (e) { /* user will copy manually */ }
      }
    }
  };

  const handleDownload = () => {
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `evie-willow-schedule.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert("Download failed. Use Copy to clipboard instead.");
    }
  };

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, width: 640, maxHeight: "85vh" }} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span>Export schedule data</span>
          <button style={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ ...styles.modalBody, paddingTop: 12 }}>
          <div style={{ fontSize: 11, color: "#7a6a55", marginBottom: 12, lineHeight: 1.6 }}>
            Below is your full schedule as JSON. Three ways to use it:
            <br /><br />
            <strong>1.</strong> Click <strong>Copy to clipboard</strong>, then paste into a text file
            (Notepad → File → Save As → name it <em>eviewillow.json</em> → set "Save as type" to <em>All files</em>).
            <br />
            <strong>2.</strong> Click <strong>Download file</strong> to save directly (if your browser allows it).
            <br />
            <strong>3.</strong> Or paste this JSON straight into the Vercel scheduler's import dialog if it accepts pasted text.
          </div>
          <textarea
            ref={textareaRef}
            value={text}
            readOnly
            onClick={e => e.target.select()}
            style={{
              width: "100%",
              height: 280,
              fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
              fontSize: 10,
              padding: 10,
              border: "1px solid #d9cfba",
              borderRadius: 3,
              background: "#fffefb",
              color: "#3a342c",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              style={{ ...styles.btnPrimary, flex: 1, justifyContent: "center" }}
              onClick={handleCopy}
            >
              {copied ? "✓ Copied!" : "📋 Copy to clipboard"}
            </button>
            <button
              style={{ ...styles.btnSecondary, flex: 1, justifyContent: "center" }}
              onClick={handleDownload}
            >
              <Download size={13} style={{ marginRight: 4 }} /> Download file
            </button>
            <button style={{ ...styles.btnGhost, justifyContent: "center", padding: "9px 14px" }} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function VarianceReviewModal({ review, preview, onAccept, onDismiss, onClose }) {
  const fmtShort = (d) => d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
  const latestLabel = review.latestDate ? fmtShort(parseISO(review.latestDate)) : "—";

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, width: 560, maxHeight: "85vh" }} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>📊</span>
            Floor board variance
          </span>
          <button style={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ ...styles.modalBody, paddingTop: 12 }}>
          {review.notes.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#3a342c", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Notes from the floor
              </div>
              {review.notes.map((n, i) => (
                <div key={i} style={{ background: "#fdfaf2", border: "1px dashed #c89072", borderRadius: 3, padding: "8px 10px", fontSize: 12, color: "#7a6a55", lineHeight: 1.5, marginBottom: 6 }}>
                  <span style={{ color: "#9b8f7e", fontSize: 10, display: "block", marginBottom: 2 }}>{fmtShort(parseISO(n.date))}</span>
                  {n.text}
                </div>
              ))}
            </div>
          )}
          {!review.anchorJobId ? (
            <div style={{ fontSize: 12, color: "#7a6a55", lineHeight: 1.6 }}>
              {review.notes.length > 0
                ? "Nothing in the floor board's activity points to a specific job on the bench to compare against, so there's no schedule change to consider — just the note above."
                : `The floor board has recorded activity as of ${latestLabel}, but nothing in it points to a specific job on the bench to compare against. Nothing to review.`}
            </div>
          ) : review.offsetDays === 0 ? (
            <div style={{ fontSize: 12, color: "#7a6a55", lineHeight: 1.6 }}>
              As of {latestLabel}, the floor board shows <strong>{review.anchorJobName}</strong> on the bench — exactly where the schedule already has it. No change needed.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: "#3a342c", marginBottom: 10, lineHeight: 1.6 }}>
                As of <strong>{latestLabel}</strong>, the floor board shows <strong>{review.anchorJobName}</strong> was the main job on the bench that day. The schedule has that job's bench starting{" "}
                {review.offsetDays > 0
                  ? <>{review.offsetDays} day{review.offsetDays === 1 ? "" : "s"} earlier than that</>
                  : <>{Math.abs(review.offsetDays)} day{review.offsetDays === -1 ? "" : "s"} later than that</>}.
              </div>
              <div style={{ fontSize: 11, color: "#7a6a55", marginBottom: 16, lineHeight: 1.55 }}>
                Accepting will shift the whole schedule {review.offsetDays > 0 ? "forward" : "back"} by {Math.abs(review.offsetDays)} day{Math.abs(review.offsetDays) === 1 ? "" : "s"} — same as a manual check-in, just anchored on what the floor actually taped in. Nothing changes until you press Accept.
              </div>

              {preview && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#3a342c", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    What would move
                  </div>
                  {preview.moved.length === 0 ? (
                    <div style={{ fontSize: 12, color: "#5a6e50", marginBottom: 14 }}>No install dates would move.</div>
                  ) : (
                    <div style={{ marginBottom: 14, maxHeight: 180, overflowY: "auto" }}>
                      {preview.moved.map(m => (
                        <div key={m.jobId} style={styles.warningItemRow}>
                          <span style={{ flex: 1, fontSize: 12, color: "#3a342c" }}>{m.jobName}</span>
                          <span style={{ fontSize: 11, color: "#7a6a55" }}>
                            {fmtShort(m.before)} → {fmtShort(m.after)} ({m.days > 0 ? "+" : ""}{m.days}d)
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {preview.newSerious.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#a5614f", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        New warnings this would introduce
                      </div>
                      {preview.newSerious.map((w, i) => (
                        <div key={i} style={styles.warningItemRow}>
                          <span style={{ ...styles.warningTypeTag, background: warningColorFor(w.type) }}>
                            {warningLabelFor(w.type)}
                          </span>
                          <span style={{ flex: 1, fontSize: 12, color: "#3a342c", lineHeight: 1.5 }}>{w.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button style={styles.btnGhost} onClick={onDismiss}>
              {review.anchorJobId && review.offsetDays !== 0 ? "Not now" : "OK"}
            </button>
            {review.anchorJobId && review.offsetDays !== 0 && (
              <button style={styles.btnPrimary} onClick={onAccept}>Accept &amp; shift schedule</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WeeklyUpdateModal({ jobs, lastUpdateDate, onApply, onClose }) {
  const [benchJobId, setBenchJobId] = useState("");
  const [machiningJobId, setMachiningJobId] = useState("");

  const today = new Date();
  const todayLabel = today.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  // Pre-compute scheduled bench/machining dates for each job so we can show
  // what the scheduler currently thinks
  const jobsWithStages = jobs
    .map(j => {
      const bench = j.tasks?.find(t => t.stage === "bench");
      const mach = j.tasks?.find(t => t.stage === "machining");
      return {
        id: j.id,
        name: j.name || "(unnamed)",
        benchStart: bench ? bench.start : null,
        machStart: mach ? mach.start : null,
      };
    })
    .filter(j => j.benchStart || j.machStart)
    .sort((a, b) => {
      const aD = a.benchStart || a.machStart;
      const bD = b.benchStart || b.machStart;
      return aD - bD;
    });

  const fmtShort = (d) => d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—";

  // Preview the shift that would happen
  let previewOffset = null;
  let previewAnchorName = "";
  let previewAnchorScheduled = null;
  if (benchJobId || machiningJobId) {
    const anchor = jobsWithStages.find(j => j.id === (benchJobId || machiningJobId));
    if (anchor) {
      previewAnchorName = anchor.name;
      previewAnchorScheduled = benchJobId ? anchor.benchStart : anchor.machStart;
      if (previewAnchorScheduled) {
        const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const schedOnly = new Date(previewAnchorScheduled.getFullYear(), previewAnchorScheduled.getMonth(), previewAnchorScheduled.getDate());
        previewOffset = Math.round((todayOnly - schedOnly) / MS_DAY);
      }
    }
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, width: 520, maxHeight: "85vh" }} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Calendar size={14} style={{ color: "#7a8b6f" }} />
            Weekly check-in
          </span>
          <button style={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ ...styles.modalBody, paddingTop: 12 }}>
          <div style={{ fontSize: 12, color: "#3a342c", marginBottom: 6, fontFamily: "'Cormorant Garamond', 'Georgia', serif" }}>
            Today is <strong>{todayLabel}</strong>
          </div>
          {lastUpdateDate && (
            <div style={{ fontSize: 10, color: "#9b8f7e", marginBottom: 14, fontStyle: "italic" }}>
              Last check-in: {(() => {
                const d = parseISO(lastUpdateDate);
                return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
              })()}
            </div>
          )}
          <div style={{ fontSize: 11, color: "#7a6a55", marginBottom: 16, lineHeight: 1.55 }}>
            Tell me what's actually happening on the workshop floor today.
            I'll shift the schedule forward or back so it matches reality.
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Job on the bench right now</label>
            <select
              style={styles.input}
              value={benchJobId}
              onChange={e => setBenchJobId(e.target.value)}
            >
              <option value="">— pick a job —</option>
              {jobsWithStages.filter(j => j.benchStart).map(j => (
                <option key={j.id} value={j.id}>
                  {j.name} (scheduled bench: {fmtShort(j.benchStart)})
                </option>
              ))}
            </select>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Job starting machining today (optional)</label>
            <select
              style={styles.input}
              value={machiningJobId}
              onChange={e => setMachiningJobId(e.target.value)}
            >
              <option value="">— pick a job —</option>
              {jobsWithStages.filter(j => j.machStart).map(j => (
                <option key={j.id} value={j.id}>
                  {j.name} (scheduled machining: {fmtShort(j.machStart)})
                </option>
              ))}
            </select>
          </div>

          {previewOffset !== null && previewAnchorScheduled && (
            <div style={{
              marginTop: 14,
              padding: "10px 12px",
              background: previewOffset === 0 ? "#ecf0e2"
                        : previewOffset > 0 ? "#f5e7d4"
                        : "#e2eaf2",
              border: "1px solid " + (previewOffset === 0 ? "#7a8b6f"
                                     : previewOffset > 0 ? "#c89072"
                                     : "#7a9eaa"),
              borderRadius: 3,
              fontSize: 11,
              color: "#3a342c",
              lineHeight: 1.55,
            }}>
              <strong>{previewAnchorName}</strong> was scheduled to be at this stage on <strong>{fmtUK(previewAnchorScheduled)}</strong>.
              {previewOffset === 0
                ? <> The schedule is bang on — no change needed.</>
                : previewOffset > 0
                ? <> The schedule is <strong>{previewOffset} day{previewOffset === 1 ? "" : "s"} behind</strong> reality. Applying will slide everything forward by {previewOffset} day{previewOffset === 1 ? "" : "s"}.</>
                : <> The schedule is <strong>{Math.abs(previewOffset)} day{previewOffset === -1 ? "" : "s"} ahead</strong> of reality. Applying will slide everything back by {Math.abs(previewOffset)} day{previewOffset === -1 ? "" : "s"}.</>
              }
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 18, paddingTop: 14, borderTop: "1px solid #d9cfba" }}>
            <button
              style={{ ...styles.btnPrimary, flex: 1, justifyContent: "center" }}
              disabled={!benchJobId && !machiningJobId}
              onClick={() => onApply({ benchJobId, machiningJobId })}
            >
              ✓ Apply update
            </button>
            <button style={{ ...styles.btnGhost, flex: 1, justifyContent: "center", padding: "9px 14px" }} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RemindersModal({ reminders, onDismissOne, onDismissAll, onClose }) {
  const fmtDate = (d) => d.toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric"
  });
  const today = new Date();
  const daysDiff = (d) => {
    const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const other = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((t - other) / MS_DAY);
  };

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, width: 520, maxHeight: "80vh" }} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>📋</span>
            Final Survey Reminders ({reminders.length})
          </span>
          <button style={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ ...styles.modalBody, paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: "#aaa", marginBottom: 14, lineHeight: 1.5 }}>
            Time to book final surveys for these jobs — install is 5 working weeks away.
          </div>

          {reminders.map((r, i) => {
            const overdue = daysDiff(r.surveyDate);
            return (
              <div key={i} style={styles.reminderRow}>
                <div style={{ flex: 1 }}>
                  <div style={styles.reminderJobName}>{r.jobName}</div>
                  <div style={styles.reminderDates}>
                    Survey due: <span style={{ color: overdue > 0 ? "#e89080" : "#d17d2a" }}>
                      {fmtDate(r.surveyDate)}
                      {overdue > 0 ? ` · ${overdue} day${overdue > 1 ? "s" : ""} overdue` : " · due today"}
                    </span>
                  </div>
                  <div style={styles.reminderDates}>
                    Install: {fmtDate(r.installDate)}
                  </div>
                </div>
                <button
                  style={styles.btnGhostSm}
                  onClick={() => onDismissOne(r.dismissKey)}
                  title="Dismiss this reminder"
                >
                  ✓ Done
                </button>
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 8, marginTop: 16, paddingTop: 14, borderTop: "1px solid #2a2a2a" }}>
            <button style={{ ...styles.btnPrimary, flex: 1, justifyContent: "center" }} onClick={onDismissAll}>
              ✓ All booked
            </button>
            <button style={{ ...styles.btnGhost, flex: 1, justifyContent: "center", padding: "8px 14px" }} onClick={onClose}>
              Remind me later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WarningsModal({ warnings, fingerprintFor, onApproveOne, onApproveAll, onClose }) {
  // Group warnings by job for clearer presentation
  const byJob = {};
  const global = [];
  warnings.forEach(w => {
    if (w.jobName) {
      if (!byJob[w.jobName]) byJob[w.jobName] = [];
      byJob[w.jobName].push(w);
    } else {
      global.push(w);
    }
  });

  const renderRow = (w, i) => (
    <div key={i} style={styles.warningItemRow}>
      <span style={{
        ...styles.warningTypeTag,
        background: warningColorFor(w.type),
      }}>
        {warningLabelFor(w.type)}
      </span>
      <span style={{ flex: 1, fontSize: 12, color: "#3a342c", lineHeight: 1.5 }}>{w.message}</span>
      <button
        style={{
          ...styles.btnGhostSm,
          padding: "3px 9px",
          fontSize: 10,
          flexShrink: 0,
        }}
        onClick={() => onApproveOne(fingerprintFor(w))}
        title="Approve this note — won't show again unless the situation changes"
      >
        ✓ OK
      </button>
    </div>
  );

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, width: 580, maxHeight: "80vh" }} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={14} style={{ color: "#a07a3a" }} />
            Schedule notes ({warnings.length})
          </span>
          <button style={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{ ...styles.modalBody, paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: "#7a6a55", marginBottom: 14, lineHeight: 1.5 }}>
            The scheduler made these decisions. Approve each one to dismiss it, or approve all. Once approved, a note won't reappear unless the underlying situation changes.
          </div>

          {Object.entries(byJob).map(([jobName, ws]) => (
            <div key={jobName} style={styles.warningJobGroup}>
              <div style={styles.warningJobHeader}>{jobName}</div>
              {ws.map(renderRow)}
            </div>
          ))}

          {global.length > 0 && (
            <div style={styles.warningJobGroup}>
              <div style={styles.warningJobHeader}>General</div>
              {global.map(renderRow)}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 16, paddingTop: 14, borderTop: "1px solid #d9cfba" }}>
            <button style={{ ...styles.btnPrimary, flex: 1, justifyContent: "center" }} onClick={onApproveAll}>
              ✓ Approve all
            </button>
            <button style={{ ...styles.btnGhost, flex: 1, justifyContent: "center", padding: "9px 14px" }} onClick={onClose}>
              Review later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function warningColorFor(type) {
  switch (type) {
    case "installer":          return "#6b4f8a"; // purple — fitter swap (auto)
    case "installer_conflict": return "#8a6b3a"; // amber — overlap allowed, routine notice
    case "sibling":            return "#3a6b5a"; // green — pairing
    case "bunching":           return "#c44a3a"; // red — capacity issue
    case "target_stagger":     return "#c47a2a"; // orange — date moved
    case "target_unreachable": return "#c44a3a"; // red — hard miss
    case "install_nudged":     return "#c47a2a"; // orange — date auto-corrected
    case "slip":               return "#c44a3a";
    case "buffer_tight":       return "#c47a2a"; // orange — buffer compressed
    case "buffer_too_tight":   return "#8a6b3a"; // amber — overlap allowed, routine notice
    case "bench_gap":          return "#8a6b3a"; // amber — routine, bell only
    case "booth_run_mismatch": return "#8a6b3a"; // amber — routine, bell only
    case "load":
    case "install_load":       return "#8a6b3a"; // amber — info
    default:                   return "#555";
  }
}

function warningLabelFor(type) {
  switch (type) {
    case "installer":          return "FITTER";
    case "installer_conflict": return "FITTER";
    case "sibling":            return "PAIR";
    case "bunching":           return "BENCH";
    case "target_stagger":     return "DATE";
    case "target_unreachable": return "TARGET";
    case "install_nudged":     return "NUDGED";
    case "slip":               return "SLIP";
    case "buffer_tight":       return "BUFFER";
    case "buffer_too_tight":   return "BUFFER";
    case "bench_gap":          return "GAP";
    case "booth_run_mismatch": return "BOOTH";
    case "load":
    case "install_load":       return "LOAD";
    default:                   return "NOTE";
  }
}

function JobList({ jobs, editingJobId, setEditingJobId, updateJob, deleteJob }) {
  return (
    <div style={styles.jobList}>
      <div style={styles.jobListHeader}>JOBS</div>
      {jobs.length === 0 && (
        <div style={styles.empty}>No jobs yet. Click "New Job" to add one.</div>
      )}
      {jobs.map(job => (
        <JobRow
          key={job.id}
          job={job}
          isEditing={editingJobId === job.id}
          onSelect={() => setEditingJobId(editingJobId === job.id ? null : job.id)}
          onUpdate={(patch) => updateJob(job.id, patch)}
          onDelete={() => deleteJob(job.id)}
        />
      ))}
    </div>
  );
}

function JobRow({ job, isEditing, onSelect, onUpdate, onDelete }) {
  const installTask = job.tasks?.find(t => t.stage === "install");
  return (
    <div style={{ ...styles.jobRow, ...(isEditing ? styles.jobRowActive : {}) }}>
      <div style={styles.jobRowSummary} onClick={onSelect}>
        <div style={styles.jobName}>
          {job.name || <span style={{ opacity: 0.4 }}>Unnamed job</span>}
        </div>
        <div style={styles.jobMeta}>
          {totalCabinets(job)} cab · {job.benchDays || benchDaysForJob(job)}d bench
          {job.installer && ` · ${job.installer}`}
        </div>
        {installTask && (
          <div style={styles.jobInstallWeek}>
            {fmtWeekCommencing(installTask.start)}
          </div>
        )}
      </div>
      {isEditing && (
        <JobEditor job={job} onUpdate={onUpdate} onDelete={onDelete} />
      )}
    </div>
  );
}

// "Manually adjusted" panel shown under a stage's schedule fields when that
// stage has a date and/or duration override set (from a Gantt drag/resize).
// One "Reset to auto" button clears both fields for the stage. Shared across
// machining, bench, finishing and reassembly — install has its own two
// panels further down (differently styled, tied to the lock UI), so it
// isn't folded in here.
function OverridePanel({ stageLabel, job, onUpdate, dateField, daysField, usedField }) {
  const dateVal = job[dateField];
  const daysVal = job[daysField];
  const usedVal = usedField ? (job[usedField] || 0) : 0;
  if (!dateVal && !(daysVal && daysVal > 0)) return null;
  return (
    <div style={{
      marginTop: 6,
      padding: "6px 10px",
      background: "#fdfaf2",
      border: "1px dashed #c89072",
      borderRadius: 3,
      fontSize: 10,
      color: "#7a6a55",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    }}>
      <span>
        {stageLabel} manually adjusted
        {dateVal && ` · starts ${fmtUK(parseISO(dateVal))}${usedVal > 0 ? " (half day)" : ""}`}
        {daysVal > 0 && ` · ${daysVal} day${daysVal === 1 ? "" : "s"}`}
      </span>
      <button
        style={{ ...styles.btnGhost, padding: "3px 8px", fontSize: 10 }}
        onClick={() => onUpdate({ [dateField]: "", [daysField]: 0, ...(usedField ? { [usedField]: 0 } : {}) })}
      >
        Reset to auto
      </button>
    </div>
  );
}

function JobEditor({ job, onUpdate, onDelete }) {
  return (
    <div style={styles.jobEditor}>
      <div style={styles.field}>
        <label style={styles.label}>Job name</label>
        <input
          style={styles.input}
          value={job.name}
          onChange={e => onUpdate({ name: e.target.value })}
          placeholder="e.g. Belchamber"
        />
      </div>

      <div style={styles.fieldGroup}>
        <div style={styles.fieldGroupLabel}>Cabinet mix</div>
        {Object.entries(CABINET_TYPES).map(([key, type]) => (
          <div key={key} style={styles.cabRow}>
            <span style={{ ...styles.cabSwatch, background: type.color }} />
            <span style={styles.cabLabel}>{type.label}</span>
            <span style={styles.cabRate}>{type.rate}/day</span>
            <input
              type="number"
              min="0"
              style={styles.numInput}
              value={job.cabinets[key]}
              onChange={e => onUpdate({
                cabinets: { ...job.cabinets, [key]: parseInt(e.target.value) || 0 }
              })}
            />
          </div>
        ))}
      </div>

      <div style={styles.fieldGroup}>
        <div style={styles.fieldGroupLabel}>Colour</div>
        <div style={styles.row2}>
          <div style={styles.field}>
            <label style={styles.labelSm}>Name</label>
            <input
              style={styles.input}
              value={job.colour?.name || ""}
              onChange={e => onUpdate({ colour: { ...(job.colour || {}), name: e.target.value } })}
              placeholder="e.g. Mizzle"
            />
          </div>
          <div style={styles.field}>
            <label style={styles.labelSm}>Swatch</label>
            <input
              type="color"
              style={{ ...styles.input, padding: 2, height: 34 }}
              value={job.colour?.hex || "#c9a961"}
              onChange={e => onUpdate({ colour: { ...(job.colour || {}), hex: e.target.value } })}
            />
          </div>
        </div>
        <div style={styles.field}>
          <label style={styles.labelSm}>Booth run (optional — jobs sprayed together)</label>
          <input
            style={styles.input}
            value={job.boothRunId || ""}
            onChange={e => onUpdate({ boothRunId: e.target.value })}
            placeholder="e.g. same reference on both jobs to pair them"
          />
        </div>
      </div>

      <FeaturesEditor
        features={job.features || []}
        onUpdate={(features) => onUpdate({ features })}
      />

      <div style={styles.fieldGroup}>
        <div style={styles.fieldGroupLabel}>Schedule</div>
        <div style={styles.row2}>
          <div style={styles.field}>
            <label style={styles.labelSm}>Machining days</label>
            <input
              type="number" min="1"
              style={styles.input}
              value={job.machiningDays}
              onChange={e => onUpdate({ machiningDays: parseInt(e.target.value) || 1 })}
            />
          </div>
          <div style={styles.field}>
            <label style={styles.labelSm}>Install date (exact day)</label>
            <input
              type="date"
              style={styles.input}
              value={job.targetInstallWeek}
              onChange={e => onUpdate({ targetInstallWeek: e.target.value })}
            />
          </div>
        </div>
        <OverridePanel stageLabel="Machining" job={job} onUpdate={onUpdate} dateField="machiningOverride" daysField="machiningDaysOverride" />
        <OverridePanel stageLabel="Bench" job={job} onUpdate={onUpdate} dateField="benchOverride" daysField="benchDaysOverride" usedField="benchOverrideUsed" />
        <OverridePanel stageLabel="Finishing" job={job} onUpdate={onUpdate} dateField="finishingOverride" daysField="finishingDaysOverride" usedField="finishingOverrideUsed" />
        <OverridePanel stageLabel="Re-assembly" job={job} onUpdate={onUpdate} dateField="reassemblyOverride" daysField="reassemblyDaysOverride" usedField="reassemblyOverrideUsed" />
        <div style={styles.row2}>
          <div style={styles.field}>
            <label style={styles.labelSm}>Installer</label>
            <select
              style={{ ...styles.input, opacity: job.teamInstall ? 0.5 : 1 }}
              value={job.installer}
              disabled={job.teamInstall}
              onChange={e => onUpdate({ installer: e.target.value })}
            >
              <option value="auto">Auto-assign</option>
              {FITTERS.map(f => (
                <option key={f} value={f}>
                  {f}{FITTER_CONFIG[f].role === "lead" ? " (lead)"
                   : FITTER_CONFIG[f].role === "support" ? " (support)" : ""}
                </option>
              ))}
              {NON_FITTERS.map(f => <option key={f} value={f}>{f} (not a fitter)</option>)}
            </select>
          </div>
          <div style={styles.field}>
            <label style={styles.labelSm}>Secondary fitter (optional)</label>
            <select
              style={{ ...styles.input, opacity: job.teamInstall ? 0.5 : 1 }}
              value={job.secondaryInstaller || ""}
              disabled={job.teamInstall}
              onChange={e => onUpdate({ secondaryInstaller: e.target.value })}
            >
              <option value="">None — solo install</option>
              {FITTERS.filter(f => f !== job.installer).map(f => (
                <option key={f} value={f}>+ {f}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={styles.row2}>
          <div style={styles.field}>
            <label style={styles.labelSm}>Manual start (override)</label>
            <input
              type="date"
              style={styles.input}
              value={job.manualStart}
              onChange={e => onUpdate({ manualStart: e.target.value })}
            />
          </div>
          <div></div>
        </div>

        <div style={{
          marginTop: 8,
          padding: "8px 10px",
          background: job.teamInstall ? "#ecf0e2" : "#fdfaf2",
          border: "1px solid " + (job.teamInstall ? "#7a8b6f" : "#d9cfba"),
          borderRadius: 3,
          fontSize: 11,
          color: "#3a342c",
        }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={!!job.teamInstall}
              onChange={e => onUpdate({ teamInstall: e.target.checked })}
              style={{ cursor: "pointer" }}
            />
            <span style={{ flex: 1 }}>
              <strong>Team install</strong> — all 3 fitters on site (for distant jobs)
            </span>
          </label>
          {job.teamInstall && (
            <div style={{ marginTop: 6, marginLeft: 24, fontSize: 10, color: "#7a6a55", lineHeight: 1.5 }}>
              Steve, Thompson and Chris all blocked out for this install.
              Set the install length manually using the drag handle on the bar.
            </div>
          )}
        </div>
      </div>

      {job.installOverride && (
        <div style={{
          marginBottom: 12,
          padding: "8px 10px",
          background: "#f5e7d4",
          border: "1px solid #c89072",
          borderRadius: 3,
          fontSize: 11,
          color: "#7a6a55",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ flex: 1 }}>
            Install pinned to <strong style={{ color: "#3a342c" }}>{fmtUK(job.installOverride)}</strong> by drag
          </span>
          <button
            style={styles.btnGhostSm}
            onClick={() => onUpdate({ installOverride: "" })}
          >
            Clear
          </button>
        </div>
      )}

      {job.installDaysOverride > 0 && (
        <div style={{
          marginBottom: 12,
          padding: "8px 10px",
          background: "#ecf0e2",
          border: "1px solid #a3b394",
          borderRadius: 3,
          fontSize: 11,
          color: "#5a6e50",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          <span style={{ flex: 1 }}>
            Install length set to <strong style={{ color: "#3a342c" }}>{job.installDaysOverride} day{job.installDaysOverride === 1 ? "" : "s"}</strong> manually
          </span>
          <button
            style={styles.btnGhostSm}
            onClick={() => onUpdate({ installDaysOverride: 0 })}
          >
            Reset
          </button>
        </div>
      )}

      <div style={styles.field}>
        <label style={styles.labelSm}>Notes</label>
        <textarea
          style={{ ...styles.input, minHeight: 50, resize: "vertical", fontFamily: "inherit" }}
          value={job.notes}
          onChange={e => onUpdate({ notes: e.target.value })}
        />
      </div>

      <button style={styles.btnDanger} onClick={onDelete}>
        <Trash2 size={12} /> Delete job
      </button>
    </div>
  );
}

// ============================================================
// GANTT VIEW
// ============================================================

// Pure Gantt bar-positioning helpers, hoisted to module scope rather than
// defined as closures inside GanttView. A closure gets a fresh identity on
// every render; a module-level function never does — which is what lets
// GanttRow (below) be wrapped in React.memo and actually skip re-rendering
// rows untouched by a drag, instead of comparing "changed" function props on
// every one of them every frame.
const GANTT_WORKSHOP_STAGES = new Set(["machining", "bench", "finishing", "reassembly"]);

function ganttXFor(date, ganttStart, colWidth) {
  return diffDays(date, ganttStart) * colWidth;
}

// Position bars using fractional-day precision when available. `used` is a
// fraction of the FULL day (0 to that day's capacity), so it maps directly
// onto a proportional slice of the day's column width — a Friday bar simply
// never fills past ~0.44 of the column, reflecting its shorter capacity.
function ganttBarLeftFor(task, ganttStart, colWidth) {
  if (task.startSlot) {
    const dayOffset = diffDays(task.startSlot.date, ganttStart);
    return dayOffset * colWidth + (task.startSlot.used * colWidth);
  }
  return ganttXFor(task.start, ganttStart, colWidth);
}

function ganttBarWidthFor(task, ganttStart, colWidth) {
  if (task.startSlot && task.endSlot) {
    const left = ganttBarLeftFor(task, ganttStart, colWidth);
    const endDayOffset = diffDays(task.endSlot.date, ganttStart);
    const right = endDayOffset * colWidth + (task.endSlot.used * colWidth);
    return Math.max(right - left - 1, 6);
  }
  // Whole-day tasks: use start→end span
  return Math.max(diffDays(task.end, task.start) * colWidth - 1, 6);
}

// Split a task into one or more segments so bars don't cross weekends/holidays.
// Returns array of {left, width} pairs.
function ganttSegmentsFor(task, ganttStart, colWidth, holidays) {
  const segments = [];
  const fullLeft = ganttBarLeftFor(task, ganttStart, colWidth);
  const fullWidth = ganttBarWidthFor(task, ganttStart, colWidth);
  if (fullWidth <= 0) return segments;
  const fullRight = fullLeft + fullWidth;
  const isWorkshop = GANTT_WORKSHOP_STAGES.has(task.stage);

  // Walk each day in the task's span; emit segments broken by non-working days.
  // For workshop stages, also break/truncate at Friday afternoons (workshop closed).
  let segStart = null;
  const taskStartDate = task.startSlot ? task.startSlot.date : task.start;
  const taskEndDate = task.end;
  let cur = new Date(taskStartDate.getTime());
  while (cur < taskEndDate) {
    const isNonWorking = isWeekend(cur) || holidays.has(dayKey(cur));
    const isFriday = cur.getDay() === 5 && !isNonWorking;
    const dayIdx = diffDays(cur, ganttStart);
    const dayLeft = dayIdx * colWidth;

    if (isNonWorking) {
      // End any open segment just before this day
      if (segStart !== null) {
        segments.push({
          left: segStart,
          width: Math.max(Math.min(dayLeft, fullRight) - segStart - 1, 4),
        });
        segStart = null;
      }
    } else if (isFriday && isWorkshop) {
      // Workshop stages close Friday at 11am (0.44 of a day), not midday.
      if (segStart === null) {
        segStart = Math.max(dayLeft, fullLeft);
      }
      const segEnd = Math.min(dayLeft + colWidth * FRIDAY_DAY_FRACTION, fullRight);
      if (segEnd > segStart) {
        segments.push({
          left: segStart,
          width: Math.max(segEnd - segStart - 1, 4),
        });
      }
      segStart = null;
    } else {
      // Working day — either open a new segment or extend
      if (segStart === null) {
        segStart = Math.max(dayLeft, fullLeft);
      }
    }
    cur = addDays(cur, 1);
  }
  // Close final segment
  if (segStart !== null) {
    segments.push({
      left: segStart,
      width: Math.max(fullRight - segStart - 1, 4),
    });
  }
  return segments;
}

function GanttView({ jobs, startDate, holidays, fitterHolidays, onStageDrag, onStageResize, onStageReset, onToggleLock, onDeliveryDrag }) {
  const COL_WIDTH = 36;       // wider so day numbers are readable
  const ROW_HEIGHT = 64;

  // Drag state for install bar adjustment
  const [dragState, setDragState] = useState(null);
  // dragState: { jobId, originalLeft, originalDate, currentLeft, currentDate, width }

  // Resize state for install bar duration adjustment
  const [resizeState, setResizeState] = useState(null);
  // resizeState: { jobId, currentLeft, currentWidth, currentDays }

  // Drag state for delivery icon
  const [deliveryDragState, setDeliveryDragState] = useState(null);
  // deliveryDragState: { jobId, currentLeft, currentDate }

  // Chart geometry (day columns, month/week groupings) depends only on the
  // jobs' dates and the workshop start date — memoized so a drag (which only
  // ever touches local dragState) doesn't reallocate any of it every frame.
  // That stability is what lets GanttRow's memoization below actually skip
  // re-rendering the rows not involved in the drag.
  const chart = useMemo(() => {
    const allDates = jobs.flatMap(j => (j.tasks || []).flatMap(t => [t.start, t.end]));
    if (allDates.length === 0) return null;
    const minDate = new Date(Math.min(...allDates.map(d => d.getTime()), startDate.getTime()));
    const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));
    // Round minDate down to Monday
    const dow = minDate.getDay();
    const offsetToMon = dow === 0 ? -6 : 1 - dow;
    const ganttStart = addDays(minDate, offsetToMon);
    // Pad end by a week and round up to a Sunday
    let ganttEnd = addDays(maxDate, 7);
    while (ganttEnd.getDay() !== 0) ganttEnd = addDays(ganttEnd, 1);
    const totalDays = diffDays(ganttEnd, ganttStart);

    // Build day columns
    const days = [];
    for (let i = 0; i < totalDays; i++) {
      days.push(addDays(ganttStart, i));
    }

    // Build month groupings
    const months = [];
    let curMonth = null;
    days.forEach((d, i) => {
      const m = d.toLocaleString("en-GB", { month: "long", year: "numeric" });
      if (m !== curMonth) {
        months.push({ label: m, startIdx: i, count: 0 });
        curMonth = m;
      }
      months[months.length - 1].count++;
    });

    // Build week groupings (Mon–Sun)
    const weeks = [];
    days.forEach((d, i) => {
      if (d.getDay() === 1 || i === 0) {
        weeks.push({
          label: "w/c " + d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
          startIdx: i,
          count: 0,
          date: d,
        });
      }
      weeks[weeks.length - 1].count++;
    });

    return { ganttStart, ganttEnd, totalDays, days, months, weeks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, startDate]);

  // Rows flow top-to-bottom in the order each job's earliest stage actually
  // starts, so dragging a job's bench (etc.) earlier than another job visibly
  // moves it up the chart to match — an even flow down the page instead of a
  // fixed, drag-independent order.
  const orderedJobs = useMemo(() => {
    const earliestStart = (job) => {
      if (!job.tasks || !job.tasks.length) return Infinity;
      return Math.min(...job.tasks.map(t => t.start.getTime()));
    };
    return [...jobs].sort((a, b) => earliestStart(a) - earliestStart(b));
  }, [jobs]);

  if (!chart) {
    return (
      <div style={styles.gantt}>
        <div style={styles.empty}>Add jobs to see the schedule.</div>
      </div>
    );
  }
  const { ganttStart, totalDays, days, months, weeks } = chart;

  const today = dayKey(new Date());

  return (
    <div style={styles.gantt}>
      <div style={styles.ganttScroll}>
        <div style={{ minWidth: totalDays * COL_WIDTH, position: "relative" }}>

          {/* Month header */}
          <div style={styles.ganttMonths}>
            {months.map((m, i) => (
              <div
                key={i}
                style={{
                  ...styles.ganttMonth,
                  left: m.startIdx * COL_WIDTH,
                  width: m.count * COL_WIDTH,
                }}
              >
                {m.label}
              </div>
            ))}
          </div>

          {/* Week-commencing banner */}
          <div style={styles.ganttWeeks}>
            {weeks.map((w, i) => (
              <div
                key={i}
                style={{
                  ...styles.ganttWeek,
                  left: w.startIdx * COL_WIDTH,
                  width: w.count * COL_WIDTH,
                }}
              >
                {w.label}
              </div>
            ))}
          </div>

          {/* Day header */}
          <div style={styles.ganttDays}>
            {days.map((d, i) => {
              const isWk = isWeekend(d);
              const isHol = holidays.has(dayKey(d));
              const isToday = dayKey(d) === today;
              const isWeekStart = d.getDay() === 1;
              return (
                <div
                  key={i}
                  style={{
                    ...styles.ganttDay,
                    width: COL_WIDTH,
                    background: isToday ? "#ecf0e2" : isHol ? "#f5e3dc" : isWk ? "#ede4cf" : "#faf6ec",
                    color: isToday ? "#5a6e50" : isHol ? "#a5614f" : isWk ? "#b8ad97" : "#7a6a55",
                    borderLeft: isWeekStart ? "2px solid #d9cfba" : "1px solid #e3dac4",
                  }}
                >
                  <div style={styles.ganttDayDow}>
                    {d.toLocaleString("en-GB", { weekday: "short" })}
                  </div>
                  <div style={styles.ganttDayNum}>{d.getDate()}</div>
                </div>
              );
            })}
          </div>

          {/* Fitter holiday strips — one per holiday, coloured by fitter */}
          {fitterHolidays && fitterHolidays.length > 0 && (
            <div style={{
              position: "relative",
              borderBottom: "1px solid #d9cfba",
              background: "#fdfaf2",
              padding: "4px 0",
            }}>
              {fitterHolidays.map((h, hi) => {
                const start = parseISO(h.start);
                const end = parseISO(h.end);
                // Clip to visible Gantt range
                if (end < ganttStart || start > addDays(ganttStart, days.length)) return null;
                const dispStart = start < ganttStart ? ganttStart : start;
                const dispEnd = addDays(end, 1); // inclusive end
                const left = diffDays(dispStart, ganttStart) * COL_WIDTH;
                const width = diffDays(dispEnd, dispStart) * COL_WIDTH - 1;
                const color = FITTER_CONFIG[h.fitter]?.color || "#888";
                return (
                  <div
                    key={h.id}
                    style={{
                      position: "relative",
                      height: 16,
                      marginBottom: hi < fitterHolidays.length - 1 ? 2 : 0,
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left,
                        width: Math.max(width, 8),
                        top: 0,
                        height: 16,
                        background: color,
                        opacity: 0.85,
                        borderRadius: 2,
                        display: "flex",
                        alignItems: "center",
                        paddingLeft: 6,
                        fontSize: 10,
                        color: "#faf6ec",
                        fontWeight: 500,
                        letterSpacing: "0.04em",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        boxShadow: "0 1px 2px rgba(58,52,44,0.15)",
                      }}
                      title={`${h.fitter} on holiday ${fmtUK(h.start)}–${fmtUK(h.end)}${h.note ? ` · ${h.note}` : ""}`}
                    >
                      {h.fitter} off{h.note ? ` · ${h.note}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Job rows */}
          <div style={{ position: "relative", marginTop: 4 }}>
            {orderedJobs.map((job, i) => (
              <GanttRow
                key={job.id}
                job={job}
                i={i}
                days={days}
                holidays={holidays}
                ganttStart={ganttStart}
                COL_WIDTH={COL_WIDTH}
                ROW_HEIGHT={ROW_HEIGHT}
                today={today}
                dragState={dragState && dragState.jobId === job.id ? dragState : null}
                resizeState={resizeState && resizeState.jobId === job.id ? resizeState : null}
                deliveryDragState={deliveryDragState && deliveryDragState.jobId === job.id ? deliveryDragState : null}
                setDragState={setDragState}
                setResizeState={setResizeState}
                setDeliveryDragState={setDeliveryDragState}
                onStageDrag={onStageDrag}
                onStageResize={onStageResize}
                onStageReset={onStageReset}
                onToggleLock={onToggleLock}
                onDeliveryDrag={onDeliveryDrag}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div style={styles.legend}>
        {Object.entries(STAGE_LABELS).filter(([k]) => k !== "install").map(([key, label]) => (
          <div key={key} style={styles.legendItem}>
            <span style={{ ...styles.legendSwatch, background: STAGE_COLORS[key] }} />
            <span>{label}</span>
          </div>
        ))}
        <div style={styles.legendDivider} />
        <div style={styles.legendItem}>
          <span style={{ ...styles.legendSwatch, background: FITTER_CONFIG.Steve.color }} />
          <span>Steve (install)</span>
        </div>
        <div style={styles.legendItem}>
          <span style={{ ...styles.legendSwatch, background: FITTER_CONFIG.Thompson.color }} />
          <span>Thompson (install)</span>
        </div>
        <div style={styles.legendItem}>
          <span style={{ ...styles.legendSwatch, background: FITTER_CONFIG.Chris.color }} />
          <span>Chris (install, support only)</span>
        </div>
      </div>
    </div>
  );
}

// One Gantt row. Wrapped in React.memo so a drag — which only ever changes
// dragState/resizeState/deliveryDragState for the ONE row being dragged —
// doesn't force every other row to recompute and re-diff its day-grid and
// task bars on every frame. The parent passes null for these three props on
// every row except the one actually being dragged, so memo's shallow prop
// comparison skips re-rendering the rest.
const GanttRow = React.memo(function GanttRow({
  job, i, days, holidays, ganttStart, COL_WIDTH, ROW_HEIGHT, today,
  dragState, resizeState, deliveryDragState,
  setDragState, setResizeState, setDeliveryDragState,
  onStageDrag, onStageResize, onStageReset, onToggleLock, onDeliveryDrag,
}) {
  return (
    <div
      style={{
        ...styles.ganttRow,
        height: ROW_HEIGHT,
        background: i % 2 ? "#fdfaf2" : "#f5f0e6",
      }}
    >
      {/* Day grid lines (weekend + week-start emphasis) */}
      {days.map((d, di) => {
        const isWk = isWeekend(d);
        const isHol = holidays.has(dayKey(d));
        const isToday = dayKey(d) === today;
        const isWeekStart = d.getDay() === 1;
        const isFriday = d.getDay() === 5 && !isHol;
        return (
          <React.Fragment key={di}>
            <div
              style={{
                position: "absolute",
                left: di * COL_WIDTH,
                width: COL_WIDTH,
                top: 0, bottom: 0,
                background: isToday ? "rgba(122,139,111,0.10)"
                          : isHol ? "rgba(165,97,79,0.10)"
                          : isWk ? "rgba(58,52,44,0.05)"
                          : "transparent",
                borderLeft: isWeekStart ? "1px solid #d9cfba" : "1px solid rgba(217,207,186,0.4)",
              }}
            />
            {/* Friday PM is non-working — hatched overlay on right half */}
            {isFriday && (
              <div
                style={{
                  position: "absolute",
                  left: di * COL_WIDTH + COL_WIDTH / 2,
                  width: COL_WIDTH / 2,
                  top: 0, bottom: 0,
                  backgroundImage: "repeating-linear-gradient(135deg, transparent 0 4px, rgba(58,52,44,0.10) 4px 5px)",
                  background: "rgba(58,52,44,0.05)",
                  backgroundBlendMode: "multiply",
                  pointerEvents: "none",
                }}
                title="Friday afternoon — workshop closed"
              />
            )}
          </React.Fragment>
        );
      })}
      {/* Task bars — split into segments so they don't cross weekends */}
      {(job.tasks || []).flatMap((t, ti) => {
        const isHalfDay = t.startSlot && t.days && (t.days % 1 !== 0);
        const isInstall = t.stage === "install";
        const isTeamInstall = isInstall && t.installer === "Team";
        const hasSecondary = isInstall && !isTeamInstall && t.secondaryInstaller && FITTER_CONFIG[t.secondaryInstaller];
        const isDraggingThis = dragState && dragState.jobId === job.id && dragState.stage === t.stage;
        const isResizingThis = resizeState && resizeState.jobId === job.id && resizeState.stage === t.stage;
        const tooltip = `${STAGE_LABELS[t.stage]}: ${dayKey(t.start)}${t.days ? ` · ${t.days}d` : ""}${t.installer ? ` · ${t.installer === "Team" ? "Steve + Thompson + Chris" : t.installer}${hasSecondary ? " + " + t.secondaryInstaller : ""}` : ""}${t.siblingOf ? ` · parallel w/ ${t.siblingOf}` : ""}${isInstall ? " · drag to move, drag right edge to resize" : ""}`;
        // Install bars coloured by fitter
        let barColor;
        let barBackground;
        if (isTeamInstall) {
          // Diagonal stripes of all three fitter colours
          const sc = FITTER_CONFIG.Steve.color;
          const tc = FITTER_CONFIG.Thompson.color;
          const cc = FITTER_CONFIG.Chris.color;
          barBackground = `repeating-linear-gradient(135deg, ${sc} 0 8px, ${tc} 8px 16px, ${cc} 16px 24px)`;
          barColor = sc; // fallback for drag ghost
        } else if (hasSecondary) {
          // Two-fitter install: split bar — primary on top 65%, secondary stripe on bottom 35%
          const primary = FITTER_CONFIG[t.installer].color;
          const secondary = FITTER_CONFIG[t.secondaryInstaller].color;
          barBackground = `linear-gradient(to bottom, ${primary} 0 65%, ${secondary} 65% 100%)`;
          barColor = primary;
        } else if (isInstall && t.installer && FITTER_CONFIG[t.installer]) {
          barColor = FITTER_CONFIG[t.installer].color;
          barBackground = barColor;
        } else {
          barColor = STAGE_COLORS[t.stage];
          barBackground = barColor;
        }
        const segs = ganttSegmentsFor(t, ganttStart, COL_WIDTH, holidays);

        // For install bars when being dragged, render a single ghost bar at the drag position
        if (isDraggingThis && dragState.currentLeft !== null) {
          const dragWidth = dragState.width;
          return [(
            <div
              key={`${ti}-drag`}
              style={{
                position: "absolute",
                left: dragState.currentLeft,
                width: dragWidth,
                top: getStageRowOffset(t.stage) - 1,
                height: 11,
                background: barColor,
                borderRadius: 3,
                boxShadow: "0 4px 12px rgba(58,52,44,0.35)",
                opacity: 0.92,
                outline: "2px solid #faf6ec",
                cursor: "grabbing",
                pointerEvents: "none",
              }}
              title={tooltip}
            />
          )];
        }

        // For install bars being resized, render a ghost bar with new width
        if (isResizingThis && resizeState.currentWidth !== null) {
          const resizeLeft = ganttBarLeftFor(t, ganttStart, COL_WIDTH);
          return [(
            <div
              key={`${ti}-resize`}
              style={{
                position: "absolute",
                left: resizeLeft,
                width: resizeState.currentWidth,
                top: getStageRowOffset(t.stage) - 1,
                height: 11,
                background: barColor,
                borderRadius: 3,
                boxShadow: "0 4px 12px rgba(58,52,44,0.35)",
                opacity: 0.92,
                outline: "2px solid #faf6ec",
                cursor: "ew-resize",
                pointerEvents: "none",
              }}
              title={`${resizeState.currentDays} days`}
            >
              <div style={{
                position: "absolute",
                right: -4,
                top: -22,
                background: "#3a342c",
                color: "#faf6ec",
                padding: "2px 7px",
                fontSize: 10,
                borderRadius: 3,
                fontFamily: "'Cormorant Garamond', 'Georgia', serif",
                letterSpacing: "0.04em",
              }}>
                {resizeState.currentDays} days
              </div>
            </div>
          )];
        }

        const out = [];
        const isLocked = isInstall && !!job.locked;
        const stageCfg = DRAGGABLE_STAGES[t.stage];
        // Any draggable stage is interactive, except a locked install bar
        // (it stays pinned) and everything in read-only mode.
        const isDraggable = !IS_READONLY && !!stageCfg && !isLocked;
        const isResizable = isDraggable;
        segs.forEach((seg, si) => {
          const isLastSeg = si === segs.length - 1;
          out.push(
            <div
              key={`${ti}-${si}`}
              style={{
                position: "absolute",
                left: seg.left,
                width: seg.width,
                top: getStageRowOffset(t.stage),
                height: isInstall ? 11 : 9,
                background: barBackground,
                borderRadius: 2,
                boxShadow: isInstall
                  ? "0 1px 2px rgba(58,52,44,0.18)"
                  : "0 1px 0 rgba(58,52,44,0.12)",
                cursor: isDraggable ? "grab" : "default",
                outline: (t.isOverridden && !isLocked)
                  ? "1px dashed rgba(58,52,44,0.4)"
                  : "none",
              }}
              title={tooltip}
              onContextMenu={(isDraggable && t.isOverridden) ? (e) => {
                e.preventDefault();
                if (window.confirm(`Reset ${STAGE_LABELS[t.stage]} to auto-calculated position and duration?`)) {
                  onStageReset && onStageReset(job.id, t.stage);
                }
              } : undefined}
              onMouseDown={isDraggable ? (e) => {
                e.preventDefault();
                const startX = e.clientX;
                const barLeft = ganttBarLeftFor(t, ganttStart, COL_WIDTH);
                const barW = ganttBarWidthFor(t, ganttStart, COL_WIDTH);
                // Bench/finishing/reassembly run on the fractional-day model and
                // can start partway through a day (e.g. after lunch), so they snap
                // to half-day positions; machining/install have no such concept and
                // keep the original whole-day-only snap.
                const supportsHalfDay = !!stageCfg.usedField;
                let lastDate = null;
                let lastUsed = 0;
                // Coalesce mousemove updates to one setState per animation frame
                // instead of one per raw event — mousemove can fire far faster than
                // the display refreshes, and without this every extra event just
                // queues up more re-renders than can actually be shown, which is
                // what made dragging feel laggy.
                let rafId = null;
                let pendingState = null;
                const flush = () => {
                  rafId = null;
                  if (pendingState) setDragState(pendingState);
                };
                const onMove = (ev) => {
                  const dx = ev.clientX - startX;
                  const newLeft = barLeft + dx;
                  if (supportsHalfDay) {
                    const snappedHalfIdx = Math.round(newLeft / (COL_WIDTH / 2));
                    const dayIdx = Math.floor(snappedHalfIdx / 2);
                    if (dayIdx < 0 || dayIdx >= days.length) return;
                    let snappedDate = days[dayIdx];
                    let usedFraction = (snappedHalfIdx - dayIdx * 2) * 0.5;
                    while (isWeekend(snappedDate) || holidays.has(dayKey(snappedDate))) {
                      snappedDate = addDays(snappedDate, 1);
                      usedFraction = 0;
                      if (diffDays(snappedDate, ganttStart) >= days.length) break;
                    }
                    usedFraction = Math.min(usedFraction, dayCapacity(snappedDate));
                    const snappedLeft = diffDays(snappedDate, ganttStart) * COL_WIDTH + usedFraction * COL_WIDTH;
                    lastDate = dayKey(snappedDate);
                    lastUsed = usedFraction;
                    pendingState = {
                      jobId: job.id,
                      currentLeft: snappedLeft,
                      currentDate: lastDate,
                      width: barW,
                      stage: t.stage,
                    };
                  } else {
                    const snappedDayIdx = Math.round(newLeft / COL_WIDTH);
                    if (snappedDayIdx < 0 || snappedDayIdx >= days.length) return;
                    let snappedDate = days[snappedDayIdx];
                    while (isWeekend(snappedDate) || holidays.has(dayKey(snappedDate))) {
                      snappedDate = addDays(snappedDate, 1);
                      if (diffDays(snappedDate, ganttStart) >= days.length) break;
                    }
                    const snappedLeft = diffDays(snappedDate, ganttStart) * COL_WIDTH;
                    lastDate = dayKey(snappedDate);
                    lastUsed = 0;
                    pendingState = {
                      jobId: job.id,
                      currentLeft: snappedLeft,
                      currentDate: lastDate,
                      width: barW,
                      stage: t.stage,
                    };
                  }
                  if (rafId === null) rafId = requestAnimationFrame(flush);
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                  if (rafId !== null) cancelAnimationFrame(rafId);
                  setDragState(null);
                  const startingUsed = t.startSlot?.used || 0;
                  const usedChanged = supportsHalfDay && Math.abs(lastUsed - startingUsed) > DAY_EPSILON;
                  if (lastDate && (lastDate !== dayKey(t.start) || usedChanged)) {
                    onStageDrag && onStageDrag(job.id, t.stage, lastDate, lastUsed);
                  }
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              } : undefined}
            />
          );

          // Padlock icon overlay on locked install bars
          if (isInstall && isLocked && isLastSeg) {
            out.push(
              <div
                key={`${ti}-${si}-lockicon`}
                style={{
                  position: "absolute",
                  left: seg.left + 4,
                  top: getStageRowOffset(t.stage) - 1,
                  fontSize: 9,
                  color: "#faf6ec",
                  pointerEvents: "none",
                  textShadow: "0 1px 1px rgba(58,52,44,0.5)",
                }}
              >🔒</div>
            );
          }

          // Team install icon overlay (only when not also locked, since lock takes the spot)
          if (isInstall && isTeamInstall && !isLocked && isLastSeg) {
            out.push(
              <div
                key={`${ti}-${si}-teamicon`}
                style={{
                  position: "absolute",
                  left: seg.left + 4,
                  top: getStageRowOffset(t.stage) - 1,
                  fontSize: 9,
                  color: "#faf6ec",
                  pointerEvents: "none",
                  textShadow: "0 1px 1px rgba(58,52,44,0.6)",
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                }}
              >TEAM</div>
            );
          }

          // Resize handle on the last segment only, for any draggable stage
          if (isResizable && isLastSeg) {
            out.push(
              <div
                key={`${ti}-${si}-handle`}
                style={{
                  position: "absolute",
                  left: seg.left + seg.width - 5,
                  width: 8,
                  top: getStageRowOffset(t.stage) - 2,
                  height: 15,
                  background: "rgba(58,52,44,0.55)",
                  borderRadius: 2,
                  cursor: "ew-resize",
                  zIndex: 3,
                }}
                title={`Drag to resize · current: ${t.days} day${t.days === 1 ? "" : "s"}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const startX = e.clientX;
                  const startWidth = ganttBarWidthFor(t, ganttStart, COL_WIDTH);
                  const startDays = t.days;
                  // Same fractional-day stages that can drag to a half-day start
                  // can also resize in half-day steps; machining/install stay
                  // whole-day-only, matching their existing behaviour exactly.
                  const supportsHalfDay = !!stageCfg.usedField;
                  const step = supportsHalfDay ? 0.5 : 1;
                  const minDays = supportsHalfDay ? 0.5 : 1;
                  let lastDays = startDays;
                  let lastWidth = startWidth;
                  let rafId = null;
                  let pendingState = null;
                  const flush = () => {
                    rafId = null;
                    if (pendingState) setResizeState(pendingState);
                  };
                  const onMove = (ev) => {
                    const dx = ev.clientX - startX;
                    // Snap the resulting duration to the nearest half-day grid
                    // outright, rather than adding half-day deltas to startDays —
                    // startDays itself may already be an arbitrary value (a typed
                    // override, or finishing's flatExtra-adjusted nominal), so
                    // snapping the end result is what actually guarantees a clean
                    // half-day number instead of an odd one plus 0.5 forever.
                    const rawDays = startDays + dx / COL_WIDTH;
                    const snapped = Math.round(rawDays / step) * step;
                    const newDays = Math.round(Math.max(minDays, Math.min(15, snapped)) * 10) / 10;
                    lastDays = newDays;
                    lastWidth = newDays * COL_WIDTH - 1;
                    pendingState = {
                      jobId: job.id,
                      currentDays: newDays,
                      currentWidth: lastWidth,
                      stage: t.stage,
                    };
                    if (rafId === null) rafId = requestAnimationFrame(flush);
                  };
                  const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                    if (rafId !== null) cancelAnimationFrame(rafId);
                    setResizeState(null);
                    if (lastDays !== startDays) {
                      onStageResize && onStageResize(job.id, t.stage, lastDays);
                    }
                  };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
              />
            );
          }

          // Lock/unlock button just past the right edge of the install bar
          if (isInstall && isLastSeg) {
            out.push(
              <button
                key={`${ti}-${si}-lockbtn`}
                style={{
                  position: "absolute",
                  left: seg.left + seg.width + 6,
                  top: getStageRowOffset(t.stage) - 3,
                  width: 22,
                  height: 17,
                  padding: 0,
                  border: "1px solid " + (isLocked ? "#7a8b6f" : "#d9cfba"),
                  background: isLocked ? "#7a8b6f" : "#faf6ec",
                  color: isLocked ? "#faf6ec" : "#7a6a55",
                  borderRadius: 3,
                  fontSize: 10,
                  cursor: "pointer",
                  zIndex: 4,
                  fontFamily: "inherit",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
                title={isLocked
                  ? "Locked — click to unlock"
                  : "Lock this install (date, duration, fitter)"}
                disabled={IS_READONLY}
                onClick={(e) => {
                  e.stopPropagation();
                  if (IS_READONLY) return;
                  onToggleLock && onToggleLock(job.id, job);
                }}
              >
                {isLocked ? "🔓" : "🔒"}
              </button>
            );
          }
        });

        // Truck delivery icon (only for install tasks).
        // Positioned at the deliveryDate; draggable anywhere along the Gantt.
        if (isInstall && t.deliveryDate) {
          const isDraggingThisDel = deliveryDragState && deliveryDragState.jobId === job.id;
          const delDayIdx = diffDays(t.deliveryDate, ganttStart);
          const liveDelLeft = isDraggingThisDel
            ? deliveryDragState.currentLeft
            : delDayIdx * COL_WIDTH;
          const delDate = isDraggingThisDel
            ? parseISO(deliveryDragState.currentDate)
            : t.deliveryDate;
          const delTooltip = `Delivery: ${delDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · drag to reschedule`;
          out.push(
            <div
              key={`${ti}-truck`}
              title={delTooltip}
              style={{
                position: "absolute",
                left: liveDelLeft + 4,
                top: getStageRowOffset(t.stage) - 9,
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: "#3a342c",
                color: "#faf6ec",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: IS_READONLY ? "default" : "grab",
                zIndex: 6,
                boxShadow: "0 1px 3px rgba(58,52,44,0.4)",
                border: "1.5px solid #faf6ec",
                opacity: isDraggingThisDel ? 0.85 : 1,
              }}
              onMouseDown={IS_READONLY ? undefined : (e) => {
                e.preventDefault();
                e.stopPropagation();
                const startX = e.clientX;
                const startLeft = delDayIdx * COL_WIDTH;
                let lastDate = null;
                let rafId = null;
                let pendingState = null;
                const flush = () => {
                  rafId = null;
                  if (pendingState) setDeliveryDragState(pendingState);
                };
                const onMove = (ev) => {
                  const dx = ev.clientX - startX;
                  const newLeft = startLeft + dx;
                  const snappedDayIdx = Math.round(newLeft / COL_WIDTH);
                  if (snappedDayIdx < 0 || snappedDayIdx >= days.length) return;
                  let snappedDate = days[snappedDayIdx];
                  // Snap weekend/holiday days to next working day
                  while (isWeekend(snappedDate) || holidays.has(dayKey(snappedDate))) {
                    snappedDate = addDays(snappedDate, 1);
                    if (diffDays(snappedDate, ganttStart) >= days.length) break;
                  }
                  const snappedLeft = diffDays(snappedDate, ganttStart) * COL_WIDTH;
                  lastDate = dayKey(snappedDate);
                  pendingState = {
                    jobId: job.id,
                    currentLeft: snappedLeft,
                    currentDate: lastDate,
                  };
                  if (rafId === null) rafId = requestAnimationFrame(flush);
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                  if (rafId !== null) cancelAnimationFrame(rafId);
                  setDeliveryDragState(null);
                  if (lastDate && lastDate !== dayKey(t.deliveryDate)) {
                    onDeliveryDrag && onDeliveryDrag(job.id, lastDate);
                  }
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            >
              <Truck size={12} strokeWidth={2.2} />
            </div>
          );
        }

        return out;
      })}
      {/* Job label overlay */}
      <div style={styles.ganttJobLabel}>
        {job.name || "—"}
      </div>
    </div>
  );
});

// Stack stages vertically within a row so they don't overlap visually.
// Each stage gets its own lane; later stages sit lower in the row.
function getStageRowOffset(stage) {
  const order = {
    buffer:          2,
    machining:       8,
    bench:           14,
    finishing:       20,
    reassembly:      26,
    install:         32,
    template:        38,
    worktop_install: 38,
    final_survey:    38,
  };
  return order[stage] || 8;
}

// ============================================================
// SETTINGS MODAL
// ============================================================

// ============================================================
// FEATURES EDITOR (complexity dropdown)
// ============================================================

function FeaturesEditor({ features, onUpdate }) {
  const [adding, setAdding] = useState(false);
  const [selectedKey, setSelectedKey] = useState("stained_internals");

  const addFeature = () => {
    const def = COMPLEXITY_FEATURES[selectedKey];
    const newFeature = {
      id: "f_" + Math.random().toString(36).slice(2, 8),
      key: selectedKey,
      count: def.type === "perCab" ? 1 : 0,
      customDays: def.type === "custom" ? 1 : 0,
      customLabel: "",
    };
    onUpdate([...features, newFeature]);
    setAdding(false);
  };

  const removeFeature = (id) => {
    onUpdate(features.filter(f => f.id !== id));
  };

  const updateFeature = (id, patch) => {
    onUpdate(features.map(f => f.id === id ? { ...f, ...patch } : f));
  };

  const impact = featureImpact(features);

  return (
    <div style={styles.fieldGroup}>
      <div style={styles.fieldGroupLabel}>
        Complexity & extras
        {features.length > 0 && (
          <span style={styles.impactSummary}>
            +{impact.perCabExtra.toFixed(1)}d bench/finish
            {impact.flatExtra > 0 ? ` · +${impact.flatExtra}d flat` : ""}
            {impact.holdExtra > 0 ? ` · +${impact.holdExtra}d hold` : ""}
            {impact.templateExtra > 0 ? ` · +${impact.templateExtra}d template` : ""}
          </span>
        )}
      </div>

      {features.map(f => {
        const def = COMPLEXITY_FEATURES[f.key];
        if (!def) return null;
        return (
          <div key={f.id} style={styles.featureRow}>
            <div style={styles.featureLabel}>
              {def.label}
            </div>
            {def.type === "perCab" && (
              <>
                <input
                  type="number" min="0"
                  style={styles.numInput}
                  value={f.count}
                  onChange={e => updateFeature(f.id, { count: parseInt(e.target.value) || 0 })}
                />
                <span style={styles.featureUnit}>cabs · +{def.days}d ea</span>
              </>
            )}
            {def.type === "flat" && (
              <span style={styles.featureUnit}>+{def.days} days</span>
            )}
            {def.type === "hold" && (
              <span style={styles.featureUnit}>+{def.days} hold days</span>
            )}
            {def.type === "templateExtra" && (
              <span style={styles.featureUnit}>+{def.days}d template gap</span>
            )}
            {def.type === "custom" && (
              <>
                <input
                  type="number" min="0" step="0.5"
                  style={styles.numInput}
                  value={f.customDays}
                  onChange={e => updateFeature(f.id, { customDays: parseFloat(e.target.value) || 0 })}
                />
                <span style={styles.featureUnit}>days</span>
              </>
            )}
            <button style={styles.iconBtn} onClick={() => removeFeature(f.id)}>
              <X size={11} />
            </button>
          </div>
        );
      })}

      {adding ? (
        <div style={styles.featureAddRow}>
          <select
            style={{ ...styles.input, flex: 1 }}
            value={selectedKey}
            onChange={e => setSelectedKey(e.target.value)}
          >
            {Object.entries(COMPLEXITY_FEATURES).map(([key, def]) => (
              <option key={key} value={key}>{def.label}</option>
            ))}
          </select>
          <button style={styles.btnPrimarySm} onClick={addFeature}>Add</button>
          <button style={styles.btnGhostSm} onClick={() => setAdding(false)}>×</button>
        </div>
      ) : (
        <button style={styles.btnGhostFull} onClick={() => setAdding(true)}>
          <Plus size={11} /> Add feature
        </button>
      )}
    </div>
  );
}

// ============================================================
// WHAT-IF MODAL (slot finder for potential jobs)
// ============================================================

function WhatIfModal({ existingJobs, holidays, settings, onClose, onConvertToJob }) {
  const [hypoJob, setHypoJob] = useState(() => ({
    ...newJob(),
    name: "Potential job",
  }));

  const result = useMemo(() => {
    if (totalCabinets(hypoJob) === 0) return null;
    return findBestSlot(hypoJob, existingJobs, holidays, settings);
  }, [hypoJob, existingJobs, holidays, settings]);

  const update = (patch) => setHypoJob({ ...hypoJob, ...patch });

  const fmtDate = (d) => d.toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric"
  });

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, width: 720, maxHeight: "90vh" }} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span>Quote a potential job</span>
          <button style={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={styles.modalBody}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

            {/* LEFT: input */}
            <div>
              <div style={styles.field}>
                <label style={styles.label}>Customer / job reference</label>
                <input
                  style={styles.input}
                  value={hypoJob.name}
                  onChange={e => update({ name: e.target.value })}
                  placeholder="e.g. Smith enquiry"
                />
              </div>

              <div style={styles.fieldGroup}>
                <div style={styles.fieldGroupLabel}>Cabinet mix</div>
                {Object.entries(CABINET_TYPES).map(([key, type]) => (
                  <div key={key} style={styles.cabRow}>
                    <span style={{ ...styles.cabSwatch, background: type.color }} />
                    <span style={styles.cabLabel}>{type.label}</span>
                    <span style={styles.cabRate}>{type.rate}/day</span>
                    <input
                      type="number" min="0"
                      style={styles.numInput}
                      value={hypoJob.cabinets[key]}
                      onChange={e => update({
                        cabinets: { ...hypoJob.cabinets, [key]: parseInt(e.target.value) || 0 }
                      })}
                    />
                  </div>
                ))}
                <div style={{ fontSize: 10, color: "#888", marginTop: 8, letterSpacing: "0.05em" }}>
                  Total: {totalCabinets(hypoJob)} cabinets
                  {totalCabinets(hypoJob) > 0 && ` · ${benchDaysForJob(hypoJob)} bench days`}
                </div>
              </div>

              <FeaturesEditor
                features={hypoJob.features || []}
                onUpdate={(features) => update({ features })}
              />

              <div style={styles.field}>
                <label style={styles.labelSm}>Customer's preferred install date (optional)</label>
                <input
                  type="date"
                  style={styles.input}
                  value={hypoJob.targetInstallWeek}
                  onChange={e => update({ targetInstallWeek: e.target.value })}
                />
              </div>
            </div>

            {/* RIGHT: results */}
            <div style={styles.whatIfResults}>
              <div style={styles.fieldGroupLabel}>Best available slots</div>

              {!result && (
                <div style={styles.empty}>
                  Enter cabinet numbers to see available slots.
                </div>
              )}

              {result && (
                <>
                  <div style={styles.slotCard}>
                    <div style={styles.slotCardHeader}>
                      <span style={styles.slotCardTag}>EARLIEST</span>
                      <span style={styles.slotCardFitter}>{result.bestFitter.installer}</span>
                    </div>
                    <div style={styles.slotCardDate}>
                      {fmtWeekCommencing(result.bestFitter.installStart)}
                    </div>
                    <div style={styles.slotCardSubdate}>
                      Install starts {fmtDate(result.bestFitter.installStart)}
                    </div>
                    {result.bestFitter.warnings.length > 0 && (
                      <div style={styles.slotWarnings}>
                        {result.bestFitter.warnings.map((w, i) => (
                          <div key={i}>⚠ {w.message}</div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Fitter comparison */}
                  <div style={{ marginTop: 14 }}>
                    <div style={styles.fieldGroupLabel}>Earliest by fitter</div>
                    {(() => {
                      // Exclude Chris from the primary comparison (support-only)
                      const primaryOptions = result.fitterOptions.filter(o => !o.isSupport);
                      const sorted = [...primaryOptions].sort((a, b) => a.installStart - b.installStart);
                      const allSame = sorted.every(o =>
                        dayKey(o.installStart) === dayKey(sorted[0].installStart)
                      );
                      return (
                        <>
                          {sorted.map(opt => (
                            <div key={opt.fitter} style={styles.fitterRow}>
                              <span style={{
                                ...styles.fitterSwatch,
                                background: FITTER_CONFIG[opt.fitter].color,
                              }} />
                              <span style={styles.fitterName}>{opt.fitter}</span>
                              <span style={styles.fitterDate}>{fmtWeekCommencing(opt.installStart)}</span>
                              {opt.finishingPushed && (
                                <span style={styles.fitterFlag} title="Causes finishing bunching">⚠</span>
                              )}
                            </div>
                          ))}
                          {allSame && (
                            <div style={{ fontSize: 9, color: "#888", marginTop: 6, fontStyle: "italic" }}>
                              Both fitters available — production timeline is the bottleneck.
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {/* Target hit/miss */}
                  {hypoJob.targetInstallWeek && (
                    <div style={{ marginTop: 14 }}>
                      <div style={styles.fieldGroupLabel}>Target check</div>
                      {result.targetOption ? (
                        <div style={styles.targetHit}>
                          ✓ Can hit target with {result.targetOption.installer}
                          <div style={styles.slotCardSubdate}>
                            {fmtWeekCommencing(result.targetOption.installStart)}
                          </div>
                        </div>
                      ) : (
                        <div style={styles.targetMiss}>
                          ✗ Target not achievable. Earliest is{" "}
                          {fmtWeekCommencing(result.bestFitter.installStart)}
                          <div style={styles.slotCardSubdate}>
                            {workingDaysBetween(
                              parseISO(hypoJob.targetInstallWeek),
                              result.bestFitter.installStart,
                              holidays
                            )} working days late
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Production timeline */}
                  <div style={{ marginTop: 14 }}>
                    <div style={styles.fieldGroupLabel}>Full production timeline</div>
                    {result.bestFitter.tasks.map((t, i) => (
                      <div key={i} style={styles.timelineRow}>
                        <span style={{ ...styles.timelineDot, background: STAGE_COLORS[t.stage] }} />
                        <span style={styles.timelineStage}>{STAGE_LABELS[t.stage]}</span>
                        <span style={styles.timelineDate}>
                          {fmtDate(t.start)}
                          {t.days > 1 && ` · ${t.days}d`}
                        </span>
                      </div>
                    ))}
                  </div>

                  <button
                    style={{ ...styles.btnPrimary, width: "100%", marginTop: 16, justifyContent: "center" }}
                    onClick={() => {
                      // Convert the hypothetical to a real job, with the best fitter pre-selected
                      const realJob = {
                        ...hypoJob,
                        installer: result.bestFitter.installer,
                      };
                      onConvertToJob(realJob);
                    }}
                  >
                    Add to schedule with {result.bestFitter.installer}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ settings, setSettings, onClose }) {
  const [holidayInput, setHolidayInput] = useState("");
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span>Settings</span>
          <button style={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </div>
        <div style={styles.modalBody}>
          <div style={styles.field}>
            <label style={styles.label}>Schedule start date</label>
            <input
              type="date"
              style={styles.input}
              value={settings.startDate}
              onChange={e => setSettings({ ...settings, startDate: e.target.value })}
            />
          </div>
          <div style={{ ...styles.field, padding: 8, background: "#0f0f0f", border: "1px solid #2a2a2a", fontSize: 10, color: "#888" }}>
            Install duration by cabinet count:<br/>
            ≤20 cabs = 4d · 21–27 = 5d · 28–33 = 6d · 34+ = 7d<br/>
            Siblings (same customer) use their combined cabinet count.
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Working days: re-assembly end → install start (dispatch)</label>
            <input
              type="number" min="0"
              style={styles.input}
              value={settings.dispatchGapDays ?? 1}
              onChange={e => setSettings({ ...settings, dispatchGapDays: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Working days: install start → worktop template</label>
            <input
              type="number" min="0"
              style={styles.input}
              value={settings.templateDaysAfterInstall ?? 7}
              onChange={e => setSettings({ ...settings, templateDaysAfterInstall: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Working days: template → worktop install</label>
            <input
              type="number" min="0"
              style={styles.input}
              value={settings.worktopInstallDaysAfterTemplate ?? 7}
              onChange={e => setSettings({ ...settings, worktopInstallDaysAfterTemplate: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div style={styles.row2}>
            <div style={styles.field}>
              <label style={styles.label}>Workshop buffer: ideal (days)</label>
              <input
                type="number" min="0"
                style={styles.input}
                value={settings.workshopBufferIdealDays ?? 3}
                onChange={e => setSettings({ ...settings, workshopBufferIdealDays: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Workshop buffer: minimum (days)</label>
              <input
                type="number" min="0"
                style={styles.input}
                value={settings.workshopBufferMinDays ?? 1}
                onChange={e => setSettings({ ...settings, workshopBufferMinDays: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div style={styles.field}>
            <label style={styles.label}>Workshop closures (extra to UK bank holidays)</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="date"
                style={{ ...styles.input, flex: 1 }}
                value={holidayInput}
                onChange={e => setHolidayInput(e.target.value)}
              />
              <button
                style={styles.btnPrimary}
                onClick={() => {
                  if (holidayInput && !settings.holidays.includes(holidayInput)) {
                    setSettings({ ...settings, holidays: [...settings.holidays, holidayInput].sort() });
                    setHolidayInput("");
                  }
                }}
              >Add</button>
            </div>
            <div style={styles.holidayList}>
              {(settings.holidays || []).map(h => (
                <div key={h} style={styles.holidayItem}>
                  <span>{fmtUK(h)}</span>
                  <button
                    style={styles.iconBtn}
                    onClick={() => setSettings({
                      ...settings,
                      holidays: settings.holidays.filter(x => x !== h)
                    })}
                  ><X size={10} /></button>
                </div>
              ))}
              {(!settings.holidays || settings.holidays.length === 0) && (
                <div style={{ color: "#9b8f7e", fontSize: 11, padding: 8, fontStyle: "italic" }}>
                  UK bank holidays are applied automatically. Add any extra workshop closures here.
                </div>
              )}
            </div>
          </div>

          {/* --- Fitter holidays --- */}
          <FitterHolidaySettings
            settings={settings}
            setSettings={setSettings}
          />
        </div>
      </div>
    </div>
  );
}

// Sub-component for managing per-fitter holiday ranges
function FitterHolidaySettings({ settings, setSettings }) {
  const [editFitter, setEditFitter] = useState("Steve");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editNote, setEditNote] = useState("");

  const add = () => {
    if (!editStart || !editEnd) return;
    if (editStart > editEnd) return;
    const newHol = {
      id: "fh_" + Math.random().toString(36).slice(2, 9),
      fitter: editFitter,
      start: editStart,
      end: editEnd,
      note: editNote || undefined,
    };
    setSettings({
      ...settings,
      fitterHolidays: [...(settings.fitterHolidays || []), newHol]
        .sort((a, b) => a.start.localeCompare(b.start)),
    });
    setEditStart("");
    setEditEnd("");
    setEditNote("");
  };

  const remove = (id) => {
    setSettings({
      ...settings,
      fitterHolidays: (settings.fitterHolidays || []).filter(h => h.id !== id),
    });
  };

  // Group by fitter for display
  const byFitter = { Steve: [], Thompson: [], Chris: [] };
  (settings.fitterHolidays || []).forEach(h => {
    if (byFitter[h.fitter]) byFitter[h.fitter].push(h);
  });

  return (
    <div style={styles.field}>
      <label style={styles.label}>Fitter holidays</label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 6, marginBottom: 8 }}>
        <select
          style={styles.input}
          value={editFitter}
          onChange={e => setEditFitter(e.target.value)}
        >
          <option value="Steve">Steve</option>
          <option value="Thompson">Thompson</option>
          <option value="Chris">Chris</option>
        </select>
        <input
          type="date"
          style={styles.input}
          value={editStart}
          onChange={e => setEditStart(e.target.value)}
          placeholder="Start"
        />
        <input
          type="date"
          style={styles.input}
          value={editEnd}
          onChange={e => setEditEnd(e.target.value)}
          placeholder="End"
        />
        <button style={styles.btnPrimary} onClick={add}>Add</button>
      </div>
      <input
        type="text"
        style={{ ...styles.input, marginBottom: 8 }}
        value={editNote}
        onChange={e => setEditNote(e.target.value)}
        placeholder="Note (optional)"
      />
      <div style={styles.holidayList}>
        {FITTERS.map(f => {
          const hols = byFitter[f] || [];
          if (hols.length === 0) return null;
          return (
            <div key={f}>
              <div style={{
                padding: "5px 10px",
                fontSize: 10,
                letterSpacing: "0.12em",
                color: FITTER_CONFIG[f].color,
                textTransform: "uppercase",
                fontWeight: 600,
                borderBottom: "1px solid #e8dfca",
                background: "#fdfaf2",
              }}>{f}</div>
              {hols.map(h => (
                <div key={h.id} style={styles.holidayItem}>
                  <span>
                    {fmtUK(h.start)} – {fmtUK(h.end)}
                    {h.note && <span style={{ color: "#9b8f7e", marginLeft: 6 }}>· {h.note}</span>}
                  </span>
                  <button
                    style={styles.iconBtn}
                    onClick={() => remove(h.id)}
                  ><X size={10} /></button>
                </div>
              ))}
            </div>
          );
        })}
        {(settings.fitterHolidays || []).length === 0 && (
          <div style={{ color: "#9b8f7e", fontSize: 11, padding: 8, fontStyle: "italic" }}>
            No fitter holidays set. Add date ranges above when fitters book time off.
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// STYLES
// ============================================================

const styles = {
  // ============================================================
  // EVIE WILLOW PALETTE
  // Light, warm, hand-crafted feel.
  //   Background: linen / cream
  //   Surfaces:   off-white panels with soft shadows
  //   Text:       warm charcoal (#3a342c)
  //   Accent:     sage (#7a8b6f)
  //   Warm:       terracotta (#a5614f)
  //   Muted:      taupe / warm grey for borders
  // Typography:   classic serif headings, warm sans body
  // ============================================================

  // --- Layout ---
  app: {
    fontFamily: "'Inter', -apple-system, 'Segoe UI', sans-serif",
    background: "#f5f0e6",
    color: "#3a342c",
    minHeight: "100vh",
    fontSize: 13,
  },
  loading: {
    padding: 60,
    textAlign: "center",
    color: "#9b8f7e",
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
    fontSize: 18,
    fontStyle: "italic",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 32px",
    borderBottom: "1px solid #d9cfba",
    background: "#faf6ec",
  },
  brand: {
    fontSize: 22,
    fontWeight: 400,
    letterSpacing: "0.18em",
    color: "#3a342c",
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
  },
  subbrand: {
    fontSize: 11,
    color: "#9b8f7e",
    marginTop: 4,
    letterSpacing: "0.08em",
    fontStyle: "italic",
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
  },
  headerActions: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  updatePromptBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 24px",
    background: "#fdfaf2",
    borderBottom: "1px solid #d9cfba",
  },
  updatePromptLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "#7a6a55",
    letterSpacing: "0.04em",
    flexShrink: 0,
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
    fontStyle: "italic",
    fontSize: 13,
  },
  updatePromptInput: {
    flex: 1,
    background: "#fffefb",
    border: "1px solid #d9cfba",
    color: "#3a342c",
    padding: "7px 11px",
    fontSize: 12,
    fontFamily: "inherit",
    borderRadius: 3,
  },

  // --- Buttons ---
  btnPrimary: {
    background: "#7a8b6f",
    color: "#faf6ec",
    border: "none",
    padding: "9px 16px",
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: "0.08em",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "inherit",
    textTransform: "uppercase",
    borderRadius: 3,
    transition: "background 0.15s",
  },
  btnSecondary: {
    background: "transparent",
    color: "#7a8b6f",
    border: "1px solid #7a8b6f",
    padding: "9px 16px",
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: "0.08em",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: "inherit",
    textTransform: "uppercase",
    borderRadius: 3,
  },
  btnGhost: {
    background: "transparent",
    color: "#9b8f7e",
    border: "1px solid #d9cfba",
    padding: "9px 11px",
    fontSize: 12,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "inherit",
    borderRadius: 3,
  },
  btnDanger: {
    background: "transparent",
    color: "#a5614f",
    border: "1px solid #a5614f",
    padding: "6px 11px",
    fontSize: 11,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontFamily: "inherit",
    marginTop: 8,
    borderRadius: 3,
  },
  btnWarning: {
    background: "#f4ecd9",
    color: "#a07a3a",
    border: "1px solid #d4ae6a",
    padding: "9px 13px",
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: "0.06em",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "inherit",
    borderRadius: 3,
  },
  btnReminder: {
    background: "#f5e7d4",
    color: "#a5614f",
    border: "1px solid #c89072",
    padding: "9px 13px",
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: "0.06em",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "inherit",
    borderRadius: 3,
  },
  btnPrimarySm: {
    background: "#7a8b6f",
    color: "#faf6ec",
    border: "none",
    padding: "5px 11px",
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    borderRadius: 3,
  },
  btnGhostSm: {
    background: "transparent",
    color: "#7a6a55",
    border: "1px solid #d9cfba",
    padding: "5px 10px",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
    borderRadius: 3,
  },
  btnGhostFull: {
    background: "transparent",
    color: "#9b8f7e",
    border: "1px dashed #c8bca3",
    padding: "8px",
    fontSize: 11,
    cursor: "pointer",
    width: "100%",
    fontFamily: "inherit",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderRadius: 3,
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "#9b8f7e",
    cursor: "pointer",
    padding: 4,
    display: "inline-flex",
    alignItems: "center",
  },

  // --- Main layout ---
  main: {
    display: "grid",
    gridTemplateColumns: "340px 1fr",
    height: "calc(100vh - 130px)",
  },

  // --- Job list ---
  jobList: {
    borderRight: "1px solid #d9cfba",
    overflowY: "auto",
    background: "#faf6ec",
  },
  jobListHeader: {
    padding: "14px 18px",
    fontSize: 10,
    letterSpacing: "0.22em",
    color: "#9b8f7e",
    borderBottom: "1px solid #e3dac4",
    position: "sticky",
    top: 0,
    background: "#faf6ec",
    zIndex: 1,
    fontWeight: 500,
    textTransform: "uppercase",
  },
  empty: {
    padding: 28,
    color: "#9b8f7e",
    textAlign: "center",
    fontStyle: "italic",
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
    fontSize: 14,
  },
  jobRow: {
    borderBottom: "1px solid #e8dfca",
  },
  jobRowActive: {
    background: "#f0e9d8",
    boxShadow: "inset 3px 0 0 #7a8b6f",
  },
  jobRowSummary: {
    padding: "14px 18px",
    cursor: "pointer",
  },
  jobName: {
    fontSize: 14,
    fontWeight: 500,
    color: "#3a342c",
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
  },
  jobMeta: {
    fontSize: 11,
    color: "#9b8f7e",
    marginTop: 4,
    letterSpacing: "0.04em",
  },
  jobInstallWeek: {
    fontSize: 11,
    color: "#7a8b6f",
    marginTop: 4,
    letterSpacing: "0.04em",
    fontWeight: 500,
  },
  jobEditor: {
    padding: "10px 18px 18px",
    borderTop: "1px solid #e8dfca",
    background: "#fdfaf2",
  },

  // --- Form fields ---
  field: {
    marginBottom: 12,
  },
  fieldGroup: {
    marginBottom: 16,
    paddingBottom: 12,
    borderBottom: "1px dashed #d9cfba",
  },
  fieldGroupLabel: {
    fontSize: 9,
    letterSpacing: "0.22em",
    color: "#9b8f7e",
    marginBottom: 8,
    fontWeight: 500,
    textTransform: "uppercase",
  },
  label: {
    display: "block",
    fontSize: 10,
    color: "#7a6a55",
    marginBottom: 5,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    fontWeight: 500,
  },
  labelSm: {
    display: "block",
    fontSize: 9,
    color: "#9b8f7e",
    marginBottom: 4,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    fontWeight: 500,
  },
  input: {
    width: "100%",
    background: "#fffefb",
    border: "1px solid #d9cfba",
    color: "#3a342c",
    padding: "8px 10px",
    fontSize: 13,
    fontFamily: "inherit",
    boxSizing: "border-box",
    borderRadius: 3,
  },
  numInput: {
    width: 56,
    background: "#fffefb",
    border: "1px solid #d9cfba",
    color: "#3a342c",
    padding: "5px 8px",
    fontSize: 12,
    fontFamily: "inherit",
    textAlign: "right",
    borderRadius: 3,
  },
  row2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },

  // --- Cabinet rows ---
  cabRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 6,
  },
  cabSwatch: {
    width: 10,
    height: 10,
    borderRadius: 2,
    flexShrink: 0,
  },
  cabLabel: {
    flex: 1,
    fontSize: 12,
  },
  cabRate: {
    fontSize: 9,
    color: "#9b8f7e",
    letterSpacing: "0.05em",
  },

  // --- Gantt ---
  gantt: {
    overflow: "hidden",
    background: "#f5f0e6",
    display: "flex",
    flexDirection: "column",
  },
  ganttScroll: {
    overflowX: "auto",
    overflowY: "auto",
    flex: 1,
  },
  ganttMonths: {
    height: 26,
    position: "sticky",
    top: 0,
    zIndex: 5,
    borderBottom: "1px solid #d9cfba",
    background: "#faf6ec",
  },
  ganttMonth: {
    position: "absolute",
    top: 0,
    bottom: 0,
    fontSize: 11,
    letterSpacing: "0.22em",
    color: "#7a6a55",
    textTransform: "uppercase",
    display: "flex",
    alignItems: "center",
    paddingLeft: 12,
    borderRight: "1px solid #e3dac4",
    fontWeight: 500,
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
  },
  ganttWeeks: {
    height: 24,
    position: "sticky",
    top: 26,
    zIndex: 5,
    borderBottom: "1px solid #d9cfba",
    background: "#f5ecd8",
  },
  ganttWeek: {
    position: "absolute",
    top: 0,
    bottom: 0,
    fontSize: 10,
    color: "#7a6a55",
    letterSpacing: "0.06em",
    display: "flex",
    alignItems: "center",
    paddingLeft: 10,
    borderRight: "1px solid #d9cfba",
    fontWeight: 500,
  },
  ganttDays: {
    height: 44,
    display: "flex",
    position: "sticky",
    top: 50,
    zIndex: 5,
    borderBottom: "1px solid #d9cfba",
    background: "#faf6ec",
    boxShadow: "0 2px 4px rgba(58,52,44,0.08)",
  },
  ganttDay: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    color: "#7a6a55",
    boxSizing: "border-box",
  },
  ganttDayNum: {
    fontWeight: 500,
    fontSize: 14,
    lineHeight: 1.1,
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
  },
  ganttDayDow: {
    fontSize: 9,
    opacity: 0.7,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 1,
  },
  ganttRow: {
    position: "relative",
    borderBottom: "1px solid #e8dfca",
  },
  ganttJobLabel: {
    position: "sticky",
    left: 6,
    top: 4,
    fontSize: 11,
    color: "#3a342c",
    letterSpacing: "0.04em",
    pointerEvents: "none",
    width: "fit-content",
    background: "rgba(245,240,230,0.92)",
    padding: "2px 7px",
    borderRadius: 3,
    zIndex: 2,
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
    fontWeight: 500,
  },

  // --- Legend ---
  legend: {
    padding: "12px 18px",
    borderTop: "1px solid #d9cfba",
    background: "#faf6ec",
    display: "flex",
    gap: 18,
    flexWrap: "wrap",
    fontSize: 11,
    color: "#7a6a55",
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  legendSwatch: {
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  legendDivider: {
    width: 1,
    height: 14,
    background: "#d9cfba",
    margin: "0 6px",
  },

  // --- Modals ---
  modalOverlay: {
    position: "fixed",
    top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(58,52,44,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  modal: {
    background: "#faf6ec",
    border: "1px solid #d9cfba",
    width: 400,
    maxHeight: "80vh",
    display: "flex",
    flexDirection: "column",
    borderRadius: 6,
    boxShadow: "0 12px 40px rgba(58,52,44,0.18)",
  },
  modalHeader: {
    padding: "16px 20px",
    borderBottom: "1px solid #d9cfba",
    fontSize: 14,
    letterSpacing: "0.06em",
    color: "#3a342c",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
    fontWeight: 500,
  },
  modalBody: {
    padding: 18,
    overflowY: "auto",
  },
  holidayList: {
    marginTop: 8,
    border: "1px solid #d9cfba",
    maxHeight: 150,
    overflowY: "auto",
    borderRadius: 3,
    background: "#fffefb",
  },
  holidayItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "5px 10px",
    fontSize: 11,
    borderBottom: "1px solid #e8dfca",
  },

  // --- Warning modal ---
  warningJobGroup: {
    marginBottom: 14,
    padding: "10px 0",
    borderBottom: "1px solid #e8dfca",
  },
  warningJobHeader: {
    fontSize: 12,
    color: "#3a342c",
    fontWeight: 500,
    letterSpacing: "0.06em",
    marginBottom: 8,
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
  },
  warningItemRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 6,
    lineHeight: 1.5,
  },
  warningTypeTag: {
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: "0.12em",
    color: "#faf6ec",
    padding: "2px 7px",
    borderRadius: 2,
    minWidth: 50,
    textAlign: "center",
    flexShrink: 0,
    marginTop: 1,
  },

  // --- Reminder modal ---
  reminderRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "12px 0",
    borderBottom: "1px solid #e8dfca",
  },
  reminderJobName: {
    fontSize: 14,
    fontWeight: 500,
    color: "#3a342c",
    marginBottom: 4,
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
  },
  reminderDates: {
    fontSize: 11,
    color: "#7a6a55",
    lineHeight: 1.5,
  },

  // --- Features editor ---
  impactSummary: {
    fontSize: 9,
    color: "#7a8b6f",
    marginLeft: 8,
    letterSpacing: "0.04em",
    textTransform: "none",
    fontWeight: 400,
  },
  featureRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 8px",
    background: "#fffefb",
    border: "1px solid #d9cfba",
    marginBottom: 4,
    fontSize: 11,
    borderRadius: 3,
  },
  featureLabel: {
    flex: 1,
    color: "#3a342c",
  },
  featureUnit: {
    fontSize: 9,
    color: "#9b8f7e",
    letterSpacing: "0.04em",
  },
  featureAddRow: {
    display: "flex",
    gap: 4,
    marginTop: 4,
  },

  // --- What-if results ---
  whatIfResults: {
    background: "#fdfaf2",
    border: "1px solid #d9cfba",
    padding: 16,
    borderRadius: 4,
  },
  slotCard: {
    background: "#faf6ec",
    border: "2px solid #7a8b6f",
    padding: 14,
    borderRadius: 4,
  },
  slotCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  slotCardTag: {
    fontSize: 9,
    background: "#7a8b6f",
    color: "#faf6ec",
    padding: "2px 8px",
    fontWeight: 600,
    letterSpacing: "0.12em",
    borderRadius: 2,
  },
  slotCardFitter: {
    fontSize: 11,
    color: "#7a6a55",
    letterSpacing: "0.05em",
  },
  slotCardDate: {
    fontSize: 18,
    color: "#3a342c",
    fontWeight: 500,
    marginTop: 6,
    fontFamily: "'Cormorant Garamond', 'Georgia', serif",
  },
  slotCardSubdate: {
    fontSize: 11,
    color: "#7a6a55",
    marginTop: 3,
  },
  slotWarnings: {
    marginTop: 10,
    fontSize: 10,
    color: "#a5614f",
  },
  fitterRow: {
    display: "flex",
    alignItems: "center",
    padding: "6px 0",
    borderBottom: "1px solid #e8dfca",
    fontSize: 12,
  },
  fitterName: {
    flex: 1,
    color: "#3a342c",
  },
  fitterSwatch: {
    width: 10,
    height: 10,
    borderRadius: 2,
    marginRight: 6,
    flexShrink: 0,
  },
  fitterDate: {
    color: "#7a6a55",
    fontSize: 11,
  },
  fitterFlag: {
    marginLeft: 6,
    color: "#a5614f",
    fontSize: 10,
  },
  targetHit: {
    background: "#ecf0e2",
    border: "1px solid #7a8b6f",
    padding: 10,
    fontSize: 12,
    color: "#5a6e50",
    borderRadius: 3,
  },
  targetMiss: {
    background: "#f5e3dc",
    border: "1px solid #a5614f",
    padding: 10,
    fontSize: 12,
    color: "#a5614f",
    borderRadius: 3,
  },
  timelineRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "5px 0",
    fontSize: 12,
    borderBottom: "1px solid #e8dfca",
  },
  timelineDot: {
    width: 9,
    height: 9,
    borderRadius: "50%",
    flexShrink: 0,
  },
  timelineStage: {
    flex: 1,
    color: "#7a6a55",
    fontSize: 10,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  timelineDate: {
    color: "#3a342c",
    fontSize: 11,
  },
};

// ============================================================
// WORKSHOP FLOOR BOARD (?board=1)
// ============================================================
// Reads today's plan from the day layout the scheduler already produces.
// The floor taps a counter as cabinets clear each stage; those actuals write
// straight to storage (debounced, shared) for the office to see, but never
// touch a schedule date directly — see Part E (variance review) in the App
// component for the reviewed, person-in-the-loop path back into production
// dates. Install weeks are never touched by this board, full stop.

// Build the morning brief the board reads: today's slice of the day layout,
// renamed to the shape the board expects (`planned`, not `cabinets`), plus
// the full job list for the "add another job" (off-plan) picker.
function buildMorningBrief(scheduled, dayLayout, todayKey) {
  const today = dayLayout[todayKey] || {};
  const mapEntries = (arr) => (arr || []).map(e => ({
    jobId: e.jobId, jobName: e.jobName, batch: e.batch, planned: e.cabinets, colour: e.colour, mix: e.mix,
  }));
  const stages = {
    cnc: mapEntries(today.cnc),
    prep: mapEntries(today.prep),
    bench: mapEntries(today.bench),
    spray: mapEntries(today.spray),
    pad: mapEntries(today.pad),
    reasm: mapEntries(today.reasm),
  };
  const allJobs = scheduled
    .filter(j => j.name && totalCabinets(j) > 0)
    .map(j => ({ jobId: j.id, jobName: j.name, batch: 1, planned: 0, colour: j.colour || { name: "", hex: "" }, mix: j.cabinets }));
  return { stages, allJobs };
}

const FLOOR_BOARD_CSS = `
  .floor-board-root{--linen:#f5f0e6; --panel:#faf6ec; --panel2:#fdfaf2;
    --ink:#3a342c; --ink2:#7a6a55; --ink3:#9b8f7e;
    --rule:#d9cfba; --rule2:#e8dfca;
    --sage:#7a8b6f; --sage-bg:#ecf0e2;
    --clay:#a5614f; --clay-bg:#f5e3dc;
    --honey:#c9a961; --honey-bg:#f4ecd9;
    --slate:#6e8794; --lav:#9c8aaa;
    background:var(--linen);color:var(--ink);
    font-family:Inter,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;
    min-height:100vh;}
  .floor-board-root .serif{font-family:'Cormorant Garamond',Georgia,serif}
  .floor-board-root .wrap{max-width:1880px;margin:0 auto;padding:20px 28px 32px}
  .floor-board-root .top{display:flex;justify-content:space-between;align-items:flex-end;
    border-bottom:1px solid var(--rule);padding-bottom:14px}
  .floor-board-root .brand{font-size:30px;letter-spacing:.2em;font-weight:400}
  .floor-board-root .sub{font-size:14px;color:var(--ink3);letter-spacing:.09em;font-style:italic;margin-top:4px}
  .floor-board-root .today-date{font-size:26px;font-weight:500;text-align:right}
  .floor-board-root .today-sub{font-size:13px;color:var(--ink2);letter-spacing:.08em;text-transform:uppercase;text-align:right;margin-top:3px}
  .floor-board-root .pipe{display:flex;align-items:flex-end;gap:10px;margin:22px 0 20px}
  .floor-board-root .pipe-seg{background:var(--panel);border:1px solid var(--rule);border-radius:4px;
    padding:11px 13px 13px;flex:1;min-width:0}
  .floor-board-root .pipe-name{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink2);font-weight:500}
  .floor-board-root .pipe-cap{font-size:34px;font-weight:500;line-height:1.05;margin-top:5px}
  .floor-board-root .pipe-cap span{font-size:14px;color:var(--ink2);letter-spacing:.05em;font-weight:400}
  .floor-board-root .pipe-style{font-size:11px;color:var(--ink3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .floor-board-root .weekstrip{display:flex;gap:14px;margin-bottom:24px}
  .floor-board-root .wk{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:14px 17px}
  .floor-board-root .wk-num{font-size:38px;font-weight:500;line-height:1}
  .floor-board-root .wk-lbl{font-size:13px;color:var(--ink2);margin-top:4px}
  .floor-board-root .wk-note{font-size:12px;color:var(--ink3);margin-top:3px}
  .floor-board-root .wk.behind{border-color:var(--clay);background:var(--clay-bg)}
  .floor-board-root .wk.behind .wk-num{color:var(--clay)}
  .floor-board-root h2.sec{font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--ink3);
    font-weight:600;margin:0 0 12px;font-family:Inter,sans-serif}
  .floor-board-root .stages{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
  .floor-board-root .card{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:15px 16px 17px}
  .floor-board-root .card.done{background:var(--sage-bg);border-color:var(--sage)}
  .floor-board-root .card.behind{background:var(--clay-bg);border-color:var(--clay)}
  .floor-board-root .card-head{display:flex;justify-content:space-between;align-items:baseline}
  .floor-board-root .card-name{font-size:16px;font-weight:500;letter-spacing:.02em}
  .floor-board-root .card-tgt{font-size:12px;color:var(--ink2);letter-spacing:.06em}
  .floor-board-root .chips{display:flex;flex-wrap:wrap;gap:7px;margin:8px 0 4px;min-height:26px}
  .floor-board-root .chip{background:var(--panel2);border:1px solid var(--rule2);border-radius:4px;
    padding:4px 8px;font-size:12px;color:var(--ink2);display:flex;align-items:center;gap:6px;
    font-family:Inter,sans-serif;cursor:pointer;font-weight:400}
  .floor-board-root .chip[aria-pressed="true"]{border:2px solid var(--ink);background:#fff;color:var(--ink);padding:3px 7px;font-weight:500}
  .floor-board-root .chip.offplan{border-style:dashed;border-color:var(--honey)}
  .floor-board-root .chip-add{border-style:dashed;color:var(--ink3)}
  .floor-board-root .chip-n{font-weight:500;color:var(--ink)}
  .floor-board-root .swatch{display:inline-block;width:11px;height:11px;border-radius:2px;
    border:1px solid rgba(58,52,44,.25);flex:none}
  .floor-board-root .count-row{display:flex;align-items:flex-end;gap:12px;margin-top:8px}
  .floor-board-root .count{font-size:56px;font-weight:500;line-height:.9;min-width:64px}
  .floor-board-root .of{font-size:17px;color:var(--ink2);padding-bottom:6px}
  .floor-board-root .behind-pill{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;
    border-radius:3px;background:var(--clay-bg);color:var(--clay);font-weight:600;margin-bottom:8px}
  .floor-board-root .done-pill{font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;
    border-radius:3px;background:var(--sage-bg);color:#5a6e50;font-weight:600;margin-bottom:8px}
  .floor-board-root .bar{height:9px;background:var(--rule2);border-radius:5px;margin-top:13px;position:relative}
  .floor-board-root .bar-fill{height:9px;background:var(--sage);border-radius:5px;transition:width .25s}
  .floor-board-root .bar-fill.late{background:var(--clay)}
  .floor-board-root .bar-fill.over{background:var(--honey)}
  .floor-board-root .pace{position:absolute;top:-3px;width:2px;height:15px;background:var(--ink2);border-radius:1px}
  .floor-board-root .btns{display:flex;gap:8px;margin-top:13px}
  .floor-board-root button{font-family:Inter,sans-serif;cursor:pointer;border-radius:4px;font-weight:500}
  .floor-board-root .plus{flex:1;background:var(--sage);color:var(--panel);border:none;
    font-size:26px;padding:14px 0;letter-spacing:.02em;min-height:56px}
  .floor-board-root .plus:active{background:#68785e}
  .floor-board-root .minus{width:64px;background:transparent;color:var(--ink2);border:1px solid var(--rule);font-size:22px;min-height:56px}
  .floor-board-root .plus:focus-visible,.floor-board-root .minus:focus-visible,.floor-board-root .chip:focus-visible{outline:3px solid var(--slate);outline-offset:2px}
  .floor-board-root .yrow{display:flex;justify-content:space-between;align-items:center;
    padding:11px 2px;border-bottom:1px solid var(--rule2);font-size:15px}
  .floor-board-root .ynum{display:flex;align-items:baseline;gap:9px}
  .floor-board-root .yactual{font-size:22px;font-weight:500;min-width:34px;text-align:right}
  .floor-board-root .ytgt{font-size:13px;color:var(--ink3)}
  .floor-board-root .pill{font-size:11px;letter-spacing:.12em;padding:3px 9px;border-radius:3px;font-weight:600;min-width:52px;text-align:center}
  .floor-board-root .hit{background:var(--sage-bg);color:#5a6e50}
  .floor-board-root .miss{background:var(--clay-bg);color:var(--clay)}
  .floor-board-root .notice{margin-top:22px;padding:10px 14px;border:1px dashed var(--rule);border-radius:4px;
    font-size:12px;color:var(--ink3);line-height:1.6}
  .floor-board-root .yesterday-wrap{margin-top:30px;max-width:900px}
  .floor-board-root .notes-wrap{margin-top:30px;max-width:900px}
  .floor-board-root .note-row{display:flex;gap:8px;margin-bottom:10px}
  .floor-board-root .note-row input{flex:1;border:1px solid var(--rule);border-radius:4px;padding:9px 12px;
    font-size:13px;background:#fff;color:var(--ink);font-family:Inter,sans-serif}
  .floor-board-root .note-row button{background:var(--sage);color:var(--panel);border:none;border-radius:4px;
    padding:9px 16px;font-size:13px;cursor:pointer;font-family:Inter,sans-serif}
  .floor-board-root .note-item{background:var(--panel2);border:1px dashed var(--clay);border-radius:4px;
    padding:9px 12px;font-size:13px;color:var(--ink2);line-height:1.5;margin-bottom:6px}
  .floor-board-root .note-empty{font-size:12px;color:var(--ink3);font-style:italic}
  .floor-board-root .tabbar{display:flex;gap:8px;margin:18px 0 4px}
  .floor-board-root .tabbtn{flex:none;padding:9px 20px;border:1px solid var(--rule);border-radius:4px;
    background:var(--panel);color:var(--ink2);font-size:14px;letter-spacing:.04em;font-family:Inter,sans-serif}
  .floor-board-root .tabbtn[aria-selected="true"]{background:var(--sage);color:var(--panel);border-color:var(--sage)}
  .floor-board-root .batches-wrap{margin-top:14px;max-width:900px}
  .floor-board-root .batch-row{display:flex;gap:8px;margin-bottom:14px}
  .floor-board-root .batch-row input[type="text"]{flex:1;border:1px solid var(--rule);border-radius:4px;padding:9px 12px;
    font-size:13px;background:#fff;color:var(--ink);font-family:Inter,sans-serif}
  .floor-board-root .batch-row input[type="number"]{width:84px;border:1px solid var(--rule);border-radius:4px;padding:9px 10px;
    font-size:13px;background:#fff;color:var(--ink);font-family:Inter,sans-serif}
  .floor-board-root .batch-row button{background:var(--sage);color:var(--panel);border:none;border-radius:4px;
    padding:9px 16px;font-size:13px;cursor:pointer;font-family:Inter,sans-serif}
  .floor-board-root .batch-item{display:flex;justify-content:space-between;align-items:center;background:var(--panel2);
    border:1px solid var(--rule2);border-radius:4px;padding:10px 12px;margin-bottom:8px}
  .floor-board-root .batch-item.done{background:var(--sage-bg);border-color:var(--sage)}
  .floor-board-root .batch-label{font-size:14px;color:var(--ink)}
  .floor-board-root .batch-count{font-size:12px;color:var(--ink3);margin-top:2px}
  .floor-board-root .batch-toggle{display:flex;gap:6px}
  .floor-board-root .batch-toggle button{padding:6px 14px;font-size:12px;border-radius:4px;border:1px solid var(--rule);
    background:#fff;color:var(--ink2);font-family:Inter,sans-serif;cursor:pointer}
  .floor-board-root .batch-toggle button.yes[aria-pressed="true"]{background:var(--sage-bg);color:#5a6e50;border-color:var(--sage);font-weight:600}
  .floor-board-root .batch-toggle button.no[aria-pressed="true"]{background:var(--clay-bg);color:var(--clay);border-color:var(--clay);font-weight:600}
  .floor-board-root .batch-empty{font-size:12px;color:var(--ink3);font-style:italic}
  @media (max-width:1100px){.floor-board-root .pipe{flex-wrap:wrap}.floor-board-root .pipe-seg{flex:1 1 30%}}
  @media (prefers-reduced-motion:reduce){.floor-board-root *{transition:none!important}}
`;

const FLOOR_STAGES = [
  { key: "cnc",   name: "CNC",         colour: "#8a9670" },
  { key: "prep",  name: "Bench prep",  colour: "#7d8a99" },
  { key: "bench", name: "Bench",       colour: "#6e8794" },
  { key: "spray", name: "Spray",       colour: "#c9a961" },
  { key: "pad",   name: "Padding",     colour: "#b9a888" },
  { key: "reasm", name: "Re-assembly", colour: "#9c8aaa" },
];

// Mounts the ported board logic against real DOM nodes inside `root`,
// exactly like embedding a non-React widget — React renders the empty
// skeleton once and never touches its insides again, so the board can own
// its own imperative rendering (matching floor_board.html verbatim) without
// fighting React's virtual DOM.
function mountFloorBoard(root, planRef, holidaysSet) {
  const iso = fmtISO;
  const store = (typeof window !== "undefined" && window.storage) ? window.storage : null;
  const memory = {};

  async function load(key) {
    if (!store) return memory[key] ?? null;
    try { const r = await store.get(key); return r?.value ? JSON.parse(r.value) : null; } catch (e) { return null; }
  }
  async function saveNow(key, val) {
    if (!store) { memory[key] = val; return; }
    try { await store.set(key, JSON.stringify(val)); } catch (e) { memory[key] = val; }
  }
  const pending = {};
  let flushTimer = null;
  function queueSave(key, val) {
    pending[key] = val;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 600);
  }
  async function flush() {
    const keys = Object.keys(pending);
    for (const k of keys) { const v = pending[k]; delete pending[k]; await saveNow(k, v); }
  }

  const dayKeyFor = (d) => "floor:" + iso(d);
  const weekKeyFor = (d) => "floor:wtd:" + iso(mondayOf(d));
  const drawersKey = "floor:drawers";
  function mondayOf(d) {
    const m = new Date(d.getTime());
    const dow = m.getDay();
    m.setDate(m.getDate() + (dow === 0 ? -6 : 1 - dow));
    return m;
  }
  function prevWorkingDay(d) {
    let p = new Date(d.getTime());
    do { p = addDays(p, -1); } while (isWeekend(p) || holidaysSet.has(iso(p)));
    return p;
  }

  function dayLengthHours(d) { return d.getDay() === 5 ? FRIDAY_DAY_HOURS : FULL_DAY_HOURS; }
  function fractionOfDayElapsed(now) {
    const start = 7, breaks = [[10, 0.25], [13, 0.5], [15, 0.25]];
    const h = now.getHours() + now.getMinutes() / 60;
    if (h <= start) return 0;
    let worked = Math.min(h, now.getDay() === 5 ? 11 : 16.5) - start;
    breaks.forEach(([at, len]) => { if (h > at) worked -= Math.min(len, h - at); });
    return Math.max(0, Math.min(1, worked / dayLengthHours(now)));
  }

  let today = {}, yesterday = {}, weekToDate = {}, offPlan = [], notes = [], extraJobs = {}, selected = {};
  let drawerBatches = [], activeTab = "today";

  function jobsAt(stageKey) {
    return (planRef.current.stages[stageKey] || []).concat(extraJobs[stageKey] || []);
  }
  function countAt(stageKey, jobId) {
    return (today[stageKey] && today[stageKey][jobId]) || 0;
  }
  function totalAt(stageKey) {
    const m = today[stageKey] || {};
    return Object.keys(m).reduce((a, k) => a + m[k], 0);
  }
  function isOffPlan(stageKey, jobId) {
    return offPlan.some(o => o.stage === stageKey && o.jobId === jobId);
  }
  function targetFor(jobs) {
    if (!jobs || !jobs.length) return 0;
    return jobs.reduce((a, j) => a + (j.planned || 0), 0);
  }
  function paddableCount(job) {
    return PADDED_STYLES.reduce((n, s) => n + ((job.mix && job.mix[s]) || 0), 0);
  }
  function styleSummary(jobs) {
    if (!jobs || !jobs.length) return "nothing booked";
    return jobs.map(j => Math.round(j.planned) + " " + j.jobName.split(" ")[0] + " b" + j.batch).join(", ");
  }

  const $ = (id) => root.querySelector("#" + id);

  function renderDate() {
    const d = new Date();
    $("dateline").textContent = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    $("weekline").textContent = "week commencing " + mondayOf(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function renderPipe() {
    $("pipe").innerHTML = FLOOR_STAGES.map(s => {
      const jobs = jobsAt(s.key), t = targetFor(jobs);
      return `
      <div class="pipe-seg">
        <div class="pipe-name">${s.name}</div>
        <div class="pipe-cap">${Math.round(t)} <span>a day</span></div>
        <div class="pipe-style">${styleSummary(jobs)}</div>
      </div>`;
    }).join("");
  }

  function renderWeek() {
    const reasmTarget = targetFor(jobsAt("reasm"));
    const WEEK_DAYS = 4 + (FRIDAY_DAY_HOURS / FULL_DAY_HOURS);
    const expectedWeek = Math.round(reasmTarget * WEEK_DAYS);
    const d = new Date();
    const dowIdx = d.getDay() === 0 ? 5 : Math.min(5, d.getDay());
    const daysSoFar = (dowIdx >= 5 ? 4 + (FRIDAY_DAY_HOURS / FULL_DAY_HOURS) * fractionOfDayElapsed(d)
                                   : (dowIdx - 1) + fractionOfDayElapsed(d));
    const paceNow = Math.round(reasmTarget * daysSoFar);
    const actual = (weekToDate.reasm || 0) + totalAt("reasm");
    const behind = actual < paceNow;
    $("weekstrip").innerHTML = `
      <div class="wk" style="flex:1">
        <div class="wk-num">${expectedWeek}</div>
        <div class="wk-lbl">cabinets expected through re-assembly this week</div>
        <div class="wk-note">4 full days plus Friday morning, at the styles booked in</div>
      </div>
      <div class="wk ${behind ? "behind" : ""}" style="width:230px">
        <div class="wk-num">${actual} <span style="font-size:15px;color:var(--ink3);font-weight:400">of ${paceNow}</span></div>
        <div class="wk-lbl">week to date</div>
        <div class="wk-note">${behind ? (paceNow - actual) + " behind pace" : "running to pace"}</div>
      </div>`;
  }

  function renderStages() {
    const now = new Date(), f = fractionOfDayElapsed(now);
    const drawersWaiting = drawerBatches.filter(b => !b.done).reduce((a, b) => a + b.count, 0);
    $("stages").innerHTML = FLOOR_STAGES.map(s => {
      const jobs = jobsAt(s.key);
      const t = targetFor(jobs);
      const done = totalAt(s.key);
      const due = t * f;
      const hit = t > 0 && done >= t;
      const late = !hit && done < due - 1;
      const pct = t > 0 ? Math.min(100, Math.round(done / t * 100)) : 0;
      if (!selected[s.key] && jobs.length) selected[s.key] = jobs[0].jobId;
      const chips = jobs.map(j => {
        const n = countAt(s.key, j.jobId);
        const sel = selected[s.key] === j.jobId;
        const cap = s.key === "pad" ? paddableCount(j) : null;
        return `<button class="chip ${isOffPlan(s.key, j.jobId) ? "offplan" : ""}"
          data-stage="${s.key}" data-job="${j.jobId}" aria-pressed="${sel}"
          aria-label="Select ${j.jobName} at ${s.name}">
          <span class="swatch" style="background:${(j.colour && j.colour.hex) || "#c9a961"}"></span>
          ${j.batch} · ${j.jobName}${cap !== null ? ` <span style="color:var(--ink3)">(${Math.round(cap)} painted)</span>` : ""}
          ${n ? `<span class="chip-n">${n}</span>` : ""}
        </button>`;
      }).join("");
      return `
      <div class="card ${hit ? "done" : ""} ${late ? "behind" : ""}">
        <div class="card-head">
          <div class="card-name">${s.name}</div>
          <div class="card-tgt">target ${Math.round(t)}</div>
        </div>
        <div class="chips">
          ${chips}
          <button class="chip chip-add" data-add="${s.key}" aria-label="Add another job to ${s.name}">+ another job</button>
        </div>
        ${late ? `<div class="behind-pill">${Math.round(due - done)} behind</div>` : ""}
        ${s.key === "prep" && drawersWaiting > 0 ? `<div class="behind-pill">${drawersWaiting} drawer box${drawersWaiting === 1 ? "" : "es"} waiting</div>` : ""}
        ${hit ? `<div class="done-pill">target met</div>` : ""}
        <div class="count-row">
          <div class="count">${done}</div>
          <div class="of">of ${Math.round(t)}</div>
        </div>
        <div class="bar">
          <div class="bar-fill ${late ? "late" : ""} ${done > t ? "over" : ""}" style="width:${pct}%"></div>
          <div class="pace" style="left:${(f * 100).toFixed(1)}%" title="where you should be by now"></div>
        </div>
        <div class="btns">
          <button class="plus" data-k="${s.key}" data-d="1" aria-label="Add one cabinet at ${s.name}">+1</button>
          <button class="minus" data-k="${s.key}" data-d="-1" aria-label="Remove one cabinet at ${s.name}">−</button>
        </div>
      </div>`;
    }).join("");
  }

  function renderYesterday() {
    $("yesterday").innerHTML = FLOOR_STAGES.map(s => {
      const m = yesterday[s.key];
      if (!m) return `<div class="yrow"><div>${s.name}</div><div class="ynum"><span class="ytgt">not recorded</span></div></div>`;
      const a = Object.keys(m).reduce((x, k) => x + m[k], 0);
      const t = targetFor(jobsAt(s.key));
      const hit = a >= t;
      return `
      <div class="yrow">
        <div>${s.name}</div>
        <div class="ynum">
          <span class="yactual">${a}</span>
          <span class="ytgt">/ ${Math.round(t)}</span>
          <span class="pill ${hit ? "hit" : "miss"}">${hit ? "HIT" : Math.round(t - a) + " SHORT"}</span>
        </div>
      </div>`;
    }).join("");
  }

  function renderNotice() {
    $("notice").textContent = store
      ? "Counts save to the shared schedule, so the office sees them straight away. Install dates are never changed by this board."
      : "Not connected to the schedule, so counts will clear when this page reloads.";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderNotes() {
    $("notes-list").innerHTML = notes.length
      ? notes.map(n => `<div class="note-item">${escapeHtml(n)}</div>`).join("")
      : `<div class="note-empty">Nothing logged today.</div>`;
  }

  function addNote() {
    const input = $("note-input");
    const text = (input.value || "").trim();
    if (!text) return;
    notes = [...notes, text];
    input.value = "";
    renderNotes();
    queueSave(dayKeyFor(new Date()), { ...today, offPlan, notes });
  }

  function renderDrawers() {
    const sorted = [...drawerBatches].sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));
    $("drawer-list").innerHTML = sorted.length
      ? sorted.map(b => `
        <div class="batch-item ${b.done ? "done" : ""}">
          <div>
            <div class="batch-label">${escapeHtml(b.label)}</div>
            <div class="batch-count">${b.count} drawer box${b.count === 1 ? "" : "es"}</div>
          </div>
          <div class="batch-toggle">
            <button class="no" data-batch="${b.id}" data-done="0" aria-pressed="${!b.done}">No</button>
            <button class="yes" data-batch="${b.id}" data-done="1" aria-pressed="${b.done}">Yes</button>
          </div>
        </div>`).join("")
      : `<div class="batch-empty">No batches logged yet.</div>`;
  }

  function addDrawerBatch() {
    const labelInput = $("batch-label"), countInput = $("batch-count");
    const label = (labelInput.value || "").trim();
    const count = parseInt(countInput.value, 10);
    if (!label || !count || count <= 0) return;
    drawerBatches = [...drawerBatches, { id: Date.now() + "-" + Math.random().toString(36).slice(2), label, count, done: false }];
    labelInput.value = ""; countInput.value = "";
    renderDrawers();
    renderStages();
    queueSave(drawersKey, drawerBatches);
  }

  function setDrawerBatchDone(id, done) {
    drawerBatches = drawerBatches.map(b => (b.id === id ? { ...b, done } : b));
    renderDrawers();
    renderStages();
    queueSave(drawersKey, drawerBatches);
  }

  function setTab(tab) {
    activeTab = tab;
    $("panel-today").style.display = tab === "today" ? "" : "none";
    $("panel-drawers").style.display = tab === "drawers" ? "" : "none";
    $("tab-today").setAttribute("aria-selected", tab === "today" ? "true" : "false");
    $("tab-drawers").setAttribute("aria-selected", tab === "drawers" ? "true" : "false");
  }

  function renderAll() { renderPipe(); renderWeek(); renderStages(); renderYesterday(); renderNotes(); renderDrawers(); }

  function bump(stageKey, delta) {
    const jobId = selected[stageKey];
    if (!jobId) return;
    today[stageKey] = today[stageKey] || {};
    today[stageKey][jobId] = Math.max(0, (today[stageKey][jobId] || 0) + delta);
    renderAll();
    queueSave(dayKeyFor(new Date()), { ...today, offPlan, notes });
    const wtd = { ...weekToDate };
    wtd[stageKey] = (wtd[stageKey] || 0) + delta;
    weekToDate = wtd;
    queueSave(weekKeyFor(new Date()), wtd);
  }

  function addJobToStage(stageKey) {
    const taken = jobsAt(stageKey).map(j => j.jobId);
    const options = (planRef.current.allJobs || []).filter(j => taken.indexOf(j.jobId) === -1);
    if (!options.length) return;
    const pick = window.prompt(
      "Add a job to " + stageKey + ":\n\n" +
      options.map((j, i) => (i + 1) + ". " + j.jobName).join("\n") +
      "\n\nType a number:"
    );
    const idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || !options[idx]) return;
    extraJobs[stageKey] = (extraJobs[stageKey] || []).concat(options[idx]);
    offPlan.push({ stage: stageKey, jobId: options[idx].jobId });
    selected[stageKey] = options[idx].jobId;
    renderAll();
    queueSave(dayKeyFor(new Date()), { ...today, offPlan, notes });
  }

  const onClick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tab) { setTab(b.dataset.tab); return; }
    if (b.dataset.job) { selected[b.dataset.stage] = b.dataset.job; renderAll(); return; }
    if (b.dataset.add) { addJobToStage(b.dataset.add); return; }
    if (b.dataset.addnote) { addNote(); return; }
    if (b.dataset.addbatch) { addDrawerBatch(); return; }
    if (b.dataset.batch) { setDrawerBatchDone(b.dataset.batch, b.dataset.done === "1"); return; }
    if (b.dataset.k) { bump(b.dataset.k, parseInt(b.dataset.d, 10)); }
  };
  root.addEventListener("click", onClick);
  const onKeydown = (e) => {
    if (e.key === "Enter" && e.target && e.target.id === "note-input") addNote();
    if (e.key === "Enter" && e.target && (e.target.id === "batch-label" || e.target.id === "batch-count")) addDrawerBatch();
  };
  root.addEventListener("keydown", onKeydown);

  let currentDay = iso(new Date());
  let unsubscribe = null;
  let interval = null;

  async function rollOverIfNewDay() {
    const nowDay = iso(new Date());
    if (nowDay === currentDay) return;
    await flush();
    currentDay = nowDay;
    const prev = await load(dayKeyFor(prevWorkingDay(new Date())));
    if (prev) { delete prev.offPlan; delete prev.notes; yesterday = prev; } else { yesterday = {}; }
    today = {}; offPlan = []; notes = []; extraJobs = {}; selected = {};
    weekToDate = (await load(weekKeyFor(new Date()))) || {};
    renderDate(); renderAll();
  }

  (async function init() {
    renderDate(); renderNotice();
    const t = await load(dayKeyFor(new Date()));
    if (t) { offPlan = t.offPlan || []; notes = t.notes || []; delete t.offPlan; delete t.notes; today = t; }
    const y = await load(dayKeyFor(prevWorkingDay(new Date())));
    if (y) { delete y.offPlan; delete y.notes; yesterday = y; }
    weekToDate = (await load(weekKeyFor(new Date()))) || {};
    drawerBatches = (await load(drawersKey)) || [];
    renderAll();

    if (store && store.subscribe) {
      unsubscribe = store.subscribe(async () => {
        const t2 = await load(dayKeyFor(new Date()));
        if (t2) { offPlan = t2.offPlan || []; notes = t2.notes || []; delete t2.offPlan; delete t2.notes; today = t2; }
        drawerBatches = (await load(drawersKey)) || [];
        renderAll();
      });
    }

    interval = setInterval(async () => {
      await rollOverIfNewDay();
      renderDate(); renderWeek(); renderStages();
    }, 60000);
  })();

  return {
    onPlanChanged() { renderAll(); },
    teardown() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeydown);
      if (unsubscribe) unsubscribe();
      if (interval) clearInterval(interval);
      clearTimeout(flushTimer);
    },
  };
}

function FloorBoard({ scheduled, dayLayout }) {
  const rootRef = useRef(null);
  const apiRef = useRef(null);
  const planRef = useRef({ stages: {}, allJobs: [] });
  const todayKey = dayKey(new Date());
  const plan = useMemo(
    () => buildMorningBrief(scheduled, dayLayout, todayKey),
    [scheduled, dayLayout, todayKey]
  );
  planRef.current = plan;

  useEffect(() => {
    if (!rootRef.current) return;
    const holidaysSet = new Set(UK_BANK_HOLIDAYS);
    apiRef.current = mountFloorBoard(rootRef.current, planRef, holidaysSet);
    return () => {
      apiRef.current?.teardown?.();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiRef.current?.onPlanChanged?.();
  }, [plan]);

  return (
    <div className="floor-board-root" ref={rootRef}>
      <style>{FLOOR_BOARD_CSS}</style>
      <div className="wrap">
        <div className="top">
          <div>
            <div className="brand serif">EVIE WILLOW</div>
            <div className="sub serif">Workshop floor board</div>
          </div>
          <div>
            <div className="today-date serif" id="dateline">—</div>
            <div className="today-sub" id="weekline">—</div>
          </div>
        </div>
        <div className="tabbar" role="tablist">
          <button id="tab-today" className="tabbtn" data-tab="today" role="tab" aria-selected="true">Today</button>
          <button id="tab-drawers" className="tabbtn" data-tab="drawers" role="tab" aria-selected="false">Drawers</button>
        </div>
        <div id="panel-today">
          <div className="pipe" id="pipe" />
          <div className="weekstrip" id="weekstrip" />
          <h2 className="sec">Today · tap as each cabinet clears a stage</h2>
          <div className="stages" id="stages" />
          <div className="notice" id="notice" />
          <div className="notes-wrap">
            <h2 className="sec">Notes</h2>
            <div className="note-row">
              <input id="note-input" type="text" placeholder="Add a note about today..." maxLength={200} />
              <button data-addnote="1">Add</button>
            </div>
            <div id="notes-list" />
          </div>
          <div className="yesterday-wrap">
            <h2 className="sec">Yesterday</h2>
            <div id="yesterday" />
          </div>
        </div>
        <div id="panel-drawers" style={{ display: "none" }}>
          <h2 className="sec">Drawer batches · mark complete once boxed off</h2>
          <div className="batches-wrap">
            <div className="batch-row">
              <input id="batch-label" type="text" placeholder="Job or batch description..." maxLength={80} />
              <input id="batch-count" type="number" min="1" placeholder="Boxes" />
              <button data-addbatch="1">Add batch</button>
            </div>
            <div id="drawer-list" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
