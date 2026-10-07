"use client";

// Offering a manual and downloading one on a hosted install (docs/plans/manual-repository-design.md 5.4): no library on
// the server, so the BROWSER reads the file from the tech's own folder, checks it and hashes it (crypto.subtle), the
// server action gets the slot from the hub, the browser PUTs to R2 on the presigned URL, and the server action says it
// was sent. The install key never reaches the browser; the file never reaches this server. A person presses Offer for
// each file and ticks the statement for it: nothing is sent otherwise.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";
import { DOC_TYPES } from "@/lib/constants";
import { getLocalFile, saveToLibrary } from "@/lib/local-manuals";
import { checkPdfParts, guessFields, PRIVATE_LIBRARY_FOLDERS, REVIEW_NOTE, STATEMENT } from "@/lib/manual-offer-pure";
import { failHostedOffer, finishHostedOffer, repositoryDownloadInfo, startHostedOffer } from "@/actions/manual-repository";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: ArrayBuffer) => hex(await crypto.subtle.digest("SHA-256", b));

/** One file of the connected folder: its own dialog, its own tick. */
export function HostedOffer({ path, name }: { path: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const g = guessFields(name);
  const id = `ho-${path.replace(/[^A-Za-z0-9]/g, "")}`;
  if (path.split(/[\\/]/).some((p) => PRIVATE_LIBRARY_FOLDERS.includes(p.toLowerCase()))) return null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const file = await getLocalFile(path);
      const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 65536)).arrayBuffer());
      try {
        checkPdfParts(head, tail, file.size);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That file can't be offered.");
        return;
      }
      const sum = await sha256(await file.arrayBuffer());
      const r = await startHostedOffer({
        category: String(fd.get("category") ?? ""),
        brand: String(fd.get("brand") ?? ""),
        models: String(fd.get("models") ?? ""),
        docType: String(fd.get("docType") ?? ""),
        year: String(fd.get("year") ?? ""),
        language: String(fd.get("language") ?? ""),
        title: String(fd.get("title") ?? ""),
        accepted: fd.get("accepted") === "on",
        sha256: sum,
        sizeBytes: file.size,
        fileName: file.name,
        path,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (r.state !== "SENDING" || !r.put) {
        toast.success(r.message, { duration: 8000 });
        setOpen(false);
        router.refresh();
        return;
      }
      // The signed headers are Content-Type (and Content-Length, which the browser sets itself).
      const headers = Object.fromEntries(Object.entries(r.put.headers).filter(([k]) => k.toLowerCase() !== "content-length"));
      let put: Response | null = null;
      try {
        put = await fetch(r.put.url, { method: "PUT", headers, body: file });
      } catch {
        put = null;
      }
      if (!put?.ok) {
        await failHostedOffer(r.id, put ? `storage answered ${put.status}` : "the browser couldn't reach storage");
        toast.error("The file couldn't be sent. Check the connection and offer it again.");
        router.refresh();
        return;
      }
      const done = await finishHostedOffer(r.id);
      if (!done.ok) toast.error(done.error);
      else if (done.state === "NOT_ACCEPTED") toast.error(done.message);
      else toast.success(done.message, { duration: 8000 });
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't offer that file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0">
      <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Upload size={12} aria-hidden /> Offer to the repository
      </button>
      {open && (
        <form onSubmit={submit} className="card card-pad mt-2 max-w-xl space-y-2 text-left">
          <p className="text-sm">
            <strong className="break-all">{name}</strong> will be sent to the hub&apos;s manual repository for every shop to download. {REVIEW_NOTE}
          </p>
          <div className="grid-form">
            <div className="field">
              <label htmlFor={`${id}-c`} className="label">
                Category
              </label>
              <input id={`${id}-c`} name="category" required className="input" placeholder="Sewing, Embroidery, Serger, Vacuum" />
            </div>
            <div className="field">
              <label htmlFor={`${id}-b`} className="label">
                Brand
              </label>
              <input id={`${id}-b`} name="brand" defaultValue={g.brand} required className="input" />
            </div>
            <div className="field">
              <label htmlFor={`${id}-m`} className="label">
                Model(s), separated by commas
              </label>
              <input id={`${id}-m`} name="models" defaultValue={g.models} required className="input" />
            </div>
            <div className="field">
              <label htmlFor={`${id}-d`} className="label">
                Kind of manual
              </label>
              <select id={`${id}-d`} name="docType" defaultValue={g.docType ?? "ServiceManual"} className="select">
                {DOC_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {d.replace(/([a-z])([A-Z])/g, "$1 $2")}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${id}-y`} className="label">
                Year (optional)
              </label>
              <input id={`${id}-y`} name="year" inputMode="numeric" defaultValue={g.year} className="input" />
            </div>
            <div className="field">
              <label htmlFor={`${id}-l`} className="label">
                Language
              </label>
              <input id={`${id}-l`} name="language" defaultValue="English" className="input" />
            </div>
            <div className="field sm:col-span-2">
              <label htmlFor={`${id}-t`} className="label">
                Title (optional)
              </label>
              <input id={`${id}-t`} name="title" className="input" />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="accepted" required className="mt-1" />
            <span>{STATEMENT}</span>
          </label>
          <button className="btn btn-sm btn-primary" disabled={busy}>
            {busy ? "Sending..." : "Offer this manual"}
          </button>
        </form>
      )}
    </div>
  );
}

/** Hosted: fetch a repository manual in the browser (R2's CORS allows GET from this site), check it, save it into the tech's folder, else as a plain download. */
export function RepoDownloadButton({ linkId }: { linkId: string }) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const info = await repositoryDownloadInfo(linkId);
      if (!info.ok) {
        toast.error(info.error);
        return;
      }
      const r = await fetch(info.url);
      if (!r.ok) {
        toast.error(`The repository's storage answered ${r.status}. Try again later.`);
        return;
      }
      const buf = await r.arrayBuffer();
      if (new TextDecoder("latin1").decode(new Uint8Array(buf, 0, 5)) !== "%PDF-") {
        toast.error("What came back isn't a PDF; nothing was saved.");
        return;
      }
      if (info.sha256 && (await sha256(buf)) !== info.sha256) {
        toast.error("The file that came back isn't the one the hub described (its checksum differs); nothing was saved.");
        return;
      }
      const saved = await saveToLibrary(new Blob([buf], { type: "application/pdf" }), info.brand, info.fileName);
      toast.success(saved.saved === "library" ? `Saved to your manuals folder: ${saved.path}` : "Downloaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't download it.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="btn btn-sm" disabled={busy} onClick={run}>
      <Download size={12} aria-hidden /> {busy ? "Downloading..." : "Download"}
    </button>
  );
}
