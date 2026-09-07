import React, { useState, useEffect } from "react";
import { supabase } from "../storage.js";

// Small admin screen for mapping Clockify name variants onto a single
// person row, so imported history pools correctly with live entries
// after a rename. Reached with ?admin=aliases on the same URL, same
// pattern as ?board=1.

const styles = {
  wrap: { fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "40px auto", padding: "0 20px" },
  title: { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  subtitle: { color: "#666", marginBottom: 24, fontSize: 14 },
  row: { display: "flex", gap: 8, marginBottom: 12 },
  select: { flex: 1, padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #ccc" },
  input: { flex: 1, padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #ccc" },
  button: { padding: "8px 16px", fontSize: 14, borderRadius: 6, border: "none", background: "#2c5f4f", color: "#fff", cursor: "pointer" },
  error: { color: "#b3261e", fontSize: 13, marginBottom: 12 },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 24 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #ddd", fontSize: 13, color: "#666" },
  td: { padding: "8px 10px", borderBottom: "1px solid #eee", fontSize: 14 },
  removeBtn: { background: "none", border: "none", color: "#b3261e", cursor: "pointer", fontSize: 13 },
};

export default function PersonAliasAdmin() {
  const [people, setPeople] = useState([]);
  const [aliases, setAliases] = useState([]);
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [aliasText, setAliasText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    const [peopleRes, aliasesRes] = await Promise.all([
      supabase.from("people").select("id, name, role, active").order("name"),
      supabase.from("person_aliases").select("id, alias, person_id").order("alias"),
    ]);
    if (peopleRes.error) setError(peopleRes.error.message);
    else if (aliasesRes.error) setError(aliasesRes.error.message);
    setPeople(peopleRes.data || []);
    setAliases(aliasesRes.data || []);
    setLoading(false);
  }

  useEffect(() => { reload(); }, []);

  const addAlias = async () => {
    setError("");
    const alias = aliasText.trim();
    if (!alias || !selectedPersonId) return;
    const { error: insertError } = await supabase
      .from("person_aliases")
      .insert({ person_id: selectedPersonId, alias });
    if (insertError) { setError(insertError.message); return; }
    setAliasText("");
    reload();
  };

  const removeAlias = async (id) => {
    setError("");
    const { error: deleteError } = await supabase.from("person_aliases").delete().eq("id", id);
    if (deleteError) { setError(deleteError.message); return; }
    reload();
  };

  const peopleById = Object.fromEntries(people.map(p => [p.id, p]));

  if (loading) return <div style={styles.wrap}>Loading…</div>;

  return (
    <div style={styles.wrap}>
      <div style={styles.title}>Name aliases</div>
      <div style={styles.subtitle}>
        Map every name variant that has appeared in a Clockify export onto one person, so imported
        history pools correctly with live entries after a rename.
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.row}>
        <select
          style={styles.select}
          value={selectedPersonId}
          onChange={(e) => setSelectedPersonId(e.target.value)}
        >
          <option value="">Person…</option>
          {people.map(p => (
            <option key={p.id} value={p.id}>{p.name}{p.active ? "" : " (inactive)"}</option>
          ))}
        </select>
        <input
          style={styles.input}
          placeholder="Alias, e.g. a Clockify name variant"
          value={aliasText}
          onChange={(e) => setAliasText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addAlias(); }}
        />
        <button style={styles.button} onClick={addAlias}>Add</button>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Alias</th>
            <th style={styles.th}>Person</th>
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {aliases.map(a => (
            <tr key={a.id}>
              <td style={styles.td}>{a.alias}</td>
              <td style={styles.td}>{peopleById[a.person_id]?.name || "—"}</td>
              <td style={styles.td}>
                <button style={styles.removeBtn} onClick={() => removeAlias(a.id)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
