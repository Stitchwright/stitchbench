// A stand-in for StitchHub's v2 queue (stitchhub src/sync.mjs) in front of the shop-orders sync, as assistant-hub.ts is for the assistant:
// per-recipient queues with a delivery cursor, offered again until acknowledged, a minimum client version (426), and knobs to break it
// (failing acks and posts). It speaks the routes and shapes the real hub does; the real one is checked by StitchHub's own tests, and the
// shared fixtures keep the two honest.
//   const h = await startOrdersHub();  h.put(shopRef, { type, conversation, seq, body, ... });  h.posted (what the shop sent)
import http from "node:http";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { hubState } from "@/lib/hub";

export type HubMsg = { id: string; from: string; type: string; version: number; conversation: string; seq: number; created_at: string; expires_at: string | null; body: unknown; delivery_seq: number; state: "queued" | "delivered" | "acked" };

export async function startOrdersHub() {
  const queues = new Map<string, HubMsg[]>();
  const calls: { method: string; path: string; shop: string | null; client: string | null; auth: string | null; json?: unknown }[] = [];
  const posted: Record<string, unknown>[] = [];
  const hellos: Record<string, unknown>[] = [];
  const optins: (Record<string, unknown> & { shop: string | null })[] = [];
  const files = new Map<string, Buffer>();
  const knobs = { minClient: null as string | null, failAcks: 0, postStatuses: [] as { status: number; error: string; code?: string }[], optinStatuses: [] as { status: number; error: string }[], fileStatuses: [] as { status: number; error: string }[], corruptFiles: new Set<string>(), offline: false };
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") return send(200, { ok: true });
    // The bucket: the short-lived address the hub hands out for a file (no hub credentials, as the real one).
    const bucket = /^\/bucket\/([0-9a-f]{64})$/.exec(url.pathname);
    if (bucket && req.method === "GET") {
      const f = files.get(bucket[1]);
      if (!f) return void res.writeHead(404).end();
      const bytes = knobs.corruptFiles.has(bucket[1]) ? Buffer.concat([f.subarray(0, f.length - 1), Buffer.from([0x7f])]) : f;
      return void res.writeHead(200, { "content-length": bytes.length }).end(bytes);
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const json = raw ? JSON.parse(raw) : undefined;
    const shop = (req.headers["x-shop-ref"] as string) ?? null;
    const client = (req.headers["x-client"] as string) ?? null;
    calls.push({ method: req.method ?? "", path: url.pathname, shop, client, auth: req.headers.authorization ?? null, json });
    if (knobs.offline) return void res.destroy();
    const m = /^([a-z0-9-]+)\/(\d+)\.(\d+)\.(\d+)/.exec(client ?? "");
    if (!m) return send(400, { error: "Send X-Client.", code: "client_header" });
    if (knobs.minClient) {
      const need = knobs.minClient.split(".").map(Number);
      const have = [Number(m[2]), Number(m[3]), Number(m[4])];
      const older = have[0] !== need[0] ? have[0] < need[0] : have[1] !== need[1] ? have[1] < need[1] : have[2] < need[2];
      if (older) return send(426, { error: `StitchHub needs a newer stitchshop (${knobs.minClient} or later). Please update.`, code: "upgrade_required", min: knobs.minClient });
    }
    const q = queues.get(shop ?? "") ?? [];
    if (url.pathname === "/v2/hello" && req.method === "POST") {
      hellos.push({ shop, ...json });
      return send(200, { hub: "2.0.0", types: {}, limits: {}, released: 0 });
    }
    if (url.pathname === "/v2/files/get" && req.method === "POST") {
      const scripted = knobs.fileStatuses.shift();
      if (scripted) return send(scripted.status, { error: scripted.error });
      const f = files.get(String(json?.sha256 ?? ""));
      if (!f) return send(404, { error: "No such file for you.", code: "no_such_file" });
      return send(200, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/bucket/${json.sha256}`, expires_in: 600, size: f.length, type: null, sha256: json.sha256 });
    }
    if (url.pathname === "/v2/optin" && req.method === "PUT") {
      const scripted = knobs.optinStatuses.shift();
      if (scripted) return send(scripted.status, { error: scripted.error });
      optins.push({ shop, ...json });
      return send(200, { service: json?.service, enabled: json?.enabled !== false, maxOpen: json?.maxOpen ?? 200, perMinute: 50 });
    }
    if (url.pathname === "/v2/messages" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
      const now = Date.now();
      const rows = q.filter((x) => x.delivery_seq > after && x.state !== "acked" && (!x.expires_at || Date.parse(x.expires_at) > now)).sort((a, b) => a.delivery_seq - b.delivery_seq).slice(0, limit);
      for (const r of rows) r.state = "delivered";
      return send(200, { messages: rows.map((r) => ({ id: r.id, from: r.from, to: `shop:${shop}`, type: r.type, version: r.version, conversation: r.conversation, seq: r.seq, created_at: r.created_at, expires_at: r.expires_at, body: r.body, sig: null, delivery_seq: String(r.delivery_seq) })), next: rows.length ? String(rows[rows.length - 1].delivery_seq) : String(after) });
    }
    if (url.pathname === "/v2/messages/ack" && req.method === "POST") {
      if (knobs.failAcks > 0) {
        knobs.failAcks -= 1;
        return send(503, { error: "busy" });
      }
      let acked = 0;
      for (const id of (json?.ids as string[]) ?? []) for (const r of q) if (r.id === id && r.state !== "acked") { r.state = "acked"; acked += 1; }
      return send(200, { acked });
    }
    if (url.pathname === "/v2/messages" && req.method === "POST") {
      const scripted = knobs.postStatuses.shift();
      if (scripted) return send(scripted.status, { error: scripted.error, code: scripted.code });
      posted.push(json);
      return send(202, { queued: true });
    }
    send(404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const saved = await hubState();
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
  if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
  return {
    url,
    calls,
    posted,
    hellos,
    optins,
    files,
    knobs,
    /** A message waiting for the company on the hub (as MakerFoundry's would be). */
    put(shopRef: string, m: { type: string; conversation: string; seq: number; body: unknown; id?: string; from?: string; version?: number; createdAt?: Date; expiresAt?: Date | null }): string {
      const id = m.id ?? crypto.randomUUID();
      const list = queues.get(shopRef) ?? [];
      seq += 1;
      list.push({ id, from: m.from ?? "service:makerfoundry", type: m.type, version: m.version ?? 1, conversation: m.conversation, seq: m.seq, created_at: (m.createdAt ?? new Date()).toISOString(), expires_at: m.expiresAt === null ? null : (m.expiresAt ?? new Date(Date.now() + 7 * 86_400_000)).toISOString(), body: m.body, delivery_seq: seq, state: "queued" });
      queues.set(shopRef, list);
      return id;
    },
    /** The same message handed out again under a new delivery number (a hub that lost an ack, a replay). */
    replay(shopRef: string, id: string): void {
      const list = queues.get(shopRef) ?? [];
      const o = list.find((x) => x.id === id);
      if (!o) return;
      seq += 1;
      list.push({ ...o, delivery_seq: seq, state: "queued" });
    },
    stateOf: (shopRef: string, id: string) => (queues.get(shopRef) ?? []).find((x) => x.id === id)?.state,
    close: async () => {
      await new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r())));
      if (saved) await db.hubState.update({ where: { id: 1 }, data: { url: saved.url, installKey: saved.installKey, installId: saved.installId, scope: saved.scope } }).catch(() => {});
      else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => {});
    },
  };
}
