// A stand-in for the hub's manual repository routes and for R2, in this process (what manual-repository.check.ts and
// manual-repository-hosted.check.ts talk to). It follows the real hub's answers (stitchhub branch manual-repo,
// src/repository.mjs): 403 "The manual repository opens soon." while uploads are off, 200 duplicate / blocked / a slot,
// the PUT target, POST .../sent checking the stored bytes, the company's offers, the feed with its own cursor, and download
// URLs by manual id. Nothing here is a test of the hub; it lets the program's side be checked end to end.
import crypto from "node:crypto";
import http from "node:http";

export const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
export const sha1 = (b: Buffer | string) => crypto.createHash("sha1").update(b).digest("hex");

type Upload = { id: string; shopRef: string; state: string; reason: string | null; sha256: string; sizeBytes: number; manualId: string | null; offered: Record<string, unknown>; statement: unknown; byName: string | null; fileName: string | null };
export type FeedItem = Record<string, unknown> & { id: string; seq: number };

export type RepoMock = Awaited<ReturnType<typeof startRepoMock>>;

export async function startRepoMock() {
  const m = {
    base: "",
    uploadsOn: true,
    /** sha256 -> manual id: answered "duplicate" */
    duplicates: new Map<string, string>(),
    /** sha256 set: answered "blocked" */
    blocked: new Set<string>(),
    /** The PUT answers this status (200 by default); the number of failures left. */
    putFail: 0,
    /** Next /files/:id/url answers 429 this many times. */
    slow: 0,
    /** Manual ids removed from download (404). */
    gone: new Set<string>(),
    /** What the PUT target and the download target serve: key -> bytes. */
    objects: new Map<string, Buffer>(),
    /** manual id -> the bytes the download URL serves (default: objects "files/<id>"). */
    uploads: new Map<string, Upload>(),
    feed: [] as FeedItem[],
    seq: 100,
    /** Every request: method, path, headers of interest, body. */
    log: [] as { method: string; path: string; shopRef: string | null; body: string }[],
    /** What the next /files/:id/url answers as the URL (default: this mock's R2). */
    urlOverride: null as string | null,
    putHeaders: [] as Record<string, string | string[] | undefined>[],
    publish(id: string, item: Record<string, unknown>, bytes: Buffer) {
      m.objects.set(`files/${id}`, bytes);
      m.feed.push({ id, seq: ++m.seq, sha256: sha256(bytes), sha1: sha1(bytes), sizeBytes: bytes.length, pages: 3, language: "English", ...item });
    },
    remove(id: string, why: string) {
      m.feed = m.feed.filter((x) => x.id !== id);
      m.feed.push({ id, seq: ++m.seq, removed: true, why });
      m.gone.add(id);
    },
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", m.base);
      const p = url.pathname;
      const shopRef = (req.headers["x-shop-ref"] as string | undefined) ?? url.searchParams.get("shopRef");
      m.log.push({ method: req.method ?? "", path: p, shopRef: shopRef ?? null, body: p.startsWith("/r2/") ? `<${body.length} bytes>` : body.toString("utf8") });
      if (p === "/health") return json(res, 200, { ok: true });
      // ----- R2 -----
      if (p.startsWith("/r2/")) {
        const key = p.slice(4);
        if (req.method === "PUT") {
          m.putHeaders.push(req.headers);
          if (m.putFail > 0) {
            m.putFail -= 1;
            return res.writeHead(500).end();
          }
          m.objects.set(key, body);
          return res.writeHead(200).end();
        }
        const o = m.objects.get(key);
        if (!o) return res.writeHead(404).end();
        return res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": o.length }).end(o);
      }
      // ----- member routes -----
      if (req.method === "POST" && p === "/v1/repository/uploads") {
        if (!m.uploadsOn) return json(res, 403, { error: "The manual repository opens soon." });
        let j: { sha256?: string; sizeBytes?: number; fileName?: string; byName?: string; offered?: Record<string, unknown>; statement?: { accepted?: boolean; version?: string } } = {};
        try {
          j = JSON.parse(body.toString("utf8") || "{}");
        } catch {
          return json(res, 400, { error: "Send JSON." });
        }
        if (!shopRef) return json(res, 400, { error: "Send X-Shop-Ref: the company's id." });
        if (!/^[0-9a-f]{64}$/.test(String(j.sha256 ?? ""))) return json(res, 400, { error: "Send the file's sha256 (64 hex digits)." });
        if (j.statement?.accepted !== true) return json(res, 400, { error: "The statement must be ticked for this file." });
        const sha = j.sha256 as string;
        const size = Number(j.sizeBytes);
        if (m.blocked.has(sha)) return json(res, 200, { blocked: true, message: "That file was removed from the repository and can't be offered again." });
        const dup = m.duplicates.get(sha);
        if (dup) return json(res, 200, { duplicate: true, id: dup, message: "That file is already in the repository." });
        const id = `up${(m.uploads.size + 1).toString().padStart(3, "0")}${crypto.randomBytes(3).toString("hex")}`;
        m.uploads.set(id, { id, shopRef, state: "slot", reason: null, sha256: sha, sizeBytes: size, manualId: null, offered: j.offered ?? {}, statement: j.statement, byName: j.byName ?? null, fileName: j.fileName ?? null });
        return json(res, 200, { uploadId: id, putUrl: `${m.base}/r2/incoming/${id}.pdf`, putHeaders: { "Content-Type": "application/pdf", "Content-Length": String(size) }, expiresAt: new Date(Date.now() + 900_000).toISOString() });
      }
      let mt = /^\/v1\/repository\/uploads\/([A-Za-z0-9]+)\/sent$/.exec(p);
      if (req.method === "POST" && mt) {
        const up = m.uploads.get(mt[1]);
        if (!up || up.shopRef !== shopRef) return json(res, 404, { error: "No such offer." });
        const bytes = m.objects.get(`incoming/${up.id}.pdf`);
        if (!bytes) return json(res, 409, { error: "The file hasn't arrived in storage yet." });
        if (sha256(bytes) !== up.sha256) {
          up.state = "refused";
          up.reason = "The file's contents don't match its sha256: it changed or broke on the way. Offer it again.";
        } else up.state = "pending";
        return json(res, 200, { state: up.state, reason: up.reason });
      }
      if (req.method === "GET" && p === "/v1/repository/uploads") {
        if (!shopRef) return json(res, 400, { error: "Send X-Shop-Ref (or ?shopRef=): the company's id." });
        return json(res, 200, {
          uploads: [...m.uploads.values()]
            .filter((u) => u.shopRef === shopRef)
            .map((u) => ({ id: u.id, state: u.state, reason: u.reason, sha256: u.sha256, sizeBytes: u.sizeBytes, offered: u.offered, originalName: u.fileName, manualId: u.manualId })),
        });
      }
      if (req.method === "GET" && p === "/v1/repository/changes") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const rows = m.feed.filter((x) => x.seq > since).sort((a, b) => a.seq - b.seq);
        const next = rows.length ? String(rows[rows.length - 1].seq) : String(since);
        return json(res, 200, { manuals: rows.map((x) => ({ ...x, seq: String(x.seq) })), next, more: false });
      }
      mt = /^\/v1\/repository\/files\/([A-Za-z0-9_-]+)\/url$/.exec(p);
      if (req.method === "POST" && mt) {
        if (m.slow > 0) {
          m.slow -= 1;
          return json(res, 429, { error: "Too many downloads in the last hour. The queue carries on later." });
        }
        const item = m.feed.find((x) => x.id === mt![1] && !x.removed);
        if (!item || m.gone.has(mt[1])) return json(res, 404, { error: "That manual isn't in the repository (it may have been removed)." });
        return json(res, 200, { url: m.urlOverride ?? `${m.base}/r2/files/${mt[1]}`, expiresAt: new Date(Date.now() + 300_000).toISOString(), sha256: item.sha256, sizeBytes: item.sizeBytes });
      }
      json(res, 404, { error: "No such route." });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  m.base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  return m;
}

/** A small valid-looking PDF with a distinct body. */
export function pdfBytes(label: string, extra = ""): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${extra}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
}
