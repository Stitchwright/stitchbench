"use client";
// "Switching from another system" (shop-features-round-2-design.md 4.7): choose the system you're leaving and what's in
// the file, open the exported file, "See what will come in" (how many are new and already here, the first ten, the rows
// that can't be read), then "Bring them in". The steps to export from each system are shown under the choices.
import { useState } from "react";
import { toast } from "sonner";
import { bringSwitchIn, previewSwitchFile } from "@/actions/switch";
import { runAction } from "@/components/action-form";
import { HOW_TO_EXPORT, KINDS, SYSTEMS, detect, type Kind, type System } from "@/lib/switch/formats";
import { parseTable } from "@/lib/parse-table";
import type { SwitchPreview } from "@/lib/switch/import";

const ITEM_KINDS = [
  ["NOTION", "Notions"],
  ["FABRIC", "Fabric"],
  ["THREAD", "Thread"],
  ["PATTERN", "Patterns and books"],
  ["ACCESSORY", "Accessories"],
  ["SUPPLY", "Supplies"],
  ["PART", "Parts"],
] as const;

/** The text of a chosen file: UTF-8, else Excel's UTF-16 or Windows-1252. */
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

export function SwitchImport() {
  const [system, setSystem] = useState<System>("square");
  const [kind, setKind] = useState<Kind>("items");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<SwitchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [itemKind, setItemKind] = useState("NOTION");
  const [addQty, setAddQty] = useState(true);
  const [done, setDone] = useState<string | null>(null);

  const choose = (s: System, k: Kind) => {
    setSystem(s);
    setKind(k);
    setPreview(null);
    setDone(null);
  };

  return (
    <div className="space-y-5">
      <fieldset className="card card-pad space-y-3">
        <legend className="h2">1. Which system are you leaving?</legend>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(SYSTEMS) as System[]).map((s) => (
            <label key={s} className={`btn min-h-11 text-base ${system === s ? "btn-primary" : ""}`}>
              <input type="radio" name="system" value={s} checked={system === s} onChange={() => choose(s, kind)} className="sr-only" />
              From {SYSTEMS[s]}
            </label>
          ))}
        </div>
        <p className="label">What&apos;s in the file?</p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(KINDS) as Kind[]).map((k) => (
            <label key={k} className={`btn min-h-11 text-base ${kind === k ? "btn-primary" : ""}`}>
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => choose(system, k)} className="sr-only" />
              {KINDS[k]}
            </label>
          ))}
        </div>
        <div className="rounded border border-line p-3 text-base">
          <p className="font-semibold">
            How to export {KINDS[kind].toLowerCase()} from {SYSTEMS[system]}
          </p>
          <ol className="list-decimal space-y-1 pl-6">
            {HOW_TO_EXPORT[system][kind].map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </fieldset>

      <div className="card card-pad space-y-3">
        <h2 className="h2">2. Open the exported file</h2>
        <label className="btn min-h-11 text-base">
          Choose the file (CSV)
          <input
            type="file"
            accept=".csv,.txt,.tsv,text/csv"
            className="sr-only"
            aria-label="The exported file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const t = await readText(f);
              setText(t);
              setFileName(f.name);
              setPreview(null);
              setDone(null);
              // The file says which system and what it holds: switch to it when it's clear.
              const d = detect(parseTable(t.slice(0, 20000))[0] ?? []);
              if (d && (d.system !== system || d.kind !== kind)) {
                setSystem(d.system);
                setKind(d.kind);
                toast.info(`This looks like ${KINDS[d.kind].toLowerCase()} from ${SYSTEMS[d.system]}.`);
              }
            }}
          />
        </label>
        {fileName && <p className="text-base">Opened {fileName}.</p>}
        {kind === "items" && (
          <details>
            <summary className="link cursor-pointer text-base">More choices</summary>
            <div className="mt-3 flex flex-wrap items-end gap-4">
              <label className="field">
                <span className="label">What are these items, mostly?</span>
                <select className="select text-base" value={itemKind} onChange={(e) => setItemKind(e.target.value)}>
                  {ITEM_KINDS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-h-11 items-center gap-2 text-base">
                <input type="checkbox" className="h-5 w-5" checked={addQty} onChange={(e) => setAddQty(e.target.checked)} /> Put the quantities on the shelf
              </label>
            </div>
          </details>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            className="btn min-h-11 text-base"
            disabled={!text || busy}
            onClick={async () => {
              setBusy(true);
              const r = await previewSwitchFile(system, kind, text).catch(() => ({ error: "Couldn't read the file: check the connection and try again." }));
              setBusy(false);
              if ("error" in r) return void toast.error(r.error);
              setPreview(r);
            }}
          >
            {busy && !preview ? "Reading..." : "See what will come in"}
          </button>
        </div>
      </div>

      {preview && (
        <div className="card card-pad space-y-3">
          <h2 className="h2">3. What will come in</h2>
          <p className="text-base">
            {preview.total} {preview.kind.toLowerCase()} from {preview.system}: <strong>{preview.fresh} new</strong>, {preview.already} already here
            {kind === "giftcards" ? " (left out)" : " (missing details filled in)"}.
          </p>
          {preview.sample.length > 0 && (
            <div className="scroll-x">
              <table className="table text-base">
                <thead>
                  <tr>
                    {preview.sampleHead.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r, i) => (
                    <tr key={i}>
                      {r.map((c, j) => (
                        <td key={j}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.problems.length > 0 && (
            <details>
              <summary className="link cursor-pointer text-base">
                {preview.problems.length} row{preview.problems.length === 1 ? "" : "s"}{" "}can&apos;t be read
              </summary>
              <ul className="muted mt-2 list-disc pl-6 text-sm">
                {preview.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
          <details>
            <summary className="link cursor-pointer text-sm">Columns read</summary>
            <p className="muted mt-1 text-sm">{preview.found.join(" · ")}</p>
          </details>
          {done ? (
            <p className="text-base" role="status">
              {done}
            </p>
          ) : (
            <div className="flex justify-end">
              <button
                type="button"
                className="btn btn-primary min-h-11 text-base"
                disabled={busy || preview.total === 0}
                onClick={async () => {
                  setBusy(true);
                  const r = await runAction(() => bringSwitchIn(system, kind, text, kind === "items" ? itemKind : null, addQty));
                  setBusy(false);
                  if (r?.error) return void toast.error(r.error);
                  setDone(r?.note ?? "Done.");
                  toast.success(r?.note ?? "Done.", { duration: 8000 });
                }}
              >
                {busy ? "Bringing them in..." : `Bring them in (${preview.total})`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
