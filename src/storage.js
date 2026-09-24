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
//
// Uses Realtime Broadcast (a plain pub/sub signal), not postgres_changes
// (database change capture). postgres_changes sends the ENTIRE changed row
// over the websocket to every connected client on every write — but every
// subscriber here only uses the notification as a "go re-fetch yourself"
// signal and never reads the row payload it was given, so that full-row
// data was being transmitted and immediately discarded, unused, on every
// single change, to every open tab. Confirmed as the likely driver of a
// real Supabase egress-quota breach (12+ GB in one billing period against
// a 5GB cap) — see project_realtime_broadcast_egress_fix memory. Broadcast
// carries only the tiny message envelope we choose to send (empty here),
// regardless of how large kv_store's rows are.

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
let realtimeReady = null; // Promise resolving once the channel is actually subscribed

// Lazily creates the shared broadcast channel (once per tab) and returns a
// promise that resolves when it's ready to send on. Safe to call from both
// subscribe() (to start listening) and set()/delete() (to notify) — whoever
// calls first creates it, everyone else reuses the same channel/promise.
function ensureRealtime() {
  if (!supabase) return null;
  if (!realtimeChannel) {
    realtimeChannel = supabase.channel("kv_store_changes");
    realtimeChannel.on("broadcast", { event: "changed" }, () => {
      // Notify all subscribers that something changed — no payload to read,
      // callers already re-fetch whatever they need themselves.
      subscribers.forEach(fn => {
        try { fn(); } catch (e) { console.error(e); }
      });
    });
    realtimeReady = new Promise((resolve) => {
      realtimeChannel.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve();
      });
    });
  }
  return realtimeReady;
}

// Best-effort notify other tabs after our own write — never blocks or
// fails the write itself if the channel isn't ready yet (e.g. a save that
// races ahead of the subscription finishing on a fresh page load); other
// tabs will still pick the change up on their own next load/poll.
function notifyChanged() {
  const ready = ensureRealtime();
  if (!ready) return;
  ready.then(() => {
    realtimeChannel.send({ type: "broadcast", event: "changed", payload: {} });
  }).catch(() => {});
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
    notifyChanged();
    return { key, value, shared: true };
  },

  async delete(key) {
    if (!supabase) throw new Error("Supabase not configured");
    const { error } = await supabase
      .from("kv_store")
      .delete()
      .eq("key", key);
    if (error) throw error;
    notifyChanged();
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
