import React, { useState, useEffect } from "react";
import {
  SAMPLE_JOB, SAMPLE_ROOM, SAMPLE_CABINET_TYPES, SAMPLE_CABINETS,
  SAMPLE_EXCLUDED_COUNT, SAMPLE_ROOM_EXTRAS, SAMPLE_ACCESSORIES, SAMPLE_WORKSHOP_PEOPLE,
  SAMPLE_STAGES,
} from "./sampleData.js";

// Local-only try-it-out preview for Phase 2 (import review) and Phase 3
// (the real clock on/off wizard, PIN included) — reached with ?admin=preview,
// same pattern as ?admin=aliases. One combined tool, not separate screens.
// Nothing here touches Supabase: the real tables (production_imports,
// cabinets, room_extras, cabinet_accessories, time_entries) have never
// been executed against the live database, so this
// runs entirely on localStorage under the "tt-preview:" prefix, seeded from
// a real job (DA1277 Anna Reid). PINs are made up for this preview only
// (see SAMPLE_WORKSHOP_PEOPLE) — real people don't have one until it's set
// via ?admin=aliases.
//
// The clock-on/off flow is kiosk-style, not "sign in and stay signed in" —
// matches how a wall-mounted tablet actually gets used (lots of different
// people touching it through the day, nobody "logged in" between turns).
// Every wizard step resets back to "who's clocking on" once you stop.
// Multiple people CAN run against the same cabinet/stage at once (see the
// "Who's on now" tab) — that's normal, not a conflict; the total is labour
// minutes, everyone's time added up, not wall-clock time.
//
// Design/interaction pattern carried over from the earlier "Clock On, Clock
// Off" walkthrough artifact (claude.ai/artifact/JJvSpxSyj8WtoxZQGwy9fb,
// 2026-09-07): wizard steps with a breadcrumb trail, an "already clocked
// on" shortcut if you tap your own name mid-shift, and a live "who's on
// now" board. See docs/time-tracker.md and the
// project_time_tracker_phase2_groundwork memory for where every figure
// here comes from.

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

function fmtElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
function initials(name) {
  return name.slice(0, 2).toUpperCase();
}

// Same palette as the real floor board (FLOOR_BOARD_CSS in scheduler.jsx)
// and the earlier walkthrough artifact — kept visually consistent with
// both rather than inventing a third look.
const C = {
  linen: "#f5f0e6", panel: "#faf6ec", panel2: "#fdfaf2",
  ink: "#3a342c", ink2: "#7a6a55", ink3: "#9b8f7e",
  rule: "#d9cfba", rule2: "#e8dfca",
  sage: "#7a8b6f", sageBg: "#ecf0e2",
  clay: "#a5614f", clayBg: "#f5e3dc",
  honey: "#c9a961", honeyBg: "#f4ecd9",
};

const styles = {
  wrap: { fontFamily: "Inter, -apple-system, 'Segoe UI', sans-serif", maxWidth: 1040, margin: "0 auto", padding: "24px 20px 60px", background: C.linen, color: C.ink },
  serif: { fontFamily: "'Cormorant Garamond', Georgia, serif" },
  banner: { background: "#fff3cd", border: "1px solid #e8c468", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#6b5410", marginBottom: 24, lineHeight: 1.5 },
  title: { fontSize: 24, fontWeight: 500, marginBottom: 2 },
  subtitle: { color: C.ink2, marginBottom: 20, fontSize: 14 },
  tabs: { display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" },
  tab: (active) => ({
    padding: "11px 20px", fontSize: 14, fontWeight: 500, cursor: "pointer",
    border: `1px solid ${active ? C.sage : C.rule}`, borderRadius: 6,
    background: active ? C.sage : C.panel, color: active ? "#fff" : C.ink2,
  }),
  card: { background: C.panel, border: `1px solid ${C.rule}`, borderRadius: 14, padding: "26px 28px 30px", minHeight: 420, boxShadow: "0 18px 40px -22px rgba(58,52,44,.35)" },
  sectionTitle: { fontSize: 16, fontWeight: 700, margin: "28px 0 10px" },
  note: { fontSize: 13, color: C.ink2, marginBottom: 14, lineHeight: 1.5 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "7px 8px", borderBottom: `2px solid ${C.rule}`, color: C.ink3, fontWeight: 600, fontSize: 11, letterSpacing: 0.5, textTransform: "uppercase" },
  td: { padding: "10px 8px", borderBottom: `1px solid ${C.rule2}`, verticalAlign: "middle" },
  select: { padding: "8px 10px", fontSize: 13, borderRadius: 6, border: `1px solid ${C.rule}`, width: "100%", background: "#fff", color: C.ink, fontFamily: "Inter, sans-serif" },
  reviewPill: { display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, padding: "2px 7px", borderRadius: 10, background: C.clayBg, color: C.clay },
  okPill: { display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: 0.3, padding: "2px 7px", borderRadius: 10, background: C.sageBg, color: "#5a6e50" },
  extraCard: { background: C.panel2, border: `1px solid ${C.rule2}`, borderRadius: 8, padding: "14px 16px", marginBottom: 12 },
  extraHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 },
  extraKind: { fontSize: 14, fontWeight: 700, textTransform: "capitalize" },
  extraMetres: { display: "flex", alignItems: "baseline", gap: 4 },
  extraInput: { width: 70, padding: "4px 6px", fontSize: 15, fontWeight: 700, borderRadius: 4, border: `1px solid ${C.rule}`, textAlign: "right" },
  extraNotes: { fontSize: 12, color: C.ink2, lineHeight: 1.5 },
  reviewRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: C.clay },
  checkbox: { width: 15, height: 15 },
  summaryBar: { display: "flex", gap: 24, background: C.sageBg, border: `1px solid ${C.sage}`, borderRadius: 10, padding: "16px 20px", marginBottom: 8 },
  summaryNum: { fontSize: 30, fontWeight: 600, color: C.ink, lineHeight: 1 },
  summaryLabel: { fontSize: 12, color: "#5a6e50", marginTop: 4 },

  // wizard
  trail: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 22 },
  crumb: (state) => ({
    fontSize: 12, letterSpacing: 0.6, textTransform: "uppercase", padding: "5px 4px",
    color: state === "active" ? C.ink : state === "done" ? C.sage : C.ink3,
    fontWeight: state === "active" ? 600 : 400,
  }),
  crumbSep: { color: C.rule, fontSize: 12 },
  backBtn: { fontFamily: "Inter, sans-serif", fontSize: 13, color: C.ink2, background: "none", border: "none", cursor: "pointer", padding: "4px 0", marginBottom: 12 },
  stepTitle: { fontSize: 22, fontWeight: 500, marginBottom: 16 },
  tapGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 },
  tap: { background: C.panel2, border: `1.5px solid ${C.rule}`, borderRadius: 10, padding: "18px 14px", minHeight: 76, cursor: "pointer", textAlign: "left", fontFamily: "Inter, sans-serif", color: C.ink, position: "relative" },
  tapName: { fontSize: 16, fontWeight: 600 },
  tapSub: { fontSize: 12, color: C.ink3, marginTop: 3 },
  liveDot: { position: "absolute", top: 12, right: 12, width: 9, height: 9, borderRadius: "50%", background: C.clay, boxShadow: `0 0 0 3px ${C.clayBg}` },
  pinWrap: { maxWidth: 300, margin: "0 auto" },
  pinTarget: { fontSize: 22, marginBottom: 16, textAlign: "center", fontWeight: 500 },
  pinDots: { display: "flex", gap: 14, marginBottom: 16, justifyContent: "center" },
  pinDot: (filled) => ({ width: 16, height: 16, borderRadius: "50%", border: `1.5px solid ${C.rule}`, background: filled ? C.ink : "transparent" }),
  pinError: { color: C.clay, fontSize: 13, fontWeight: 600, textAlign: "center", marginBottom: 16, minHeight: 18 },
  pinHint: { fontSize: 12, color: C.ink3, fontStyle: "italic", textAlign: "center", marginBottom: 16 },
  pinPad: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 },
  pinKey: { fontFamily: "Inter, sans-serif", fontSize: 20, fontWeight: 500, padding: "18px 0", borderRadius: 10, border: `1.5px solid ${C.rule}`, background: C.panel2, color: C.ink, cursor: "pointer" },
  pinKeyGhost: { fontSize: 12, color: C.ink3, background: "none" },
  cabTapLive: { fontSize: 11, color: C.clay, fontWeight: 600, marginTop: 8, display: "flex", alignItems: "center", gap: 5 },
  cabNum: { fontSize: 11, color: C.ink3, fontWeight: 600, letterSpacing: 0.3 },
  cabType: { fontSize: 14.5, fontWeight: 600, marginTop: 2 },
  groupLabel: { fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: C.ink3, margin: "16px 0 8px" },
  confirmCard: { maxWidth: 460, margin: "20px auto 0" },
  confirmSummary: { background: C.panel2, border: `1px solid ${C.rule2}`, borderRadius: 10, padding: "22px 20px", marginBottom: 22 },
  confirmRow: { display: "flex", justifyContent: "space-between", fontSize: 14, padding: "6px 0", borderBottom: `1px solid ${C.rule2}` },
  confirmK: { color: C.ink3 },
  confirmV: { fontWeight: 600 },
  startBtn: { width: "100%", fontFamily: "Inter, sans-serif", fontSize: 18, fontWeight: 600, padding: "18px 0", border: "none", borderRadius: 10, background: C.sage, color: "#fff", cursor: "pointer" },
  runningWrap: { maxWidth: 460, margin: "12px auto 0", textAlign: "center" },
  runningBadge: { display: "inline-flex", alignItems: "center", gap: 8, background: C.sageBg, color: "#5a6e50", fontSize: 11.5, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", padding: "6px 14px", borderRadius: 20, marginBottom: 18 },
  pulse: { width: 8, height: 8, borderRadius: "50%", background: C.sage },
  runningClock: { fontSize: 48, fontWeight: 500, fontVariantNumeric: "tabular-nums", marginBottom: 6 },
  runningWhat: { fontSize: 14.5, color: C.ink2, marginBottom: 20 },
  stopBtn: { width: "100%", fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: 600, padding: "16px 0", borderRadius: 10, border: `1.5px solid ${C.clay}`, background: "#fff", color: C.clay, cursor: "pointer" },
  partsBox: { textAlign: "left", background: "#fff", border: `1px solid ${C.rule2}`, borderRadius: 8, padding: "14px 16px", margin: "18px 0" },

  // live board
  liveTable: { width: "100%", borderCollapse: "collapse" },
  who: { display: "flex", alignItems: "center", gap: 10 },
  avatar: { width: 32, height: 32, borderRadius: "50%", background: C.sage, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 700, flex: "none" },
  liveStageTag: { fontSize: 11, letterSpacing: 0.4, color: C.ink2, background: C.panel2, border: `1px solid ${C.rule2}`, borderRadius: 4, padding: "3px 8px", display: "inline-block" },
  liveElapsed: { fontVariantNumeric: "tabular-nums", fontWeight: 600 },
  sameCabNote: { marginTop: 16, fontSize: 12.5, color: C.ink2, background: C.panel2, border: `1px dashed ${C.rule}`, borderRadius: 8, padding: "12px 16px", maxWidth: 640, lineHeight: 1.6 },
  emptyLive: { fontSize: 13, color: C.ink3, fontStyle: "italic" },
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

const WIZ_WHO = "who", WIZ_PIN = "pin", WIZ_ALREADY = "already", WIZ_STAGE = "stage",
  WIZ_CABINET = "cabinet", WIZ_CONFIRM = "confirm", WIZ_RUNNING = "running";

function trailSteps(needsCabinet) {
  return [
    { k: WIZ_STAGE, label: "Stage" },
    ...(needsCabinet ? [{ k: WIZ_CABINET, label: "Cabinet" }] : []),
    { k: WIZ_CONFIRM, label: "Go" },
  ];
}

function ClockWizard({ activeClocks, setActiveClocks, cabinets, manufactureLog, setManufactureLog }) {
  const [wiz, setWiz] = useState({ step: WIZ_WHO, person: null, pinEntry: "", pinError: false, stage: "", cabinetItem: "" });
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (wiz.step !== WIZ_RUNNING) return;
    const t = setInterval(() => forceTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [wiz.step]);

  // A cabinet with no confirmed type yet can't be clocked against — nothing
  // on the floor board ever types a cabinet, so an unreviewed one simply
  // isn't offered until the office has matched or created its type.
  const cabinetOptions = cabinets.filter(c => c.typeName !== "Panel" && !c.needsReview);
  const stageDef = SAMPLE_STAGES.find(s => s.name === wiz.stage);
  const needsCabinet = !!(stageDef && stageDef.isCabinetStage);

  const setActive = (updater) => {
    const next = typeof updater === "function" ? updater(activeClocks) : updater;
    setActiveClocks(next); save("activeClocks", next);
  };

  const resetWiz = () => setWiz({ step: WIZ_WHO, person: null, pinEntry: "", pinError: false, stage: "", cabinetItem: "" });

  const pickPerson = (name) => setWiz({ step: WIZ_PIN, person: name, pinEntry: "", pinError: false, stage: "", cabinetItem: "" });

  const pinDigit = (d) => {
    if (wiz.pinEntry.length >= 4) return;
    const entry = wiz.pinEntry + d;
    if (entry.length < 4) { setWiz({ ...wiz, pinEntry: entry }); return; }
    const person = SAMPLE_WORKSHOP_PEOPLE.find(p => p.name === wiz.person);
    if (person.pin === entry) {
      setWiz({ ...wiz, pinEntry: entry, step: activeClocks[wiz.person] ? WIZ_ALREADY : WIZ_STAGE });
    } else {
      setWiz({ ...wiz, pinEntry: entry, pinError: true });
      setTimeout(() => setWiz(w => ({ ...w, pinEntry: "", pinError: false })), 650);
    }
  };

  // Frame/Door manufacture ask "how many did you complete" on stop —
  // confirmed against real Clockify history that this is genuinely batch
  // work, never against one cabinet, so there's nothing to tap along the
  // way like a cabinet stage — just a count once the session's over.
  const stop = (person) => {
    const running = activeClocks[person];
    const runningStageDef = SAMPLE_STAGES.find(s => s.name === running?.stage);
    if (runningStageDef?.tracksQuantity) {
      const raw = window.prompt(`How many did you complete this session (${running.stage})?`, "0");
      if (raw === null) return; // cancelled — keep the clock running
      const qty = Math.max(0, parseInt(raw, 10) || 0);
      const entry = { person, stage: running.stage, quantity: qty, completedAt: Date.now() };
      const nextLog = [entry, ...manufactureLog];
      setManufactureLog(nextLog); save("manufactureLog", nextLog);
    }
    setActive(prev => { const next = { ...prev }; delete next[person]; return next; });
    resetWiz();
  };

  const goRunning = () => {
    setActive(prev => ({ ...prev, [wiz.person]: { stage: wiz.stage, cabinetItem: needsCabinet ? wiz.cabinetItem : null, startedAt: Date.now() } }));
    setWiz({ ...wiz, step: WIZ_RUNNING });
  };

  // ---- who ----
  if (wiz.step === WIZ_WHO) {
    return (
      <div>
        <div style={{ ...styles.stepTitle, ...styles.serif }}>Who's clocking on?</div>
        <div style={styles.tapGrid}>
          {SAMPLE_WORKSHOP_PEOPLE.map(p => (
            <button key={p.name} style={styles.tap} onClick={() => pickPerson(p.name)}>
              {activeClocks[p.name] && <span style={styles.liveDot} />}
              <div style={styles.tapName}>{p.name}</div>
              {activeClocks[p.name] && <div style={styles.tapSub}>Already clocked on</div>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---- pin ----
  if (wiz.step === WIZ_PIN) {
    const person = SAMPLE_WORKSHOP_PEOPLE.find(p => p.name === wiz.person);
    return (
      <div style={styles.pinWrap}>
        <div style={{ ...styles.pinTarget, ...styles.serif }}>{person.name}'s PIN</div>
        <div style={styles.pinDots}>{[0, 1, 2, 3].map(i => <div key={i} style={styles.pinDot(i < wiz.pinEntry.length)} />)}</div>
        {wiz.pinError
          ? <div style={styles.pinError}>Wrong PIN — try again</div>
          : <div style={styles.pinHint}>Demo PIN: {person.pin}</div>}
        <div style={styles.pinPad}>
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => (
            <button key={d} style={styles.pinKey} onClick={() => pinDigit(d)}>{d}</button>
          ))}
          <button style={{ ...styles.pinKey, ...styles.pinKeyGhost }} onClick={resetWiz}>Not {person.name}</button>
          <button style={styles.pinKey} onClick={() => pinDigit("0")}>0</button>
          <button style={{ ...styles.pinKey, ...styles.pinKeyGhost }} onClick={() => setWiz({ ...wiz, pinEntry: wiz.pinEntry.slice(0, -1) })}>⌫</button>
        </div>
      </div>
    );
  }

  // ---- already running ----
  if (wiz.step === WIZ_ALREADY) {
    const running = activeClocks[wiz.person];
    const cab = running.cabinetItem ? cabinetOptions.find(c => c.item === running.cabinetItem) : null;
    return (
      <div>
        <div style={{ ...styles.stepTitle, ...styles.serif }}>{wiz.person} is already clocked on</div>
        <div style={styles.confirmCard}>
          <div style={styles.confirmSummary}>
            <div style={styles.confirmRow}><span style={styles.confirmK}>Stage</span><span style={styles.confirmV}>{running.stage}</span></div>
            {cab && <div style={styles.confirmRow}><span style={styles.confirmK}>Cabinet</span><span style={styles.confirmV}>#{cab.item} {cab.description}</span></div>}
            <div style={styles.confirmRow}><span style={styles.confirmK}>Running</span><span style={styles.confirmV}>{fmtElapsed(Date.now() - running.startedAt)}</span></div>
          </div>
          <button style={styles.stopBtn} onClick={() => stop(wiz.person)}>Stop</button>
        </div>
        <div style={{ textAlign: "center", marginTop: 10 }}>
          <button style={styles.backBtn} onClick={resetWiz}>← Not {wiz.person}</button>
        </div>
      </div>
    );
  }

  const trail = trailSteps(needsCabinet);
  const activeIdx = trail.findIndex(t => t.k === wiz.step);

  const Trail = () => (
    <div style={styles.trail}>
      {trail.map((t, i) => (
        <React.Fragment key={t.k}>
          <span style={styles.crumb(i === activeIdx ? "active" : i < activeIdx ? "done" : "todo")}>{t.label}</span>
          {i < trail.length - 1 && <span style={styles.crumbSep}>›</span>}
        </React.Fragment>
      ))}
    </div>
  );

  // ---- stage ----
  if (wiz.step === WIZ_STAGE) {
    return (
      <div>
        <Trail />
        <button style={styles.backBtn} onClick={resetWiz}>← Back</button>
        <div style={{ ...styles.stepTitle, ...styles.serif }}>What are you doing, {wiz.person}?</div>
        <div style={{ fontSize: 13, color: C.ink2, marginBottom: 16 }}>Job: {SAMPLE_JOB.da_number} {SAMPLE_JOB.client_name} — {SAMPLE_ROOM} (only job in this preview)</div>
        <select
          style={{ ...styles.select, maxWidth: 420, padding: "14px 16px", fontSize: 15, borderRadius: 10 }}
          value={wiz.stage}
          onChange={(e) => setWiz({ ...wiz, stage: e.target.value, cabinetItem: "" })}
        >
          <option value="">Choose a stage…</option>
          {SAMPLE_STAGES.map(s => <option key={s.name} value={s.name}>{s.name}{s.isCabinetStage ? " (picks a cabinet next)" : ""}</option>)}
        </select>
        <div style={{ marginTop: 16 }}>
          <button
            style={{ ...styles.startBtn, maxWidth: 420, opacity: wiz.stage ? 1 : 0.4, cursor: wiz.stage ? "pointer" : "not-allowed" }}
            disabled={!wiz.stage}
            onClick={() => setWiz({ ...wiz, step: needsCabinet ? WIZ_CABINET : WIZ_CONFIRM })}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  // ---- cabinet ----
  if (wiz.step === WIZ_CABINET) {
    const inProgress = cabinetOptions.filter(c =>
      Object.entries(activeClocks).some(([p, r]) => p !== wiz.person && r.stage === wiz.stage && r.cabinetItem === c.item)
    );
    const rest = cabinetOptions.filter(c => !inProgress.includes(c));
    const cabTap = (c) => {
      const whoElse = Object.entries(activeClocks).filter(([p, r]) => p !== wiz.person && r.stage === wiz.stage && r.cabinetItem === c.item).map(([p]) => p);
      return (
        <button key={c.item} style={styles.tap} onClick={() => setWiz({ ...wiz, cabinetItem: c.item, step: WIZ_CONFIRM })}>
          <div style={styles.cabNum}>#{c.item}</div>
          <div style={styles.cabType}>{c.description}</div>
          {whoElse.length > 0 && <div style={styles.cabTapLive}><span style={{ width: 6, height: 6, borderRadius: "50%", background: C.clay }} />{whoElse.join(" & ")} on it</div>}
        </button>
      );
    };
    return (
      <div>
        <Trail />
        <button style={styles.backBtn} onClick={() => setWiz({ ...wiz, step: WIZ_STAGE })}>← Back</button>
        <div style={{ ...styles.stepTitle, ...styles.serif }}>Which cabinet?</div>
        {inProgress.length > 0 && <>
          <div style={styles.groupLabel}>In progress</div>
          <div style={styles.tapGrid}>{inProgress.map(cabTap)}</div>
        </>}
        <div style={styles.groupLabel}>{SAMPLE_ROOM}</div>
        <div style={styles.tapGrid}>{rest.map(cabTap)}</div>
      </div>
    );
  }

  // ---- confirm ----
  if (wiz.step === WIZ_CONFIRM) {
    const cab = wiz.cabinetItem ? cabinetOptions.find(c => c.item === wiz.cabinetItem) : null;
    return (
      <div>
        <Trail />
        <button style={styles.backBtn} onClick={() => setWiz({ ...wiz, step: needsCabinet ? WIZ_CABINET : WIZ_STAGE })}>← Back</button>
        <div style={{ ...styles.stepTitle, ...styles.serif }}>Ready to start</div>
        <div style={styles.confirmCard}>
          <div style={styles.confirmSummary}>
            <div style={styles.confirmRow}><span style={styles.confirmK}>Who</span><span style={styles.confirmV}>{wiz.person}</span></div>
            <div style={styles.confirmRow}><span style={styles.confirmK}>Job</span><span style={styles.confirmV}>{SAMPLE_JOB.da_number} — {SAMPLE_JOB.client_name}</span></div>
            <div style={styles.confirmRow}><span style={styles.confirmK}>Stage</span><span style={styles.confirmV}>{wiz.stage}</span></div>
            {cab && <div style={styles.confirmRow}><span style={styles.confirmK}>Cabinet</span><span style={styles.confirmV}>#{cab.item} {cab.description}</span></div>}
          </div>
          <button style={styles.startBtn} onClick={goRunning}>Start</button>
        </div>
      </div>
    );
  }

  // ---- running ----
  const running = activeClocks[wiz.person];
  if (!running) { resetWiz(); return null; }
  const cab = running.cabinetItem ? cabinetOptions.find(c => c.item === running.cabinetItem) : null;
  const runningStageDef = SAMPLE_STAGES.find(s => s.name === running.stage);
  return (
    <div style={styles.runningWrap}>
      <span style={styles.runningBadge}><span style={styles.pulse} />Running</span>
      <div style={styles.runningClock}>{fmtElapsed(Date.now() - running.startedAt)}</div>
      <div style={styles.runningWhat}>{wiz.person} · {SAMPLE_JOB.da_number} · {running.stage}{cab ? ` · #${cab.item}` : ""}</div>

      {runningStageDef?.tracksQuantity && (
        <div style={styles.partsBox}>
          You'll be asked how many you completed when you stop — that count is what lets the floor board work
          out how many cabinets' worth of {running.stage.toLowerCase()} are ready today.
        </div>
      )}

      <button style={styles.stopBtn} onClick={() => stop(wiz.person)}>Stop</button>
    </div>
  );
}

function isToday(ts) {
  const d = new Date(ts), now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function LiveBoardTab({ activeClocks, cabinets, manufactureLog }) {
  const entries = Object.entries(activeClocks);
  // A cabinet with no confirmed type yet can't be clocked against — nothing
  // on the floor board ever types a cabinet, so an unreviewed one simply
  // isn't offered until the office has matched or created its type.
  const cabinetOptions = cabinets.filter(c => c.typeName !== "Panel" && !c.needsReview);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (entries.length === 0) return;
    const t = setInterval(() => forceTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [entries.length]);

  // Flag any stage+cabinet combo two or more people are on at once.
  const shared = entries.filter(([p, r]) => r.cabinetItem && entries.some(([p2, r2]) => p2 !== p && r2.stage === r.stage && r2.cabinetItem === r.cabinetItem));

  const todaysLog = manufactureLog.filter(e => isToday(e.completedAt));
  const framesToday = todaysLog.filter(e => e.stage === "Frame manufacture").reduce((a, e) => a + e.quantity, 0);
  const doorsToday = todaysLog.filter(e => e.stage === "Door manufacture").reduce((a, e) => a + e.quantity, 0);
  const cabinetsReady = Math.min(framesToday, doorsToday);

  return (
    <div>
      <div style={styles.sectionTitle}>Frame &amp; Door progress today</div>
      <div style={styles.summaryBar}>
        <div>
          <div style={styles.summaryNum}>{framesToday}</div>
          <div style={styles.summaryLabel}>frames completed</div>
        </div>
        <div>
          <div style={styles.summaryNum}>{doorsToday}</div>
          <div style={styles.summaryLabel}>doors completed</div>
        </div>
        <div>
          <div style={styles.summaryNum}>{cabinetsReady}</div>
          <div style={styles.summaryLabel}>cabinets' worth ready for bench</div>
        </div>
      </div>
      <div style={styles.note}>
        A cabinet needs both a frame and a door, so it's the smaller of the two totals that's genuinely ready —
        {framesToday !== doorsToday && framesToday + doorsToday > 0
          ? ` today ${framesToday > doorsToday ? "frames are" : "doors are"} ahead.`
          : ""}
      </div>

      <div style={styles.sectionTitle}>Running now</div>
      {entries.length === 0 ? (
        <div style={styles.emptyLive}>Nobody's clocked on right now — try the Clock on/off tab.</div>
      ) : (
        <table style={styles.liveTable}>
          <thead><tr><th style={styles.th}>Who</th><th style={styles.th}>Job</th><th style={styles.th}>Stage</th><th style={styles.th}>Cabinet</th><th style={styles.th}>Elapsed</th></tr></thead>
          <tbody>
            {entries.map(([person, r]) => {
              const cab = r.cabinetItem ? cabinetOptions.find(c => c.item === r.cabinetItem) : null;
              return (
                <tr key={person}>
                  <td style={styles.td}><div style={styles.who}><span style={styles.avatar}>{initials(person)}</span>{person}</div></td>
                  <td style={styles.td}>{SAMPLE_JOB.da_number}</td>
                  <td style={styles.td}><span style={styles.liveStageTag}>{r.stage}</span></td>
                  <td style={{ ...styles.td, color: C.ink3, fontSize: 12.5 }}>{cab ? `#${cab.item} ${cab.description}` : "—"}</td>
                  <td style={{ ...styles.td, ...styles.liveElapsed }}>{fmtElapsed(Date.now() - r.startedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {shared.length > 0 && (
        <div style={styles.sameCabNote}>
          {shared.map(([p]) => p).join(" and ")} {shared.length === 2 ? "are" : "are"} both running against the same
          cabinet right now — two people on one cabinet is normal and expected. Total time logged against a cabinet is
          labour minutes (everyone's time added up), not wall-clock time.
        </div>
      )}
    </div>
  );
}

export default function TimeTrackerPreview() {
  const [tab, setTab] = useState("import");
  const [cabinets, setCabinets] = useState(() => load("cabinets", null) || initialCabinets());
  const [extras, setExtras] = useState(() => load("extras", null) || initialExtras());
  const [accessories, setAccessories] = useState(() => load("accessories", null) || initialAccessories());
  const [activeClocks, setActiveClocks] = useState(() => load("activeClocks", null) || {});
  const [manufactureLog, setManufactureLog] = useState(() => load("manufactureLog", null) || []);

  const resetDemo = () => {
    if (!window.confirm("Reset this preview back to the original Anna Reid sample data? This also clears who's clocked on and today's manufacture counts.")) return;
    const c = initialCabinets(), e = initialExtras(), a = initialAccessories();
    setCabinets(c); save("cabinets", c);
    setExtras(e); save("extras", e);
    setAccessories(a); save("accessories", a);
    setActiveClocks({}); save("activeClocks", {});
    setManufactureLog([]); save("manufactureLog", []);
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.banner}>
        <strong>Preview, not live.</strong> The real database tables for this (cabinets, room_extras,
        cabinet_accessories, time_entries) have never been run against Supabase yet —
        everything here saves to this browser only, seeded from a real job (DA1277 Anna Reid). PINs are made
        up for this preview (see the code comment). Nothing you do on this page touches the main schedule or
        floor board. <a href="#" onClick={(e) => { e.preventDefault(); resetDemo(); }}>Reset to sample data</a>
      </div>
      <div style={{ ...styles.title, ...styles.serif }}>Time tracker — try it out</div>
      <div style={styles.subtitle}>One combined tool: import review, the clock on/off wizard, and who's on now.</div>

      <div style={styles.tabs}>
        <button style={styles.tab(tab === "import")} onClick={() => setTab("import")}>Import review</button>
        <button style={styles.tab(tab === "clock")} onClick={() => setTab("clock")}>Clock on/off</button>
        <button style={styles.tab(tab === "live")} onClick={() => setTab("live")}>Who's on now</button>
      </div>

      <div style={styles.card}>
        {tab === "import" && (
          <ImportReviewTab cabinets={cabinets} setCabinets={setCabinets} extras={extras} setExtras={setExtras} accessories={accessories} setAccessories={setAccessories} />
        )}
        {tab === "clock" && (
          <ClockWizard activeClocks={activeClocks} setActiveClocks={setActiveClocks} cabinets={cabinets} manufactureLog={manufactureLog} setManufactureLog={setManufactureLog} />
        )}
        {tab === "live" && (
          <LiveBoardTab activeClocks={activeClocks} cabinets={cabinets} manufactureLog={manufactureLog} />
        )}
      </div>
    </div>
  );
}
