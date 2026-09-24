// Backs up the entire schedule (every key in Supabase's kv_store table —
// jobs, settings, dismissed reminders/warnings, floor board records, drawer
// batches, weekly plan, everything the app reads/writes) to a timestamped
// JSON file under backups/. That folder lives inside the OneDrive/SharePoint-
// synced project directory, so every backup written here also lands on
// OneDrive and any other device syncing this same folder — no separate
// upload step needed. Read-only: never writes anything back to Supabase.
//
// Also writes a matching .csv with just the job list (name, cabinets,
// colour, installer, install date, notes) — the JSON is the complete,
// exact-fidelity backup for restoring from; the CSV is there so a human
// can just open it in Excel and read it, no JSON-wrangling needed.
//
// Run manually:   node --env-file=.env scripts/backup-schedule.mjs
// Run on schedule: see the Windows Task Scheduler task "EvieWillowScheduleBackup".

import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const backupsDir = path.join(projectRoot, "backups");

const RETENTION_DAYS = 90;

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (run with --env-file=.env, or set them in the environment).");
  process.exit(1);
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data, error } = await supabase.from("kv_store").select("key, value, updated_at");
  if (error) {
    console.error("Backup failed — could not read kv_store:", error.message);
    process.exit(1);
  }

  await mkdir(backupsDir, { recursive: true });

  const now = new Date();
  const stamp = now.toISOString().replace(/:/g, "-").replace(/\..+/, ""); // e.g. 2026-09-25T09-00-00
  const outFile = path.join(backupsDir, `schedule-backup-${stamp}.json`);

  const payload = {
    backedUpAt: now.toISOString(),
    source: SUPABASE_URL,
    rowCount: data.length,
    rows: data,
  };

  await writeFile(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Backed up ${data.length} key(s) to ${outFile}`);

  const jobsRow = data.find(r => r.key === "ew-jobs");
  if (jobsRow?.value) {
    const csvFile = path.join(backupsDir, `schedule-backup-${stamp}.csv`);
    await writeFile(csvFile, jobsToCsv(jobsRow.value), "utf8");
    console.log(`Wrote readable job list to ${csvFile}`);
  }

  await pruneOldBackups();
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function jobsToCsv(jobs) {
  const header = ["Job name", "Total cabinets", "Colour", "Installer", "Install date", "Locked", "Notes"];
  const lines = [header.map(csvCell).join(",")];
  for (const j of jobs) {
    const totalCabinets = Object.values(j.cabinets || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
    const installDate = j.installOverride || j.targetInstallWeek || "";
    lines.push([
      j.name,
      totalCabinets,
      j.colour?.name || "",
      j.installer || "auto",
      installDate,
      j.locked ? "yes" : "",
      j.notes || "",
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

async function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = await readdir(backupsDir);
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith("schedule-backup-") || !name.endsWith(".json")) continue;
    const full = path.join(backupsDir, name);
    const info = await stat(full);
    if (info.mtimeMs < cutoff) {
      await unlink(full);
      removed++;
    }
  }
  if (removed > 0) console.log(`Pruned ${removed} backup(s) older than ${RETENTION_DAYS} days.`);
}

main();
