// Run: node scripts/test-floor-merge.mjs
import assert from "node:assert/strict";
import {
  mergeCounts, mergeStageCounts, mergeLWW, mergeSet3,
  mergeByDateStage, mergeAppendOnlyList, mergeDrawerBatches,
} from "../src/floorMerge.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok  " + name); };

t("two devices each add 1 to the same counter -> both taps survive", () => {
  // both started at 3; A saved 4 already, B (also 4 locally) now merges against fresh=4
  assert.deepEqual(mergeCounts({ j: 3 }, { j: 4 }, { j: 4 }), { j: 5 });
});

t("untouched counter just takes the server value", () => {
  assert.deepEqual(mergeCounts({ j: 3 }, { j: 3 }, { j: 7 }), { j: 7 });
});

t("our unsaved tap is kept on top of newer server state", () => {
  assert.deepEqual(mergeCounts({ j: 3 }, { j: 4 }, { j: 6 }), { j: 7 });
});

t("minus is additive too and never goes below zero", () => {
  assert.deepEqual(mergeCounts({ j: 5 }, { j: 4 }, { j: 5 }), { j: 4 });
  assert.deepEqual(mergeCounts({ j: 1 }, { j: 0 }, { j: 0 }), { j: 0 });
});

t("a failed/empty server read does NOT zero untouched counters when handled by caller", () => {
  // callers must abort on a failed read; this documents what an empty fresh would do
  assert.deepEqual(mergeCounts({ j: 5 }, { j: 5 }, {}), { j: 0 });
});

t("stage counts: only named stages, other keys ignored", () => {
  const out = mergeStageCounts({}, { cnc: { a: 1 } }, { cnc: { a: 2 }, notes: ["x"] }, ["cnc", "prep"]);
  assert.deepEqual(out, { cnc: { a: 3 } });
});

t("LWW: untouched takes fresh, touched keeps mine, absent stays absent", () => {
  assert.deepEqual(mergeLWW({ a: 5 }, { a: 5 }, { a: 9 }), { a: 9 });
  assert.deepEqual(mergeLWW({ a: 5 }, { a: 6 }, { a: 9 }), { a: 6 });
  assert.deepEqual(mergeLWW({ a: 5 }, { a: 5 }, {}), {});           // remotely deleted -> not resurrected as 0
  assert.deepEqual(mergeLWW({ a: 5 }, {}, { a: 5 }), {});           // we deleted it
});

t("set merge: both devices' additions survive, our removals apply", () => {
  const id = x => x;
  assert.deepEqual(mergeSet3(["a"], ["a", "b"], ["a", "c"], id).sort(), ["a", "b", "c"]);
  assert.deepEqual(mergeSet3(["a", "b"], ["a"], ["a", "b", "c"], id).sort(), ["a", "c"]);
});

t("by date+stage applies the leaf merge at each cell", () => {
  const out = mergeByDateStage(
    { d1: { cnc: { j: 4 } } },
    { d1: { cnc: { j: 4 } }, d2: { prep: { j: 9 } } },
    { d1: { cnc: { j: 6 } } },
    mergeLWW,
  );
  assert.deepEqual(out, { d1: { cnc: { j: 6 } }, d2: { prep: { j: 9 } } });
});

t("append-only list keeps server entries plus our unsynced ones, no dupes", () => {
  assert.deepEqual(mergeAppendOnlyList(["a", "b"], ["a", "c"], x => x), ["a", "c", "b"]);
});

t("drawer batches: both adds survive, our toggle wins, untouched takes server", () => {
  const A = { id: "1", label: "A", count: 2, done: false };
  const B = { id: "2", label: "B", count: 3, done: false };
  const C = { id: "3", label: "C", count: 1, done: false };
  // we added C, someone else added B
  assert.deepEqual(mergeDrawerBatches([A], [A, C], [A, B]).map(x => x.id), ["1", "3", "2"]);
  // we toggled A done, server still has it not done
  const out = mergeDrawerBatches([A], [{ ...A, done: true }], [A]);
  assert.equal(out[0].done, true);
  // we didn't touch A, server toggled it
  const out2 = mergeDrawerBatches([A], [A], [{ ...A, done: true }]);
  assert.equal(out2[0].done, true);
});

console.log(`\n${n} passed`);
