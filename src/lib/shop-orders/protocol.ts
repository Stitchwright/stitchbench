// The envelope and the order of applying messages (docs/plans/makerfoundry-orders-plan.md; StitchHub docs/hub-sync-design.md sections 3 and 4).
// Pure, so the sync job and the tests share it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The part of a polled message this program reads; the body is checked later against its type. */
export type Envelope = { id: string; from: string; type: string; version: number; conversation: string; seq: number; createdAt: Date; expiresAt: Date | null; deliverySeq: string; body: unknown };

const when = (v: unknown): Date | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
};

/** One message from the hub's list, held to the shapes the hub promises (it is another computer's answer); null when unusable. */
export function parseEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && UUID.test(r.id) ? r.id.toLowerCase() : null;
  const from = typeof r.from === "string" && /^(hub|service:[a-z][a-z0-9-]{1,30}|shop:[\w-]{1,64})$/.test(r.from) ? r.from : null;
  const type = typeof r.type === "string" && /^[a-z]{2,20}(\.[a-z]{2,20})?$/.test(r.type) ? r.type : null;
  const version = typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 1 && r.version <= 99 ? r.version : null;
  const conversation = typeof r.conversation === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(r.conversation) ? r.conversation : null;
  const seq = typeof r.seq === "number" && Number.isInteger(r.seq) && r.seq >= 1 && r.seq <= 1_000_000 ? r.seq : null;
  const createdAt = when(r.created_at);
  const deliverySeq = typeof r.delivery_seq === "string" && /^\d{1,18}$/.test(r.delivery_seq) ? r.delivery_seq : null;
  if (!id || !from || !type || version == null || !conversation || seq == null || !createdAt || !deliverySeq) return null;
  return { id, from, type, version, conversation, seq, createdAt, expiresAt: when(r.expires_at), deliverySeq, body: r.body };
}

/** The kind of sender an address names. */
export const senderKind = (from: string): "service" | "shop" | "hub" => (from === "hub" ? "hub" : from.startsWith("service:") ? "service" : "shop");

/** How long a gap in an order's sequence is waited on before the later message is applied anyway (and shown to the shop). */
export const GAP_MS = 24 * 3600_000;

export type Waiting = { id: string; seq: number; receivedAt: number };

/**
 * Which waiting messages of one conversation (one sender) may be applied now, in order. `next` is the seq expected next. A message
 * with a seq already passed is `stale` (an old copy: nothing to apply, only to acknowledge). The expected seq and every seq straight
 * after it are due; a later one waits for the gap to fill, but not longer than GAP_MS from when it arrived, after which it is due
 * anyway and `gapped` says a message in front of it never came.
 */
export function planApply(next: number, waiting: Waiting[], now: number): { due: Waiting[]; stale: Waiting[]; gapped: boolean; next: number } {
  const sorted = [...waiting].sort((a, b) => a.seq - b.seq || a.receivedAt - b.receivedAt);
  const stale: Waiting[] = [];
  const due: Waiting[] = [];
  let expect = next;
  let gapped = false;
  const seen = new Set<number>();
  for (const w of sorted) {
    if (w.seq < expect || seen.has(w.seq)) {
      stale.push(w);
      continue;
    }
    if (w.seq > expect && now - w.receivedAt < GAP_MS) break;
    if (w.seq > expect) gapped = true;
    due.push(w);
    seen.add(w.seq);
    expect = w.seq + 1;
  }
  return { due, stale, gapped, next: expect };
}
