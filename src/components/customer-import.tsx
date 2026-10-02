"use client";
// Bringing in an email list (scheduling-messaging-design.md 11.3): paste cells or open a CSV, the columns are matched by
// their headers (name / email / phone / unsubscribed), the first rows are shown, then "Import".
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { parseTable } from "@/lib/parse-table";
import { importCustomers, type ImportResult, type ImportRow } from "@/actions/customer-import";

type Col = keyof ImportRow;
const COLS: { key: Col; label: string; words: RegExp }[] = [
  { key: "name", label: "Name", words: /^(name|full ?name|customer|contact|first ?name|display ?name)$/i },
  { key: "email", label: "Email", words: /e-?mail/i },
  { key: "phone", label: "Phone", words: /(phone|mobile|cell|tel)/i },
  { key: "unsubscribed", label: "Unsubscribed", words: /(unsub|opt.?out|do ?not ?(e-?mail|contact))/i },
];
const SHOWN = 20;

/** A chosen file's text (Excel's plain CSV is Windows-1252, its "Unicode Text" UTF-16; only UTF-8 reads as UTF-8). */
async function readText(f: File) {
  const buf = await f.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export function CustomerImport() {
  const [text, setText] = useState("");
  const [picks, setPicks] = useState<Partial<Record<Col, number>>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const table = useMemo(() => parseTable(text), [text]);
  const header = useMemo(() => table[0] ?? [], [table]);
  // Headers matched by their words; a sheet without a header row is taken as name, email, phone in that order.
  const hasHeader = header.some((h) => COLS.some((c) => c.words.test(h.trim())));
  const auto = useMemo(() => {
    const m: Partial<Record<Col, number>> = {};
    if (hasHeader) header.forEach((h, i) => COLS.forEach((c) => m[c.key] === undefined && c.words.test(h.trim()) && (m[c.key] = i)));
    else if (header.length) Object.assign(m, { name: 0, email: 1, phone: 2 });
    return m;
  }, [header, hasHeader]);
  const map = { ...auto, ...picks };
  const body = hasHeader ? table.slice(1) : table;
  const rows: ImportRow[] = body
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => {
      const at = (k: Col) => (map[k] === undefined ? undefined : r[map[k]!]?.trim());
      return { name: at("name"), email: at("email"), phone: at("phone"), unsubscribed: at("unsubscribed") };
    });

  async function run() {
    if (!rows.length) return toast.error("Paste or open a list first.");
    if (map.name === undefined || (map.email === undefined && map.phone === undefined)) return toast.error("Say which column is the name, and which is the email or phone.");
    setBusy(true);
    try {
      const r = await importCustomers(rows.slice(0, 5000));
      if ("error" in r) toast.error(r.error);
      else {
        setResult(r);
        toast.success(`Imported: ${r.added} added, ${r.matched} already here`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <p className="muted">Only bring in people who bought from you or asked to hear from you. Texts need their own signed consent; importing never gives it.</p>
      <div className="field">
        <label htmlFor="imp-text" className="label">
          Paste the cells (name, email, phone, unsubscribed) or open a file
        </label>
        <textarea id="imp-text" rows={8} className="input mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={"Name\tEmail\tPhone\tUnsubscribed\nMary Smith\tmary@example.com\t(555) 123-4567\t\n"} />
        <input
          type="file"
          accept=".csv,.txt,.tsv,text/csv,text/plain"
          className="mt-2"
          aria-label="Open a CSV file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setText(await readText(f));
          }}
        />
      </div>

      {header.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3">
            {COLS.map((c) => (
              <label key={c.key} className="flex items-center gap-2">
                <span>{c.label}</span>
                <select className="select" value={map[c.key] ?? ""} onChange={(e) => setPicks({ ...picks, [c.key]: e.target.value === "" ? undefined : Number(e.target.value) })} aria-label={`Column for ${c.label}`}>
                  <option value="">(none)</option>
                  {header.map((h, i) => (
                    <option key={i} value={i}>
                      {hasHeader ? h || `Column ${i + 1}` : `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Unsubscribed</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, SHOWN).map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td>{r.email}</td>
                    <td>{r.phone}</td>
                    <td>{r.unsubscribed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted text-xs">
            {rows.length} row{rows.length === 1 ? "" : "s"}
            {rows.length > SHOWN ? ` (the first ${SHOWN} shown)` : ""}
            {rows.length > 5000 ? "; at most 5000 go in at a time" : ""}.
          </p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={run}>
            {busy ? "Importing..." : "Import"}
          </button>
        </div>
      )}

      {result && (
        <div className="card card-pad space-y-1" role="status">
          <div>
            <strong>{result.added}</strong> added, <strong>{result.matched}</strong> matched customers you already had, <strong>{result.unsubscribed}</strong> marked unsubscribed.
          </div>
          {result.problems.length > 0 && (
            <ul className="muted text-xs">
              {result.problems.slice(0, 50).map((p) => (
                <li key={p}>{p}</li>
              ))}
              {result.problems.length > 50 && <li>and {result.problems.length - 50} more</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
