import React, { useState } from "react";
import {
  SAMPLE_JOB, SAMPLE_ROOM, SAMPLE_CABINET_TYPES, SAMPLE_CABINETS,
  SAMPLE_EXCLUDED_COUNT, SAMPLE_ROOM_EXTRAS, SAMPLE_ACCESSORIES, SAMPLE_WORKSHOP_PEOPLE,
} from "./sampleData.js";

// Local-only try-it-out preview for Phase 2 (import review) and Phase 3
// (bench prep tap) — reached with ?admin=preview, same pattern as
// ?admin=aliases. Nothing here touches Supabase: the real tables
// (production_imports, cabinets, room_extras, cabinet_accessories,
// stage_completions) have never been executed against the live database,
// so this runs entirely on localStorage under the "tt-preview:" prefix,
// seeded from a real job (DA1277 Anna Reid) the first time it's opened.
// See docs/time-tracker.md and the project_time_tracker_phase2_groundwork
// memory for where every figure here comes from.

const LS_PREFIX = "tt-preview:";
function load(key, fallback) {
  try {
    const v = localStorage.getItem(LS_PREFIX + key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

function initialCabinets() {
  return SAMPLE_CABINETS.map(c => ({
    ...c,
    typeName: c.typeGuess,
    needsReview: c.typeGuess === null,
  }));
}
function initialExtras() {
  return SAMPLE_ROOM_EXTRAS.map(e => ({ ...e, needsOfficeReview: true }));
}
function initialAccessories() {
  return SAMPLE_ACCESSORIES.map((a, i) => ({ ...a, id: i, ordered: false, fitted: false }));
}

const styles = {
  wrap: { fontFamily: "system-ui, sans-serif", maxWidth: 980, margin: "0 auto", padding: "24px 20px 60px" },
  banner: { background: "#fff3cd", border: "1px solid #e8c468", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#6b5410", marginBottom: 24, lineHeight: 1.5 },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 2 },
  subtitle: { color: "#666", marginBottom: 20, fontSize: 14 },
  tabs: { display: "flex", gap: 8, marginBottom: 24, borderBottom: "1px solid #ddd" },
  tab: (active) => ({
    padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", border: "none", background: "none",
    color: active ? "#2c5f4f" : "#888", borderBottom: active ? "2px solid #2c5f4f" : "2px solid transparent",
  }),
  sectionTitle: { fontSize: 16, fontWeight: 700, margin: "28px 0 10px" },
  note: { fontSize: 13, color: "#666", marginBottom: 14, lineHeight: 1.5 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "7px 8px", borderBottom: "2px solid #ddd", color: "#666", fontWeight: 600 },
  td: { padding: "7px 8px", borderBottom: "1px solid #eee", verticalAlign: "middle" },
  select: { padding: "4px 6px", fontSize: 13, borderRadius: 4, border: "1px solid #ccc", width: "100%" },
  reviewPill: { display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, padding: "2px 7px", borderRadius: 10, background: "#f5e3dc", color: "#a5614f" },
  okPill: { display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, padding: "2px 7px", borderRadius: 10, background: "#ecf0e2", color: "#5a6e50" },
  extraCard: { background: "#faf6ec", border: "1px solid #e8dfca", borderRadius: 8, padding: "14px 16px", marginBottom: 12 },
  extraHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 },
  extraKind: { fontSize: 14, fontWeight: 700, textTransform: "capitalize" },
  extraMetres: { display: "flex", alignItems: "baseline", gap: 4 },
  extraInput: { width: 70, padding: "4px 6px", fontSize: 15, fontWeight: 700, borderRadius: 4, border: "1px solid #ccc", textAlign: "right" },
  extraNotes: { fontSize: 12, color: "#7a6a55", lineHeight: 1.5 },
  reviewRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: "#a5614f" },
  checkbox: { width: 15, height: 15 },
  summaryBar: { display: "flex", gap: 20, background: "#ecf0e2", border: "1px solid #7a8b6f", borderRadius: 8, padding: "14px 18px", marginBottom: 20 },
  summaryNum: { fontSize: 26, fontWeight: 700, color: "#3a342c", lineHeight: 1 },
  summaryLabel: { fontSize: 12, color: "#5a6e50", marginTop: 2 },
  cabCard: { display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", border: "1px solid #e8dfca", borderRadius: 8, marginBottom: 8, background: "#fff" },
  cabCardDone: { background: "#ecf0e2", borderColor: "#7a8b6f" },
  cabName: { flex: 1, fontSize: 14 },
  cabNum: { color: "#7a6a55", fontWeight: 600, marginRight: 6 },
  partBtn: (done) => ({
    padding: "8px 14px", fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: "pointer",
    border: done ? "1px solid #7a8b6f" : "1px solid #ccc",
    background: done ? "#7a8b6f" : "#fff", color: done ? "#fff" : "#555",
  }),
  personSelect: { padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid #ccc", marginBottom: 16 },
};

function ImportReviewTab({ cabinets, setCabinets, extras, setExtras, accessories, setAccessories }) {
  const setCabinet = (item, patch) => {
    const next = cabinets.map(c => c.item === item ? { ...c, ...patch } : c);
    setCabinets(next); save("cabinets", next);
  };
  const setExtra = (kind, patch) => {
    const next = extras.map(e => e.kind === kind ? { ...e, ...patch } : e);
    setExtras(next); save("extras", next);
  };
  const setAccessory = (id, patch) => {
    const next = accessories.map(a => a.id === id ? { ...a, ...patch } : a);
    setAccessories(next); save("accessories", next);
  };

  const reviewCount = cabinets.filter(c => c.needsReview).length;

  return (
    <div>
      <div style={styles.sectionTitle}>Cabinets — {SAMPLE_JOB.da_number} {SAMPLE_JOB.client_name}, {SAMPLE_ROOM}</div>
      <div style={styles.note}>
        Pulled from the room's A3 Production table. {SAMPLE_EXCLUDED_COUNT} "...ShP Skirting..." rows were
        excluded automatically — those are end panels for site-fitted skirting, not real cabinets (see the
        Skirting &amp; cornice card below). {reviewCount} of {cabinets.length} shown need a type confirmed —
        pick the closest match or leave for the office to create a new type.
      </div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Item</th>
            <th style={styles.th}>Description</th>
            <th style={styles.th}>W × H × D (mm)</th>
            <th style={styles.th}>Matched type</th>
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {cabinets.map(c => (
            <tr key={c.item}>
              <td style={styles.td}>#{c.item}</td>
              <td style={styles.td}>{c.description}</td>
              <td style={styles.td}>{c.width} × {c.height} × {c.depth}</td>
              <td style={styles.td}>
                <select
                  style={styles.select}
                  value={c.typeName || ""}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setCabinet(c.item, { typeName: v, needsReview: v === null });
                  }}
                >
                  <option value="">— new type needed —</option>
                  {SAMPLE_CABINET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td style={styles.td}>
                {c.needsReview
                  ? <span style={styles.reviewPill}>NEEDS REVIEW</span>
                  : <span style={styles.okPill}>MATCHED</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={styles.sectionTitle}>Skirting &amp; cornice</div>
      <div style={styles.note}>
        Never itemized as cabinets — a linear-metres figure for the whole room, calculated from the item
        table and the drawing's own installer notes. Always a starting figure, editable here the same way
        the office would confirm or correct it before ordering.
      </div>
      {extras.map(e => (
        <div key={e.kind} style={styles.extraCard}>
          <div style={styles.extraHead}>
            <div style={styles.extraKind}>{e.kind}</div>
            <div style={styles.extraMetres}>
              <input
                style={styles.extraInput}
                type="number" step="0.01"
                value={e.metres}
                onChange={(ev) => setExtra(e.kind, { metres: parseFloat(ev.target.value) || 0 })}
              />
              <span>m</span>
            </div>
          </div>
          <div style={styles.extraNotes}>{e.calculation_notes}</div>
          <label style={styles.reviewRow}>
            <input
              type="checkbox" style={styles.checkbox}
              checked={e.needsOfficeReview}
              onChange={(ev) => setExtra(e.kind, { needsOfficeReview: ev.target.checked })}
            />
            Needs office review before ordering
          </label>
        </div>
      ))}

      <div style={styles.sectionTitle}>Spec Sheet extras</div>
      <div style={styles.note}>
        Bought-in accessories from the Spec Sheet only — never on the Production file. No bench time of
        their own; a divider that's genuinely built is already part of its host cabinet's own row above.
        Blank cabinet numbers are real "TBC" cases from the Spec Sheet itself, not import errors.
      </div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Item</th>
            <th style={styles.th}>Cabinet</th>
            <th style={styles.th}>Spec Sheet text</th>
            <th style={styles.th}>Ordered</th>
            <th style={styles.th}>Fitted</th>
          </tr>
        </thead>
        <tbody>
          {accessories.map(a => (
            <tr key={a.id}>
              <td style={styles.td}>{a.label}{a.productCode ? ` (${a.productCode})` : ""}</td>
              <td style={styles.td}>{a.cabinetItem ? `#${a.cabinetItem}` : <span style={styles.reviewPill}>TBC</span>}</td>
              <td style={styles.td}>{a.rawSpecText}</td>
              <td style={styles.td}>
                <input type="checkbox" style={styles.checkbox} checked={a.ordered}
                  onChange={(ev) => setAccessory(a.id, { ordered: ev.target.checked })} />
              </td>
              <td style={styles.td}>
                <input type="checkbox" style={styles.checkbox} checked={a.fitted}
                  onChange={(ev) => setAccessory(a.id, { fitted: ev.target.checked })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BenchPrepTab({ cabinets, completions, setCompletions }) {
  const [person, setPerson] = useState(SAMPLE_WORKSHOP_PEOPLE[0]);
  const bench = cabinets.filter(c => c.typeName !== "Panel");

  const toggle = (item, part) => {
    const cur = completions[item] || { frame: false, door: false };
    const next = { ...completions, [item]: { ...cur, [part]: !cur[part] } };
    setCompletions(next); save("completions", next);
  };

  const fractionFor = (item) => {
    const c = completions[item] || { frame: false, door: false };
    return (c.frame ? 0.5 : 0) + (c.door ? 0.5 : 0);
  };
  const totalDone = bench.reduce((a, c) => a + fractionFor(c.item), 0);

  return (
    <div>
      <div style={styles.summaryBar}>
        <div>
          <div style={styles.summaryNum}>{totalDone.toFixed(1)}</div>
          <div style={styles.summaryLabel}>of {bench.length} cabinets — Bench prep today</div>
        </div>
        <div>
          <div style={styles.summaryNum}>{bench.filter(c => fractionFor(c.item) === 1).length}</div>
          <div style={styles.summaryLabel}>fully complete (frame + door)</div>
        </div>
        <div>
          <div style={styles.summaryNum}>{bench.filter(c => fractionFor(c.item) === 0.5).length}</div>
          <div style={styles.summaryLabel}>half done (one part only)</div>
        </div>
      </div>
      <div style={styles.note}>
        This total is exactly what the floor board's Bench prep target would read from
        <code> cabinet_stage_progress</code> once Phase 3 is wired up — a frame tap alone counts half a
        cabinet, both taps count one, matching the real workflow you confirmed.
      </div>

      <label style={{ display: "block", fontSize: 13, color: "#555", marginBottom: 4 }}>Tapping in as</label>
      <select style={styles.personSelect} value={person} onChange={(e) => setPerson(e.target.value)}>
        {SAMPLE_WORKSHOP_PEOPLE.map(p => <option key={p} value={p}>{p}</option>)}
      </select>

      {bench.map(c => {
        const comp = completions[c.item] || { frame: false, door: false };
        const frac = fractionFor(c.item);
        return (
          <div key={c.item} style={{ ...styles.cabCard, ...(frac === 1 ? styles.cabCardDone : {}) }}>
            <div style={styles.cabName}><span style={styles.cabNum}>#{c.item}</span>{c.description}</div>
            <button style={styles.partBtn(comp.frame)} onClick={() => toggle(c.item, "frame")}>Frame</button>
            <button style={styles.partBtn(comp.door)} onClick={() => toggle(c.item, "door")}>Door</button>
          </div>
        );
      })}
    </div>
  );
}

export default function TimeTrackerPreview() {
  const [tab, setTab] = useState("import");
  const [cabinets, setCabinets] = useState(() => load("cabinets", null) || initialCabinets());
  const [extras, setExtras] = useState(() => load("extras", null) || initialExtras());
  const [accessories, setAccessories] = useState(() => load("accessories", null) || initialAccessories());
  const [completions, setCompletions] = useState(() => load("completions", null) || {});

  const resetDemo = () => {
    if (!window.confirm("Reset this preview back to the original Anna Reid sample data?")) return;
    const c = initialCabinets(), e = initialExtras(), a = initialAccessories();
    setCabinets(c); save("cabinets", c);
    setExtras(e); save("extras", e);
    setAccessories(a); save("accessories", a);
    setCompletions({}); save("completions", {});
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.banner}>
        <strong>Preview, not live.</strong> The real database tables for this (cabinets, room_extras,
        cabinet_accessories, stage_completions) have never been run against Supabase yet — everything here
        saves to this browser only, seeded from a real job (DA1277 Anna Reid). Nothing you do on this page
        touches the main schedule or floor board. <a href="#" onClick={(e) => { e.preventDefault(); resetDemo(); }}>Reset to sample data</a>
      </div>
      <div style={styles.title}>Time tracker — try it out</div>
      <div style={styles.subtitle}>Phase 2 import review, and Phase 3's bench prep tap, both against real sample data.</div>

      <div style={styles.tabs}>
        <button style={styles.tab(tab === "import")} onClick={() => setTab("import")}>Import review</button>
        <button style={styles.tab(tab === "bench")} onClick={() => setTab("bench")}>Bench prep tap</button>
      </div>

      {tab === "import"
        ? <ImportReviewTab cabinets={cabinets} setCabinets={setCabinets} extras={extras} setExtras={setExtras} accessories={accessories} setAccessories={setAccessories} />
        : <BenchPrepTab cabinets={cabinets} completions={completions} setCompletions={setCompletions} />}
    </div>
  );
}
