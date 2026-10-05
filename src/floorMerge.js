// Pure merge functions for the floor board's shared state. Several devices
// tap and edit the same records at once, and each device only ever knows
// the server state as of its last sync (its "baseline"). Every merge here is
// a 3-way merge of (baseline, mine, fresh):
//   baseline = what the server held when we last synced
//   mine     = our current local copy (baseline + our unsaved edits)
//   fresh    = what the server holds right now (may include other devices' edits)
// Kept free of any DOM/storage access so it can be tested on its own — see
// scripts/test-floor-merge.mjs.

const keysOf = (...objs) => new Set(objs.flatMap(o => Object.keys(o || {})));

export const cloneJSON = (v, fallback) => (v == null ? fallback : JSON.parse(JSON.stringify(v)));

// Counters (tap counts, week-to-date): additive, not last-writer-wins. If two
// devices each add one to the same counter, both taps must survive:
// fresh + (mine - baseline). Floors at 0.
export function mergeCounts(base, mine, fresh) {
  const out = {};
  for (const k of keysOf(base, mine, fresh)) {
    const v = ((fresh || {})[k] || 0) + (((mine || {})[k] || 0) - ((base || {})[k] || 0));
    out[k] = Math.max(0, v);
  }
  return out;
}

// { stageKey: { jobId: count } } — mergeCounts per stage. Only the named
// stage keys are touched (the day record also carries offPlan/notes arrays).
export function mergeStageCounts(base, mine, fresh, stageKeys) {
  const out = {};
  for (const s of stageKeys) {
    const m = mergeCounts((base || {})[s], (mine || {})[s], (fresh || {})[s]);
    if (Object.keys(m).length) out[s] = m;
  }
  return out;
}

// Typed-in values (weekly targets): last writer wins per key, and "absent"
// stays absent rather than turning into 0.
export function mergeLWW(base, mine, fresh) {
  const out = {};
  for (const k of keysOf(base, mine, fresh)) {
    const touched = (mine || {})[k] !== (base || {})[k];
    const v = touched ? (mine || {})[k] : (fresh || {})[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Sets of items that can be added or removed (weekly removed/extra lists):
// start from the server's list, apply what WE added and what WE removed.
export function mergeSet3(base, mine, fresh, keyFn) {
  const bk = new Set((base || []).map(keyFn));
  const mk = new Set((mine || []).map(keyFn));
  const out = new Map((fresh || []).map(x => [keyFn(x), x]));
  for (const x of (mine || [])) if (!bk.has(keyFn(x))) out.set(keyFn(x), x);
  for (const k of bk) if (!mk.has(k)) out.delete(k);
  return [...out.values()];
}

// { dateISO: { stageKey: leaf } } — applies leafFn(baseLeaf, myLeaf, freshLeaf)
// at each date+stage.
export function mergeByDateStage(base, mine, fresh, leafFn) {
  const out = {};
  for (const d of keysOf(base, mine, fresh)) {
    const b = (base || {})[d] || {}, m = (mine || {})[d] || {}, f = (fresh || {})[d] || {};
    const day = {};
    for (const s of keysOf(b, m, f)) day[s] = leafFn(b[s], m[s], f[s]);
    out[d] = day;
  }
  return out;
}

// Append-only lists with no delete in the UI (notes, off-plan markers): the
// server's current list plus whatever of ours it doesn't have yet.
export function mergeAppendOnlyList(mine, fresh, keyFn) {
  const fk = new Set((fresh || []).map(keyFn));
  return [...(fresh || []), ...(mine || []).filter(x => !fk.has(keyFn(x)))];
}

// Drawer batches: objects with an id; one can be edited (done toggled).
// Touched = new, or differs from the baseline copy.
export function mergeDrawerBatches(base, mine, fresh) {
  const baseById = new Map((base || []).map(b => [b.id, b]));
  const freshById = new Map((fresh || []).map(b => [b.id, b]));
  const out = [];
  const seen = new Set();
  for (const m of (mine || [])) {
    seen.add(m.id);
    const b = baseById.get(m.id);
    const touched = !b || JSON.stringify(b) !== JSON.stringify(m);
    if (touched) out.push(m);
    else if (freshById.has(m.id)) out.push(freshById.get(m.id));
  }
  for (const f of (fresh || [])) {
    if (!seen.has(f.id) && !baseById.has(f.id)) out.push(f);
  }
  return out;
}
