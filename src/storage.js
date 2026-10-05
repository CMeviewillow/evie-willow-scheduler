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
function notifySubscribers(payload) {
  subscribers.forEach(fn => {
    try { fn(payload); } catch (e) { console.error(e); }
  });
}

function ensureRealtime() {
  if (!supabase) return null;
  if (!realtimeChannel) {
    realtimeChannel = supabase.channel("kv_store_changes");
    realtimeChannel.on("broadcast", { event: "changed" }, (msg) => {
      // Tell subscribers which key changed (the payload is just { key }, a
      // few bytes — still never row contents) so they can ignore writes that
      // aren't theirs; callers re-fetch whatever they need themselves.
      notifySubscribers(msg && msg.payload);
    });
    let everSubscribed = false;
    realtimeReady = new Promise((resolve) => {
      realtimeChannel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // A re-subscribe after a dropped connection: anything broadcast
          // while we were away is gone for good, so tell subscribers to
          // re-read rather than wait for the next write to wake them.
          if (everSubscribed) notifySubscribers({ reconnected: true });
          everSubscribed = true;
          resolve();
        }
      });
    });
  }
  return realtimeReady;
}

// Best-effort notify other tabs after our own write — never blocks or
// fails the write itself if the channel isn't ready yet (e.g. a save that
// races ahead of the subscription finishing on a fresh page load); other
// tabs will still pick the change up on their own next load/poll.
function notifyChanged(key) {
  const ready = ensureRealtime();
  if (!ready) return;
  ready.then(() => {
    realtimeChannel.send({ type: "broadcast", event: "changed", payload: { key } });
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
    notifyChanged(key);
    return { key, value, shared: true };
  },

  // Versioned read/write for records several devices edit at once: read the
  // value together with its updated_at, then write back only if updated_at
  // is still the same (compare-and-swap). A plain get-then-set lets two
  // devices read the same state and the second write silently erase the
  // first — here the second one is refused and must re-read and re-merge.
  async getVersioned(key) {
    if (!supabase) throw new Error("Supabase not configured");
    const { data, error } = await supabase
      .from("kv_store")
      .select("value, updated_at")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { value: null, version: null };
    return {
      value: typeof data.value === "string" ? data.value : JSON.stringify(data.value),
      version: data.updated_at,
    };
  },

  // Returns true if written, false if someone else wrote first (version
  // changed, or the row appeared since we saw it missing). Throws on real errors.
  async setIfVersion(key, value, version) {
    if (!supabase) throw new Error("Supabase not configured");
    let parsed = value;
    try { parsed = JSON.parse(value); } catch (e) { /* keep as string */ }
    const updated_at = new Date().toISOString();
    if (version == null) {
      const { error } = await supabase.from("kv_store").insert({ key, value: parsed, updated_at });
      if (error) {
        if (error.code === "23505") return false;
        throw error;
      }
    } else {
      const { data, error } = await supabase
        .from("kv_store")
        .update({ value: parsed, updated_at })
        .eq("key", key)
        .eq("updated_at", version)
        .select("key");
      if (error) throw error;
      if (!data || !data.length) return false;
    }
    notifyChanged(key);
    return true;
  },

  async delete(key) {
    if (!supabase) throw new Error("Supabase not configured");
    const { error } = await supabase
      .from("kv_store")
      .delete()
      .eq("key", key);
    if (error) throw error;
    notifyChanged(key);
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
