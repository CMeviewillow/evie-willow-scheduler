// Backs up the entire schedule (every key in Supabase's kv_store table —
// jobs, settings, dismissed reminders/warnings, floor board records, drawer
// batches, weekly plan, everything the app reads/writes) to a timestamped
// JSON file under backups/. That folder lives inside the OneDrive/SharePoint-
// synced project directory, so every backup written here also lands on
// OneDrive and any other device syncing this same folder — no separate
// upload step needed. Read-only: never writes anything back to Supabase.
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

  await pruneOldBackups();
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
