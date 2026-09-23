import React, { useState, useEffect } from "react";
import {
  SAMPLE_JOB, SAMPLE_ROOM, SAMPLE_CABINET_TYPES, SAMPLE_CABINETS,
  SAMPLE_EXCLUDED_COUNT, SAMPLE_ROOM_EXTRAS, SAMPLE_ACCESSORIES, SAMPLE_WORKSHOP_PEOPLE,
  SAMPLE_STAGES,
} from "./sampleData.js";

// Local-only try-it-out preview for Phase 2 (import review) and Phase 3
// (clock on/off, PIN sign-in included) — reached with ?admin=preview, same
// pattern as ?admin=aliases. One combined tool, not separate screens: the
// office does the import review here, and the same page also has the real
// clock in/out flow, exactly how this is meant to work for real, not two
// disconnected admin pages. Nothing here touches Supabase: the real tables
// (production_imports, cabinets, room_extras, cabinet_accessories,
// stage_completions, time_entries, stage_completions) have never been
// executed against the live database, so this runs entirely on
// localStorage under the "tt-preview:" prefix, seeded from a real job
// (DA1277 Anna Reid) the first time it's opened. PINs here are made up for
// this preview only (see SAMPLE_WORKSHOP_PEOPLE) — real people don't have
// one until it's set via ?admin=aliases. See docs/time-tracker.md and the
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

  // Clock in/out
  signedInBar: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#ecf0e2", border: "1px solid #7a8b6f", borderRadius: 8, padding: "10px 16px", marginBottom: 20 },
  signedInName: { fontSize: 15, fontWeight: 700, color: "#3a342c" },
  signOutBtn: { background: "none", border: "1px solid #a5614f", color: "#a5614f", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer" },
  nameGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 10, maxWidth: 560 },
  nameBtn: { padding: "16px 8px", fontSize: 15, fontWeight: 600, borderRadius: 8, border: "1px solid #ccc", background: "#fff", cursor: "pointer" },
  pinWrap: { maxWidth: 280 },
  pinTarget: { fontSize: 15, marginBottom: 12 },
  pinDots: { display: "flex", gap: 12, marginBottom: 16, justifyContent: "center" },
  pinDot: (filled) => ({ width: 16, height: 16, borderRadius: "50%", border: "1px solid #999", background: filled ? "#2c5f4f" : "#fff" }),
  pinError: { color: "#a5614f", fontSize: 13, textAlign: "center", marginBottom: 10, minHeight: 18 },
  pinPad: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 },
  pinKey: { padding: "16px 0", fontSize: 18, fontWeight: 600, borderRadius: 8, border: "1px solid #ccc", background: "#fff", cursor: "pointer" },
  pinCancel: { marginTop: 14, background: "none", border: "none", color: "#888", fontSize: 13, cursor: "pointer", textDecoration: "underline" },
  jobLine: { fontSize: 13, color: "#666", marginBottom: 16 },
  stageGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, marginBottom: 16 },
  stageBtn: (active) => ({
    padding: "12px 10px", fontSize: 13, fontWeight: 600, borderRadius: 8, cursor: "pointer", textAlign: "left",
    border: active ? "2px solid #2c5f4f" : "1px solid #ccc", background: active ? "#ecf0e2" : "#fff", color: "#333",
  }),
  clockOnBtn: { padding: "12px 28px", fontSize: 15, fontWeight: 700, borderRadius: 8, border: "none", background: "#2c5f4f", color: "#fff", cursor: "pointer" },
  clockOnBtnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  runningCard: { background: "#faf6ec", border: "1px solid #e8c468", borderRadius: 10, padding: "18px 20px", marginBottom: 20 },
  runningStage: { fontSize: 17, fontWeight: 700, marginBottom: 4 },
  runningTime: { fontSize: 32, fontWeight: 700, color: "#2c5f4f", margin: "8px 0" },
  clockOffBtn: { padding: "10px 24px", fontSize: 14, fontWeight: 700, borderRadius: 8, border: "none", background: "#a5614f", color: "#fff", cursor: "pointer" },
  logRow: { display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #eee", fontSize: 13 },
  logEmpty: { fontSize: 13, color: "#999", fontStyle: "italic" },
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

function fmtElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// PIN sign-in — tap a name, enter the 4-digit PIN, matches against
// SAMPLE_WORKSHOP_PEOPLE. Real PINs (people.pin) are set via ?admin=aliases;
// these are made-up demo ones, see sampleData.js.
function SignInScreen({ onSignedIn }) {
  const [target, setTarget] = useState(null); // name currently entering a PIN
  const [digits, setDigits] = useState("");
  const [error, setError] = useState("");

  if (!target) {
    return (
      <div>
        <div style={{ fontSize: 14, color: "#555", marginBottom: 14 }}>Tap your name to clock on</div>
        <div style={styles.nameGrid}>
          {SAMPLE_WORKSHOP_PEOPLE.map(p => (
            <button key={p.name} style={styles.nameBtn} onClick={() => { setTarget(p.name); setDigits(""); setError(""); }}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const press = (d) => {
    if (digits.length >= 4) return;
    const next = digits + d;
    setDigits(next);
    if (next.length === 4) {
      const person = SAMPLE_WORKSHOP_PEOPLE.find(p => p.name === target);
      if (person.pin === next) {
        onSignedIn(target);
      } else {
        setError("Wrong PIN — try again");
        setDigits("");
      }
    }
  };

  return (
    <div style={styles.pinWrap}>
      <div style={styles.pinTarget}>PIN for <strong>{target}</strong></div>
      <div style={styles.pinDots}>
        {[0, 1, 2, 3].map(i => <div key={i} style={styles.pinDot(i < digits.length)} />)}
      </div>
      <div style={styles.pinError}>{error}</div>
      <div style={styles.pinPad}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => (
          <button key={d} style={styles.pinKey} onClick={() => press(d)}>{d}</button>
        ))}
        <button style={styles.pinKey} onClick={() => setDigits(digits.slice(0, -1))}>⌫</button>
        <button style={styles.pinKey} onClick={() => press("0")}>0</button>
        <div />
      </div>
      <button style={styles.pinCancel} onClick={() => setTarget(null)}>Not {target}? Back</button>
    </div>
  );
}

function ClockInTab({
  signedInPerson, setSignedInPerson,
  activeClock, setActiveClock,
  timeLog, setTimeLog,
  cabinets, completions, setCompletions,
}) {
  const [draftStage, setDraftStage] = useState(SAMPLE_STAGES[0].name);
  const [draftCabinet, setDraftCabinet] = useState("");
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!activeClock) return;
    const t = setInterval(() => forceTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [activeClock]);

  const signOut = () => {
    setSignedInPerson(null); save("signedInPerson", null);
  };

  const cabinetOptions = cabinets.filter(c => c.typeName !== "Panel");
  const draftStageDef = SAMPLE_STAGES.find(s => s.name === draftStage);

  const clockOn = () => {
    if (draftStageDef.isCabinetStage && !draftCabinet) return;
    const next = { person: signedInPerson, stage: draftStage, cabinetItem: draftStageDef.isCabinetStage ? draftCabinet : null, startedAt: Date.now() };
    setActiveClock(next); save("activeClock", next);
  };

  const clockOff = () => {
    const minutes = Math.round((Date.now() - activeClock.startedAt) / 60000);
    const entry = { ...activeClock, stoppedAt: Date.now(), minutes };
    const nextLog = [entry, ...timeLog];
    setTimeLog(nextLog); save("timeLog", nextLog);
    setActiveClock(null); save("activeClock", null);
  };

  const toggle = (item, part) => {
    const cur = completions[item] || { frame: false, door: false };
    const next = { ...completions, [item]: { ...cur, [part]: !cur[part] } };
    setCompletions(next); save("completions", next);
  };
  const fractionFor = (item) => {
    const c = completions[item] || { frame: false, door: false };
    return (c.frame ? 0.5 : 0) + (c.door ? 0.5 : 0);
  };

  if (!signedInPerson) {
    return <SignInScreen onSignedIn={(name) => { setSignedInPerson(name); save("signedInPerson", name); }} />;
  }

  const cabinetForActive = activeClock?.cabinetItem
    ? cabinetOptions.find(c => c.item === activeClock.cabinetItem)
    : null;
  const totalDone = cabinetOptions.reduce((a, c) => a + fractionFor(c.item), 0);

  return (
    <div>
      <div style={styles.signedInBar}>
        <div style={styles.signedInName}>Signed in as {signedInPerson}</div>
        <button style={styles.signOutBtn} onClick={signOut}>Sign out</button>
      </div>
      <div style={styles.jobLine}>Job: {SAMPLE_JOB.da_number} {SAMPLE_JOB.client_name} — {SAMPLE_ROOM} (only job in this preview)</div>

      {!activeClock ? (
        <div>
          <div style={{ fontSize: 13, color: "#555", marginBottom: 6 }}>Stage</div>
          <div style={styles.stageGrid}>
            {SAMPLE_STAGES.map(s => (
              <button key={s.name} style={styles.stageBtn(draftStage === s.name)}
                onClick={() => { setDraftStage(s.name); setDraftCabinet(""); }}>
                {s.name}
              </button>
            ))}
          </div>

          {draftStageDef.isCabinetStage && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: "#555", marginBottom: 6 }}>Cabinet</div>
              <select style={styles.select} value={draftCabinet} onChange={(e) => setDraftCabinet(e.target.value)}>
                <option value="">Pick a cabinet…</option>
                {cabinetOptions.map(c => <option key={c.item} value={c.item}>#{c.item} — {c.description}</option>)}
              </select>
            </div>
          )}

          <button
            style={{ ...styles.clockOnBtn, ...((draftStageDef.isCabinetStage && !draftCabinet) ? styles.clockOnBtnDisabled : {}) }}
            disabled={draftStageDef.isCabinetStage && !draftCabinet}
            onClick={clockOn}
          >
            Clock on
          </button>
        </div>
      ) : (
        <div style={styles.runningCard}>
          <div style={styles.runningStage}>
            {activeClock.stage}{cabinetForActive ? ` — #${cabinetForActive.item} ${cabinetForActive.description}` : ""}
          </div>
          <div style={styles.runningTime}>{fmtElapsed(Date.now() - activeClock.startedAt)}</div>

          {activeClock.stage === "Bench prep" && cabinetForActive && (
            <div style={{ margin: "14px 0" }}>
              <div style={{ fontSize: 12, color: "#7a6a55", marginBottom: 8 }}>
                Mark done as you go — frame and door each count half:
              </div>
              <button style={styles.partBtn((completions[cabinetForActive.item] || {}).frame)} onClick={() => toggle(cabinetForActive.item, "frame")}>Frame</button>
              {" "}
              <button style={styles.partBtn((completions[cabinetForActive.item] || {}).door)} onClick={() => toggle(cabinetForActive.item, "door")}>Door</button>
            </div>
          )}

          <button style={styles.clockOffBtn} onClick={clockOff}>Clock off</button>
        </div>
      )}

      <div style={styles.note}>
        Bench prep running total (across everyone, not just you): <strong>{totalDone.toFixed(1)}</strong> of{" "}
        {cabinetOptions.length} cabinets — this is exactly what the floor board's Bench prep target would read
        from <code>cabinet_stage_progress</code> once this is wired up for real.
      </div>

      <div style={styles.sectionTitle}>Today's clock log</div>
      {timeLog.length === 0 ? (
        <div style={styles.logEmpty}>Nothing clocked off yet.</div>
      ) : (
        timeLog.map((e, i) => (
          <div key={i} style={styles.logRow}>
            <span>{e.person} — {e.stage}{e.cabinetItem ? ` — #${e.cabinetItem}` : ""}</span>
            <span>{e.minutes}m</span>
          </div>
        ))
      )}
    </div>
  );
}

export default function TimeTrackerPreview() {
  const [tab, setTab] = useState("import");
  const [cabinets, setCabinets] = useState(() => load("cabinets", null) || initialCabinets());
  const [extras, setExtras] = useState(() => load("extras", null) || initialExtras());
  const [accessories, setAccessories] = useState(() => load("accessories", null) || initialAccessories());
  const [completions, setCompletions] = useState(() => load("completions", null) || {});
  const [signedInPerson, setSignedInPerson] = useState(() => load("signedInPerson", null));
  const [activeClock, setActiveClock] = useState(() => load("activeClock", null));
  const [timeLog, setTimeLog] = useState(() => load("timeLog", null) || []);

  const resetDemo = () => {
    if (!window.confirm("Reset this preview back to the original Anna Reid sample data? This also signs you out and clears the clock log.")) return;
    const c = initialCabinets(), e = initialExtras(), a = initialAccessories();
    setCabinets(c); save("cabinets", c);
    setExtras(e); save("extras", e);
    setAccessories(a); save("accessories", a);
    setCompletions({}); save("completions", {});
    setSignedInPerson(null); save("signedInPerson", null);
    setActiveClock(null); save("activeClock", null);
    setTimeLog([]); save("timeLog", []);
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.banner}>
        <strong>Preview, not live.</strong> The real database tables for this (cabinets, room_extras,
        cabinet_accessories, stage_completions, time_entries) have never been run against Supabase yet —
        everything here saves to this browser only, seeded from a real job (DA1277 Anna Reid). PINs are made
        up for this preview (see the code comment). Nothing you do on this page touches the main schedule or
        floor board. <a href="#" onClick={(e) => { e.preventDefault(); resetDemo(); }}>Reset to sample data</a>
      </div>
      <div style={styles.title}>Time tracker — try it out</div>
      <div style={styles.subtitle}>One combined tool: import review and the real clock on/off flow, both against real sample data.</div>

      <div style={styles.tabs}>
        <button style={styles.tab(tab === "import")} onClick={() => setTab("import")}>Import review</button>
        <button style={styles.tab(tab === "clock")} onClick={() => setTab("clock")}>Clock in/out</button>
      </div>

      {tab === "import"
        ? <ImportReviewTab cabinets={cabinets} setCabinets={setCabinets} extras={extras} setExtras={setExtras} accessories={accessories} setAccessories={setAccessories} />
        : <ClockInTab
            signedInPerson={signedInPerson} setSignedInPerson={setSignedInPerson}
            activeClock={activeClock} setActiveClock={setActiveClock}
            timeLog={timeLog} setTimeLog={setTimeLog}
            cabinets={cabinets} completions={completions} setCompletions={setCompletions}
          />}
    </div>
  );
}
