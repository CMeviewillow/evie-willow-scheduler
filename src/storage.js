// Storage layer wrapping Supabase as a key-value store.
// Mimics the window.storage API used by the original artifact:
//   window.storage.get(key, shared) → { key, value, shared } | null
//   window.storage.set(key, value, shared) → { key, value, shared }
//   window.storage.delete(key, shared) → { key, deleted, shared }
//   window.storage.list(prefix, shared) → { keys, prefix, shared }
//
// We store everything in a single Supabase table `kv_store` with columns:
//   key (text, primary key)
//   value (jsonb)
//   updated_at (timestamptz, default now())
//
// Realtime: we subscribe to changes so multiple tablets stay in sync.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Subscribers for realtime change notifications
const subscribers = new Set();
let realtimeChannel = null;

function ensureRealtime() {
  if (!supabase || realtimeChannel) return;
  realtimeChannel = supabase
    .channel("kv_store_changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "kv_store" }, () => {
      // Notify all subscribers that something changed
      subscribers.forEach(fn => {
        try { fn(); } catch (e) { console.error(e); }
      });
    })
    .subscribe();
}

// Public API matching window.storage
export const storage = {
  async get(key) {
    if (!supabase) throw new Error("Supabase not configured");
    const { data, error } = await supabase
      .from("kv_store")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { key, value: typeof data.value === "string" ? data.value : JSON.stringify(data.value), shared: true };
  },

  async set(key, value) {
    if (!supabase) throw new Error("Supabase not configured");
    let parsed = value;
    try { parsed = JSON.parse(value); } catch (e) { /* keep as string */ }
    const { error } = await supabase
      .from("kv_store")
      .upsert({ key, value: parsed, updated_at: new Date().toISOString() });
    if (error) throw error;
    return { key, value, shared: true };
  },

  async delete(key) {
    if (!supabase) throw new Error("Supabase not configured");
    const { error } = await supabase
      .from("kv_store")
      .delete()
      .eq("key", key);
    if (error) throw error;
    return { key, deleted: true, shared: true };
  },

  async list(prefix) {
    if (!supabase) throw new Error("Supabase not configured");
    let query = supabase.from("kv_store").select("key");
    if (prefix) query = query.like("key", `${prefix}%`);
    const { data, error } = await query;
    if (error) throw error;
    return { keys: (data || []).map(r => r.key), prefix, shared: true };
  },

  // Subscribe to changes. Returns an unsubscribe function.
  subscribe(callback) {
    ensureRealtime();
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  },

  isConfigured() {
    return !!supabase;
  },
};

// Install on window so the scheduler can find it (matches original artifact API)
if (typeof window !== "undefined") {
  window.storage = storage;
}
