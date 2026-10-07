"use client";

// Companies → "Import a company" (company-move-design.md section 8 and decision 8): the move file goes up in 8 MB parts
// (UPLOAD_CHUNK), each its own request, with the progress shown; a dropped connection is retried, and a reload carries
// on from the last whole part when the same file is chosen again. Then the server imports it in the background and this
// card follows the progress to the summary (what came in, what to enter again). Routes: src/app/api/move/upload/**.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MOVE_SUFFIX, UPLOAD_CHUNK } from "@/lib/move/format";
import type { UploadView } from "@/lib/move/upload";
import { MoveImportProgress, MoveImportSummary } from "@/components/move-import-summary";

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = (v: UploadView) => v.status === "checking" || v.status === "importing";

async function send(url: string, method: string, body?: unknown): Promise<UploadView> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as UploadView & { error?: string };
  if (!r.ok) throw new Error(j.error ?? "The server didn't answer. Try again.");
  return j;
}

export function ImportCompany({ recent }: { recent: UploadView[] }) {
  const router = useRouter();
  const [views, setViews] = useState<UploadView[]>(recent);
  const [busy, setBusy] = useState<{ text: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upsert = (v: UploadView) => setViews((list) => [v, ...list.filter((x) => x.id !== v.id)]);

  // Follow the imports running on the server, once a second, until each is done or refused.
  const runningKey = views
    .filter(running)
    .map((v) => v.id)
    .join(",");
  useEffect(() => {
    if (!runningKey) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      for (const id of runningKey.split(",")) {
        const r = await fetch(`/api/move/upload/${id}`, { cache: "no-store" }).catch(() => null);
        if (!r?.ok || stop) continue;
        const v = (await r.json()) as UploadView;
        setViews((list) => list.map((x) => (x.id === v.id ? v : x)));
        if (v.status === "done") router.refresh(); // the new company in the table above
      }
      if (!stop) timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [runningKey, router]);

  async function upload(file: File) {
    setError(null);
    try {
      let v = await send("/api/move/upload", "POST", { name: file.name, size: file.size });
      upsert(v);
      let received = v.received;
      let outOfStep = 0;
      while (received < file.size) {
        const n = Math.floor(received / UPLOAD_CHUNK);
        const start = n * UPLOAD_CHUNK;
        setBusy({ text: `Uploading ${file.name}`, done: start, total: file.size });
        const part = file.slice(start, Math.min(start + UPLOAD_CHUNK, file.size));
        let r: Response | null = null;
        for (let attempt = 0; attempt < 5 && !r; attempt += 1) {
          r = await fetch(`/api/move/upload/${v.id}/${n}`, { method: "PUT", body: part }).catch(() => null);
          if (!r) await sleep(2000 * (attempt + 1));
        }
        if (!r) throw new Error("The connection dropped. Choose the same file again to carry on from where it stopped.");
        const j = (await r.json().catch(() => ({}))) as { received?: number; error?: string };
        if (r.status === 409 && typeof j.received === "number") {
          // The server needs another part (a part it already has, or one cut off): carry on from what it has.
          outOfStep += 1;
          if (outOfStep > 5) throw new Error("The upload got out of step with the server. Choose the same file again to carry on.");
          received = j.received;
          await sleep(500);
          continue;
        }
        if (!r.ok || typeof j.received !== "number") throw new Error(j.error ?? "The upload stopped. Choose the same file again to carry on.");
        outOfStep = 0;
        received = j.received;
      }
      setBusy({ text: "Starting the import", done: file.size, total: file.size });
      v = await send(`/api/move/upload/${v.id}`, "POST");
      upsert(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  async function again(id: string) {
    setError(null);
    try {
      upsert(await send(`/api/move/upload/${id}`, "POST"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function discard(id: string) {
    setError(null);
    const r = await fetch(`/api/move/upload/${id}`, { method: "DELETE" }).catch(() => null);
    if (r?.ok) setViews((list) => list.filter((x) => x.id !== id));
    else setError(((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't discard it. Try again.");
  }

  return (
    <div className="space-y-4">
      <p className="muted text-sm">
        Bring in a company moved out of another StitchBench or StitchShop (Settings → Company → Move this company, on the old install). Everything comes with its ids: customers, tickets, photos,
        partner records, license keys and every login, so its people sign in here with the same email and password. The file is checked line by line first: if anything is wrong, nothing is added and
        you are told why. The file is a whole company; it is deleted from the server once the company is in, and after a day either way.
      </p>
      <div className="field">
        <label htmlFor="move-file" className="label">
          Move file ({MOVE_SUFFIX})
        </label>
        <input
          id="move-file"
          ref={input}
          type="file"
          accept=".gz"
          className="input"
          disabled={!!busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      {busy && (
        <div className="space-y-1 text-sm" aria-live="polite">
          <p>
            {busy.text}: {mb(busy.done)} of {mb(busy.total)} MB
          </p>
          <progress className="w-full" value={busy.done} max={busy.total || 1} />
        </div>
      )}
      {error && (
        <p className="card card-pad tone-bad text-sm" role="alert">
          {error}
        </p>
      )}
      {views.map((v) => (
        <div key={v.id} className="card card-pad space-y-2">
          <p className="text-sm font-semibold">{v.name}</p>
          {v.status === "uploading" && (
            <p className="text-sm">
              Uploaded {mb(v.received)} of {mb(v.size)} MB, then stopped. Choose the same file again to carry on from there.
            </p>
          )}
          {running(v) && <MoveImportProgress p={v} />}
          {v.status === "failed" && (
            <p className="tone-bad text-sm" role="alert">
              Nothing was imported. {v.error}
            </p>
          )}
          {v.status === "done" && (v.summary ? <MoveImportSummary summary={v.summary} /> : <p className="text-sm">Imported: {v.rowsDone.toLocaleString()} rows.</p>)}
          {(v.status === "uploading" || v.status === "failed") && (
            <div className="flex flex-wrap gap-2">
              {v.canRetry && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void again(v.id)}>
                  Import again
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => void discard(v.id)}>
                Discard
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
