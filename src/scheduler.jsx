import React, { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Trash2, AlertTriangle, Calendar, Settings, Download, Upload, X, Truck } from "lucide-react";
import "./storage.js"; // installs window.storage backed by Supabase

// Read-only mode: append ?readonly=1 to the URL to disable all edits.
const IS_READONLY = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("readonly") === "1";

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

// HALF-DAY MODEL
// Bench/finishing/reassembly use half-day precision. We represent a fractional
// position as { date: Date, halfStart: 0|1 } where 0 = AM (morning), 1 = PM (afternoon).
// Each working day has 2 half-days. A 1.5-day job starting AM Monday occupies
// Monday AM, Monday PM, Tuesday AM — and the next job can start Tuesday PM.

// Round a fractional day count to the nearest half-day (minimum 0.5)
function roundToHalf(days) {
  return Math.max(0.5, Math.round(days * 2) / 2);
}

// Advance a fractional cursor by N half-day slots, skipping weekends/holidays.
// Fridays only have an AM slot (PM is not worked). Returns { date, halfStart }
// representing the SLOT that starts after N halves.
function advanceHalfSlots(start, halvesToAdvance, holidays) {
  let date = nextWorkingDay(start.date, holidays);
  let half = start.halfStart;
  // If the start date itself was non-working, reset half to AM
  if (dayKey(date) !== dayKey(start.date)) half = 0;
  // If Friday and starting at PM, that's invalid — bump to next working day AM
  if (date.getDay() === 5 && half === 1) {
    date = addDays(date, 1);
    date = nextWorkingDay(date, holidays);
    half = 0;
  }
  for (let i = 0; i < halvesToAdvance; i++) {
    if (half === 0) {
      // From AM to PM — unless it's Friday (no PM slot), jump to next working day AM
      if (date.getDay() === 5) {
        date = addDays(date, 1);
        date = nextWorkingDay(date, holidays);
        half = 0;
      } else {
        half = 1;
      }
    } else {
      half = 0;
      date = addDays(date, 1);
      date = nextWorkingDay(date, holidays);
    }
  }
  return { date, halfStart: half };
}

// Compute the fractional end position from a start, given a duration in days (0.5 increments)
function endFromStart(start, days, holidays) {
  return advanceHalfSlots(start, Math.round(days * 2), holidays);
}

// Compare two half-slot positions: returns negative if a < b, positive if a > b, 0 if equal
function compareHalfSlot(a, b) {
  const dk = a.date.getTime() - b.date.getTime();
  if (dk !== 0) return dk;
  return a.halfStart - b.halfStart;
}

// Convert a half-slot position to a Date for legacy code that needs it
// (start of the AM if halfStart=0, midday if halfStart=1)
function slotToDate(slot) {
  return new Date(slot.date.getTime());
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
    installer: "auto",       // "auto" | "Steve" | "Thompson" | "Chris"
    machiningDays: 3,        // default machining duration
    notes: "",
    locked: false,           // if true, scheduler won't move it
    manualStart: "",         // optional manual start date (ISO)
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
// Each cabinet type takes (count / rate) days. Mixed jobs add up.
// Result is rounded to nearest half-day (minimum 0.5).
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

  // Track bench/finishing free positions as half-slot cursors
  // (so jobs can flow back-to-back at half-day precision)
  const startSlot = { date: parseISO(settings.startDate), halfStart: 0 };
  const state = {
    benchFreeSlot: startSlot,
    finishingFreeSlot: startSlot,
    installerSchedules: {},
    installBookings: [],   // [{customer, jobName, start, end, installer, cabCount, weekKey}]
    vanBookings: [],       // [{date, jobName, isSibling}] — 1 van can do 1 delivery per day
  };
  FITTERS.forEach(f => state.installerSchedules[f] = []);

  const scheduled = [];
  const warnings = [];

  for (const job of sorted) {
    const impact = featureImpact(job.features);
    if (totalCabinets(job) === 0 && impact.holdExtra === 0) {
      scheduled.push({ ...job, tasks: [], warning: "No cabinets entered" });
      continue;
    }

    const result = scheduleSingleJob(job, state, holidays, settings, impact);
    state.benchFreeSlot = result.newBenchFreeSlot;
    state.finishingFreeSlot = result.newFinishingFreeSlot;
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

  return { scheduled, warnings };
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
  // d is now the reassembly-end date. Reassembly takes benchDays (in half-days).
  // Step back benchDays working days (approximating half-days as partial days, but
  // for scheduling the machining start day we can treat it in whole-day increments).
  const reassemblyEndDate = d;
  let reassemblyStart = d;
  let halvesBack = Math.round(benchDays * 2);
  while (halvesBack > 0) {
    reassemblyStart = addDays(reassemblyStart, -1);
    if (!isWeekend(reassemblyStart) && !holidays.has(dayKey(reassemblyStart))) {
      // Each working day contributes 2 halves (Fri only 1)
      halvesBack -= (reassemblyStart.getDay() === 5 ? 1 : 2);
    }
  }
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
  return machiningStart;
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

  // Bench - flows tight, one job after the next. Bench is the constrained
  // resource; we want it 100% utilised. Each job's bench picks up exactly where
  // the previous job's bench finished (state.benchFreeSlot is a half-slot cursor,
  // so back-to-back jobs share days at AM/PM precision).
  //
  // Workshop buffer (gap between reassembly end and install) absorbs any slack —
  // if a job's production finishes early relative to its install date, the buffer
  // just gets bigger. We don't push bench later to "tighten the buffer".
  let benchStartSlot = { ...state.benchFreeSlot };
  // Make sure start slot is on a working day
  if (dayKey(benchStartSlot.date) !== dayKey(nextWorkingDay(benchStartSlot.date, holidays))) {
    benchStartSlot = { date: nextWorkingDay(benchStartSlot.date, holidays), halfStart: 0 };
  }
  // Make sure start slot is on a working day
  if (dayKey(benchStartSlot.date) !== dayKey(nextWorkingDay(benchStartSlot.date, holidays))) {
    benchStartSlot = { date: nextWorkingDay(benchStartSlot.date, holidays), halfStart: 0 };
  }
  // Fridays only have AM slot — if bench would start Friday PM, roll to next Mon AM
  if (benchStartSlot.date.getDay() === 5 && benchStartSlot.halfStart === 1) {
    const nextDay = nextWorkingDay(addDays(benchStartSlot.date, 1), holidays);
    benchStartSlot = { date: nextDay, halfStart: 0 };
  }
  const benchHalves = Math.round(benchDays * 2);
  const benchEndSlot = advanceHalfSlots(benchStartSlot, benchHalves, holidays);
  tasks.push({
    stage: "bench",
    start: benchStartSlot.date,
    end: addDays(benchEndSlot.date, benchEndSlot.halfStart === 0 ? 0 : 1),
    startSlot: benchStartSlot,
    endSlot: benchEndSlot,
    days: benchDays,
  });
  const newBenchFreeSlot = benchEndSlot;

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
  // AFTER bench has started, flag it (production order broken)
  if (job.machiningOverride && machiningEnd > benchStartSlot.date) {
    warnings.push({
      jobId: job.id,
      jobName: job.name,
      type: "buffer_too_tight",
      message: `Machining ends ${fmtUK(addDays(machiningEnd, -1))} but bench starts ${fmtUK(benchStartSlot.date)} — production order broken`,
    });
  }

  tasks.push({
    stage: "machining",
    start: machiningSeq[0],
    end: machiningEnd,
    days: machDays,
    isOverridden: !!(job.machiningOverride || (job.machiningDaysOverride && job.machiningDaysOverride > 0)),
  });

  // Finishing - starts 1 working day after bench begins, half-slot precision.
  // The "1 day after bench starts" rule means: finishing AM-slot starts the working day
  // after the day bench began. So if bench starts Mon AM, finishing starts Tue AM.
  let finishStartSlot = {
    date: nextWorkingDay(addDays(benchStartSlot.date, 1), holidays),
    halfStart: 0,
  };
  let finishingPushed = false;
  if (compareHalfSlot(finishStartSlot, state.finishingFreeSlot) < 0) {
    finishingPushed = true;
    const pushedTo = state.finishingFreeSlot;
    // Only warn if the push actually moves to a different day
    if (dayKey(finishStartSlot.date) !== dayKey(pushedTo.date)) {
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "bunching",
        message: `Finishing capacity overlap: pushed back from ${fmtUK(finishStartSlot.date)} to ${fmtUK(pushedTo.date)}`,
      });
    }
    finishStartSlot = pushedTo;
  }
  const finishHalves = Math.round(finishDays * 2);
  const finishEndSlot = advanceHalfSlots(finishStartSlot, finishHalves, holidays);
  tasks.push({
    stage: "finishing",
    start: finishStartSlot.date,
    end: addDays(finishEndSlot.date, finishEndSlot.halfStart === 0 ? 0 : 1),
    startSlot: finishStartSlot,
    endSlot: finishEndSlot,
    days: finishDays,
  });
  const newFinishingFreeSlot = finishEndSlot;

  // Re-assembly - starts 1 day after finishing starts, runs same length as bench.
  // Has its own capacity (parallel resource, doesn't gate on others).
  let reassemblyStartSlot = {
    date: nextWorkingDay(addDays(finishStartSlot.date, 1), holidays),
    halfStart: 0,
  };
  const reassemblyEndSlot = advanceHalfSlots(reassemblyStartSlot, benchHalves, holidays);
  // The "fully fitted" date is when re-assembly ends — used as anchor for install
  const reassemblyEndDate = reassemblyEndSlot.halfStart === 0
    ? reassemblyEndSlot.date            // ended at end of previous day, so this is the next day
    : addDays(reassemblyEndSlot.date, 1); // ended PM, so next day is when it's complete
  tasks.push({
    stage: "reassembly",
    start: reassemblyStartSlot.date,
    end: addDays(reassemblyEndSlot.date, reassemblyEndSlot.halfStart === 0 ? 0 : 1),
    startSlot: reassemblyStartSlot,
    endSlot: reassemblyEndSlot,
    days: benchDays,
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
    // Drag-overridden install: lands EXACTLY where the user put it. Production
    // does not push it back, even if production finishes after install starts.
    // We warn loudly so the user knows there's a physical impossibility, but
    // they may have a workaround in mind (extending production, moving things
    // around manually). It's their decision to make.
    earliestInstallStart = pinnedInstallDate;
    if (pinnedInstallDate < earliestFeasible) {
      const gap = diffDays(earliestFeasible, pinnedInstallDate);
      warnings.push({
        jobId: job.id,
        jobName: job.name,
        type: "target_unreachable",
        message: `Install ${fmtUK(pinnedInstallDate)} is ${gap} working day${gap === 1 ? "" : "s"} BEFORE production finishes (${fmtUK(reassemblyEndDate)}) — physically impossible unless you move production earlier`,
      });
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

  // Normal collision check - find next free slot for this fitter,
  // and check if this fitter is on holiday during the proposed install.
  // If so, auto-reassign to an available alternative fitter.
  //
  // SKIP both checks if the user has manually set the install date via drag
  // (installOverride). The user picked this date and fitter deliberately —
  // any clashes were already warned about above. Don't move anything.
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
  // Normal (non-team) collision check - find next free slot for this fitter,
  // and check if this fitter is on holiday during the proposed install.
  // If so, auto-reassign to an available alternative fitter.
  //
  // SKIP both checks if the user has manually set the install date via drag
  // (installOverride). The user picked this date and fitter deliberately —
  // any clashes were already warned about above. Don't move anything.
  const sched = state.installerSchedules[installer] || [];
  if (!skipAutoMove) {
    let collision = true;
    while (collision) {
      collision = false;
      const proposedSeq = workingDaysSeq(proposedStart, Math.ceil(installDays), holidays);
      const propEnd = addDays(proposedSeq[proposedSeq.length - 1], 1);
      for (const booked of sched) {
        if (proposedSeq[0] < booked.end && propEnd > booked.start) {
          collision = true;
          proposedStart = nextWorkingDay(booked.end, holidays);
          break;
        }
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
    newBenchFreeSlot,
    newFinishingFreeSlot,
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
  const startSlot = { date: parseISO(settings.startDate), halfStart: 0 };
  const state = {
    benchFreeSlot: startSlot,
    finishingFreeSlot: startSlot,
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
    if (benchTask?.endSlot && compareHalfSlot(benchTask.endSlot, state.benchFreeSlot) > 0) {
      state.benchFreeSlot = benchTask.endSlot;
    }
    if (finishTask?.endSlot && compareHalfSlot(finishTask.endSlot, state.finishingFreeSlot) > 0) {
      state.finishingFreeSlot = finishTask.endSlot;
    }
    if (installTask && installTask.installer) {
      state.installerSchedules[installTask.installer].push({
        start: installTask.start,
        end: installTask.end,
        jobName: job.name,
      });
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

function deepCloneState(state) {
  return {
    benchFreeSlot: {
      date: new Date(state.benchFreeSlot.date.getTime()),
      halfStart: state.benchFreeSlot.halfStart,
    },
    finishingFreeSlot: {
      date: new Date(state.finishingFreeSlot.date.getTime()),
      halfStart: state.finishingFreeSlot.halfStart,
    },
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
  });
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

  // Save jobs — DEBOUNCED so rapid typing/dragging doesn't fire 20 saves.
  // Waits 600ms after the last change before writing. Includes the
  // empty-array safety guard so a transient empty state can't wipe data.
  useEffect(() => {
    if (loading || IS_READONLY) return;
    const t = setTimeout(() => {
      if (jobs.length === 0) {
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

  const { scheduled, warnings } = useMemo(
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

  // Auto-popup only for SERIOUS warnings. Routine warnings (FITTER swap, PAIR, DATE
  // moved a few days, BUFFER tight, LOAD) just accumulate in the bell — you can
  // open the modal whenever you want. Serious warnings DO auto-pop because they
  // need attention: target unreachable, locked-job conflicts, fitter conflicts.
  //
  // BUT: NEVER auto-pop while the user is actively editing a job. The editor is
  // open whenever editingJobId is non-null. Closing the editor (clicking a job
  // to deselect, or saving) lets the popup fire if there are unresolved warnings.
  const SERIOUS_WARNING_TYPES = new Set([
    "target_unreachable",
    "installer_conflict",
    "buffer_too_tight",
  ]);
  const seriousActiveSig = useMemo(() =>
    activeWarnings
      .filter(w => SERIOUS_WARNING_TYPES.has(w.type))
      .map(fingerprintFor)
      .join("~"),
    [activeWarnings]
  );
  const [lastSeenSeriousSig, setLastSeenSeriousSig] = useState("");
  useEffect(() => {
    if (loading) return;
    if (seriousActiveSig === "") return;
    if (seriousActiveSig === lastSeenSeriousSig) return;
    // Don't pop while user is editing — wait until they close the editor
    if (editingJobId !== null) return;
    setShowWarnings(true);
    setLastSeenSeriousSig(seriousActiveSig);
  }, [seriousActiveSig, loading, editingJobId]);

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

  // Auto-pop reminders on load if any are active
  useEffect(() => {
    if (!loading && activeReminders.length > 0) {
      setShowReminders(true);
    }
  }, [loading, activeReminders.length]);

  // Apply a weekly real-world check-in. Given today's date and the job that's
  // currently on the bench, compute the offset between where the scheduler had
  // that job and reality, then shift the global startDate by that offset so
  // every job slides forward (or back) by the same amount.
  const applyWeeklyUpdate = ({ benchJobId, machiningJobId }) => {
    if (!benchJobId && !machiningJobId) return;
    // Anchor on the bench job if given (more reliable), otherwise machining.
    const anchorJobId = benchJobId || machiningJobId;
    const anchorJob = scheduled.find(j => j.id === anchorJobId);
    if (!anchorJob) return;
    const today = new Date();
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
      setSettings({ ...settings, lastUpdateDate: fmtISO(today) });
      return;
    }
    const newStartDate = addDays(parseISO(settings.startDate), offset);
    setSettings({
      ...settings,
      startDate: fmtISO(newStartDate),
      lastUpdateDate: fmtISO(today),
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
          onInstallDrag={(jobId, isoDate) => {
            updateJob(jobId, { installOverride: isoDate });
          }}
          onClearOverride={(jobId) => {
            updateJob(jobId, { installOverride: "" });
          }}
          onInstallResize={(jobId, days) => {
            updateJob(jobId, { installDaysOverride: days });
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
          onMachiningDrag={(jobId, isoDate) => {
            updateJob(jobId, { machiningOverride: isoDate });
          }}
          onMachiningResize={(jobId, days) => {
            updateJob(jobId, { machiningDaysOverride: days });
          }}
          onMachiningReset={(jobId) => {
            updateJob(jobId, { machiningOverride: "", machiningDaysOverride: 0 });
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

function Header({ onAddJob, onSettings, onWhatIf, onExport, onImport, jobCount, warningCount, onShowWarnings, reminderCount, onShowReminders, onWeeklyUpdate, lastUpdateDate }) {
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
    case "installer_conflict": return "#c44a3a"; // red — needs your decision
    case "sibling":            return "#3a6b5a"; // green — pairing
    case "bunching":           return "#c44a3a"; // red — capacity issue
    case "target_stagger":     return "#c47a2a"; // orange — date moved
    case "target_unreachable": return "#c44a3a"; // red — hard miss
    case "slip":               return "#c44a3a";
    case "buffer_tight":       return "#c47a2a"; // orange — buffer compressed
    case "buffer_too_tight":   return "#c44a3a"; // red — under minimum
    case "load":
    case "install_load":       return "#8a6b3a"; // amber — info
    default:                   return "#555";
  }
}

function warningLabelFor(type) {
  switch (type) {
    case "installer":          return "FITTER";
    case "installer_conflict": return "FITTER!";
    case "sibling":            return "PAIR";
    case "bunching":           return "BENCH";
    case "target_stagger":     return "DATE";
    case "target_unreachable": return "TARGET";
    case "slip":               return "SLIP";
    case "buffer_tight":       return "BUFFER";
    case "buffer_too_tight":   return "BUFFER!";
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
        {(job.machiningOverride || (job.machiningDaysOverride && job.machiningDaysOverride > 0)) && (
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
              Machining manually adjusted
              {job.machiningOverride && ` · starts ${fmtUK(parseISO(job.machiningOverride))}`}
              {job.machiningDaysOverride > 0 && ` · ${job.machiningDaysOverride} day${job.machiningDaysOverride === 1 ? "" : "s"}`}
            </span>
            <button
              style={{ ...styles.btnGhost, padding: "3px 8px", fontSize: 10 }}
              onClick={() => onUpdate({ machiningOverride: "", machiningDaysOverride: 0 })}
            >
              Reset to auto
            </button>
          </div>
        )}
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

function GanttView({ jobs, startDate, holidays, fitterHolidays, onInstallDrag, onClearOverride, onInstallResize, onToggleLock, onDeliveryDrag, onMachiningDrag, onMachiningResize, onMachiningReset }) {
  const COL_WIDTH = 36;       // wider so day numbers are readable
  const HALF_WIDTH = COL_WIDTH / 2;
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

  // Determine date range
  const allDates = jobs.flatMap(j => (j.tasks || []).flatMap(t => [t.start, t.end]));
  if (allDates.length === 0) {
    return (
      <div style={styles.gantt}>
        <div style={styles.empty}>Add jobs to see the schedule.</div>
      </div>
    );
  }
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

  const xFor = (date) => diffDays(date, ganttStart) * COL_WIDTH;

  // Position bars using half-slot precision when available
  const barLeftFor = (task) => {
    if (task.startSlot) {
      const dayOffset = diffDays(task.startSlot.date, ganttStart);
      return dayOffset * COL_WIDTH + (task.startSlot.halfStart * HALF_WIDTH);
    }
    return xFor(task.start);
  };

  const barWidthFor = (task) => {
    if (task.startSlot && task.endSlot) {
      const left = barLeftFor(task);
      const endDayOffset = diffDays(task.endSlot.date, ganttStart);
      const right = endDayOffset * COL_WIDTH + (task.endSlot.halfStart * HALF_WIDTH);
      return Math.max(right - left - 1, 6);
    }
    // Whole-day tasks: use start→end span
    return Math.max(diffDays(task.end, task.start) * COL_WIDTH - 1, 6);
  };

  // Split a task into one or more segments so bars don't cross weekends/holidays.
  // Returns array of {left, width} pairs.
  // Stages that are workshop-only (don't run Friday afternoons)
  const WORKSHOP_STAGES = new Set(["machining", "bench", "finishing", "reassembly"]);

  const segmentsFor = (task) => {
    const segments = [];
    // Determine the full pixel span
    const fullLeft = barLeftFor(task);
    const fullWidth = barWidthFor(task);
    if (fullWidth <= 0) return segments;
    const fullRight = fullLeft + fullWidth;
    const isWorkshop = WORKSHOP_STAGES.has(task.stage);

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
      const dayLeft = dayIdx * COL_WIDTH;
      const dayMid = dayLeft + COL_WIDTH / 2;
      const dayRight = dayLeft + COL_WIDTH;

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
        // Workshop stages run Friday AM only. Open segment if needed, close at midday.
        if (segStart === null) {
          segStart = Math.max(dayLeft, fullLeft);
        }
        // Cap segment at Friday's mid-point (or fullRight if task ends earlier in AM)
        const segEnd = Math.min(dayMid, fullRight);
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
  };

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
            {jobs.map((job, i) => (
              <div
                key={job.id}
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
                  const isDraggingThis = dragState && dragState.jobId === job.id
                    && ((isInstall && (dragState.stage === "install" || !dragState.stage))
                        || (t.stage === "machining" && dragState.stage === "machining"));
                  const isResizingThis = resizeState && resizeState.jobId === job.id
                    && ((isInstall && (resizeState.stage === "install" || !resizeState.stage))
                        || (t.stage === "machining" && resizeState.stage === "machining"));
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
                  const segs = segmentsFor(t);

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
                    const resizeLeft = barLeftFor(t);
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
                  segs.forEach((seg, si) => {
                    const isLastSeg = si === segs.length - 1;
                    const isMachiningStage = t.stage === "machining";
                    const isDraggable = (isInstall && !isLocked) || isMachiningStage;
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
                          cursor: isInstall
                            ? (isLocked ? "default" : "grab")
                            : isMachiningStage ? "grab" : "default",
                          outline: (isInstall && job.installOverride && !isLocked)
                            ? "1px dashed rgba(58,52,44,0.4)"
                            : (isMachiningStage && t.isOverridden)
                            ? "1px dashed rgba(58,52,44,0.4)"
                            : "none",
                        }}
                        title={tooltip}
                        onContextMenu={isMachiningStage && t.isOverridden ? (e) => {
                          e.preventDefault();
                          if (window.confirm("Reset machining to auto-calculated position and duration?")) {
                            onMachiningReset && onMachiningReset(job.id);
                          }
                        } : undefined}
                        onMouseDown={isDraggable ? (e) => {
                          e.preventDefault();
                          const startX = e.clientX;
                          const barLeft = barLeftFor(t);
                          const barW = barWidthFor(t);
                          let lastDate = null;
                          const onMove = (ev) => {
                            const dx = ev.clientX - startX;
                            const newLeft = barLeft + dx;
                            const snappedDayIdx = Math.round(newLeft / COL_WIDTH);
                            if (snappedDayIdx < 0 || snappedDayIdx >= days.length) return;
                            let snappedDate = days[snappedDayIdx];
                            while (isWeekend(snappedDate) || holidays.has(dayKey(snappedDate))) {
                              snappedDate = addDays(snappedDate, 1);
                              if (diffDays(snappedDate, ganttStart) >= days.length) break;
                            }
                            const snappedLeft = diffDays(snappedDate, ganttStart) * COL_WIDTH;
                            lastDate = dayKey(snappedDate);
                            setDragState({
                              jobId: job.id,
                              currentLeft: snappedLeft,
                              currentDate: lastDate,
                              width: barW,
                              stage: t.stage,
                            });
                          };
                          const onUp = () => {
                            window.removeEventListener("mousemove", onMove);
                            window.removeEventListener("mouseup", onUp);
                            setDragState(null);
                            if (lastDate && lastDate !== dayKey(t.start)) {
                              if (isInstall) {
                                onInstallDrag && onInstallDrag(job.id, lastDate);
                              } else if (isMachiningStage) {
                                onMachiningDrag && onMachiningDrag(job.id, lastDate);
                              }
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

                    // Resize handle on the last segment (install when unlocked, OR machining anytime)
                    const isResizable = (isInstall && !isLocked) || isMachiningStage;
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
                            const startWidth = barWidthFor(t);
                            const startDays = t.days;
                            let lastDays = startDays;
                            let lastWidth = startWidth;
                            const onMove = (ev) => {
                              const dx = ev.clientX - startX;
                              const dayDelta = Math.round(dx / COL_WIDTH);
                              const newDays = Math.max(1, Math.min(15, startDays + dayDelta));
                              lastDays = newDays;
                              lastWidth = newDays * COL_WIDTH - 1;
                              setResizeState({
                                jobId: job.id,
                                currentDays: newDays,
                                currentWidth: lastWidth,
                                stage: t.stage,
                              });
                            };
                            const onUp = () => {
                              window.removeEventListener("mousemove", onMove);
                              window.removeEventListener("mouseup", onUp);
                              setResizeState(null);
                              if (lastDays !== startDays) {
                                if (isInstall) {
                                  onInstallResize && onInstallResize(job.id, lastDays);
                                } else if (isMachiningStage) {
                                  onMachiningResize && onMachiningResize(job.id, lastDays);
                                }
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
                          onClick={(e) => {
                            e.stopPropagation();
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
                          cursor: "grab",
                          zIndex: 6,
                          boxShadow: "0 1px 3px rgba(58,52,44,0.4)",
                          border: "1.5px solid #faf6ec",
                          opacity: isDraggingThisDel ? 0.85 : 1,
                        }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const startX = e.clientX;
                          const startLeft = delDayIdx * COL_WIDTH;
                          let lastDate = null;
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
                            setDeliveryDragState({
                              jobId: job.id,
                              currentLeft: snappedLeft,
                              currentDate: lastDate,
                            });
                          };
                          const onUp = () => {
                            window.removeEventListener("mousemove", onMove);
                            window.removeEventListener("mouseup", onUp);
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

export default App;
