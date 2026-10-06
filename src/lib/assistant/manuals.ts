import "server-only";
// Ask the manuals (ai-assistant-scope.md 1.4), the bodies the actions call: find the best-matching pages of the model's
// indexed manuals in this company's own database (Postgres full text, no embeddings), send only the question and those
// few pages through the hub (the `manuals` class), and show the answer with each fact's page as a link into the shop's
// own PDF viewer. The model may not answer beyond the pages: an answer with no page behind it, or no matching page at
// all, is "Not found in your manuals." Nothing is called on its own: only a person pressing Ask.
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { libraryFor } from "@/lib/model-info";
import { modelKey } from "@/lib/format";
import { requireOn } from "@/lib/module-gate";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";
import { assistantAvailable, runAssistant } from "./client";
import { namesToBlank } from "./redact";
import { buildAskManuals, manualPageHref, NOT_FOUND_MESSAGE, parseManualAnswer, PASSAGES, queryTerms, type ManualAnswer, type ManualPassage } from "./manuals-prompt";

export type Hit = { docId: string; page: number; text: string; rank: number };

/**
 * The best pages for a question among these library files, from this company's index only (every query filters by
 * shopId). The words are ORed and ranked by how many of them sit close together on a page, so the page that has "hook",
 * "timing" and "procedure" in one passage beats ten pages that only say "hook".
 */
export async function searchPages(shopId: string, docIds: readonly string[], question: string, o: { drop?: readonly string[]; limit?: number } = {}): Promise<Hit[]> {
  const terms = queryTerms(question, o.drop ?? []);
  if (!terms.length || !docIds.length) return [];
  const q = terms.join(" | ");
  // Pages matching at least one word are the candidates; they are ranked by how many different words they hold first
  // (a page that repeats "hook" ten times must not beat the page that has hook, timing and procedure), then by how close together those words sit.
  const rows = await db.$queryRaw<{ docId: string; page: number; text: string; rank: number }[]>(Prisma.sql`
    WITH cand AS MATERIALIZED (
      SELECT p."docId", p."page", p."text", to_tsvector('english', p."text") AS v, query
      FROM "ManualPage" p, to_tsquery('english', ${q}) query
      WHERE p."shopId" = ${shopId} AND p."docId" IN (${Prisma.join(docIds as string[])}) AND to_tsvector('english', p."text") @@ query
    )
    SELECT "docId", "page", "text", ts_rank_cd(v, query, 1) AS rank
    FROM cand
    ORDER BY (SELECT count(*) FROM unnest(${terms}::text[]) t WHERE v @@ plainto_tsquery('english', t)) DESC, rank DESC, "docId", "page"
    LIMIT ${o.limit ?? PASSAGES}`);
  return rows.map((r) => ({ docId: r.docId, page: r.page, text: r.text, rank: Number(r.rank) }));
}

/** The library files' names and paths, for labels and links. */
async function docInfo(ids: readonly string[]) {
  const rows = await db.libraryDoc.findMany({ where: { id: { in: [...ids] } }, select: { id: true, path: true, file: true, title: true, brand: true } });
  return new Map(rows.map((r) => [r.id, { path: r.path, label: (r.title?.trim() || r.file.replace(/\.pdf$/i, "")).slice(0, 120) }]));
}

async function passagesFor(hits: Hit[]): Promise<ManualPassage[]> {
  const info = await docInfo([...new Set(hits.map((h) => h.docId))]);
  return hits.flatMap((h, i) => {
    const d = info.get(h.docId);
    return d ? [{ ref: `m${i + 1}`, docId: h.docId, page: h.page, label: d.label, text: h.text, href: manualPageHref(d.path, h.page) }] : [];
  });
}

export type AskResult = ManualAnswer & {
  /** The pages that went to the model (0 when nothing matched and no call was made). */
  sent: number;
  /** Pages in this model's manuals that can't be searched because they are scans. */
  scanned: number;
  callId?: string;
};

/** How many of this model's pages are indexed and how many are scans, for "Ask" and its notes. */
export async function modelIndexState(shopId: string, brand: string, model: string) {
  const docs = await libraryFor(brand, model);
  const ids = docs.map((d) => d.id);
  const rows = ids.length ? await db.manualIndexDoc.findMany({ where: { shopId, docId: { in: ids } }, select: { status: true, donePages: true, blankPages: true } }) : [];
  return {
    docs: ids,
    indexedFiles: rows.filter((r) => r.donePages > 0).length,
    searchable: rows.reduce((s, r) => s + (r.donePages - r.blankPages), 0),
    scanned: rows.reduce((s, r) => s + r.blankPages, 0),
  };
}

/**
 * "Ask": retrieve the best pages of the model's manuals, ask, check. Returns the answer or "not found". `ticketId`, when
 * asked from a ticket, is only the log's pointer (nothing about the ticket is sent).
 */
export async function askManuals(user: CurrentUser, o: { brand: string; model: string; question: string; ticketId?: string | null }): Promise<AskResult> {
  await requireOn(user, "assistant");
  const question = String(o.question ?? "").replace(/\s+/g, " ").trim();
  if (question.length < 3) throw new UserError("Type a question first.");
  const brand = String(o.brand ?? "").trim().slice(0, 80);
  const model = String(o.model ?? "").trim().slice(0, 80);
  if (!brand || !model) throw new UserError("Which machine is this about?");
  const ticket = o.ticketId ? await db.ticket.findFirst({ where: { id: String(o.ticketId), shopId: user.shopId }, select: { id: true, machineId: true } }) : null;
  if (o.ticketId && !ticket) throw new UserError("Ticket not found.");
  const av = await assistantAvailable(user.shopId, { group: "manuals" });
  if (!av.ok) throw new UserError(av.message);
  const st = await modelIndexState(user.shopId, brand, model);
  if (!st.docs.length) throw new UserError("There are no manuals for this model in your library.");
  if (st.searchable === 0) {
    throw new UserError(st.scanned > 0 ? "These manuals are scanned pictures, which can't be searched yet." : "Index this model's manuals first (the button above), then ask again.");
  }
  const hits = await searchPages(user.shopId, st.docs, question, { drop: [brand, model, modelKey(model)] });
  const passages = await passagesFor(hits);
  if (!passages.length) return { found: false, answer: "", citations: [], sent: 0, scanned: st.scanned };
  const everyone = await db.customer.findMany({ where: { shopId: user.shopId }, select: { name: true }, take: 5000 });
  const built = buildAskManuals({ brand, model, question, passages, r: { names: namesToBlank({ allCustomers: everyone.map((c) => c.name) }) } });
  const { row, text } = await runAssistant({ shopId: user.shopId, userId: user.id, built, target: { ...(ticket ? { ticketId: ticket.id, machineId: ticket.machineId } : {}) } });
  const parsed = parseManualAnswer(text, built.sources ?? []);
  return { ...parsed, sent: passages.length, scanned: st.scanned, callId: row.id };
}

export type TextHit = { docId: string; page: number; snippet: string; label: string; href: string };

/** The manuals page's search box: a plain full-text search across this company's indexed manuals, with a snippet and a link to each page. No model, no allowance. */
export async function searchManualText(user: CurrentUser, query: string): Promise<TextHit[]> {
  await requireOn(user, "assistant");
  const terms = queryTerms(String(query ?? "").slice(0, QUERY_MAX));
  if (!terms.length) return [];
  const ids = (await db.manualIndexDoc.findMany({ where: { shopId: user.shopId, donePages: { gt: 0 } }, select: { docId: true } })).map((r) => r.docId);
  if (!ids.length) return [];
  const q = terms.join(" & ");
  const rows = await db.$queryRaw<{ docId: string; page: number; snippet: string }[]>(Prisma.sql`
    SELECT p."docId", p."page",
           ts_headline('english', p."text", query, 'MaxWords=28, MinWords=12, MaxFragments=1, StartSel=«, StopSel=»') AS snippet
    FROM "ManualPage" p, to_tsquery('english', ${q}) query
    WHERE p."shopId" = ${user.shopId} AND p."docId" IN (${Prisma.join(ids)}) AND to_tsvector('english', p."text") @@ query
    ORDER BY ts_rank_cd(to_tsvector('english', p."text"), query, 1) DESC, p."docId", p."page"
    LIMIT 20`);
  const info = await docInfo([...new Set(rows.map((r) => r.docId))]);
  return rows.flatMap((r) => {
    const d = info.get(r.docId);
    return d ? [{ docId: r.docId, page: r.page, snippet: r.snippet.replace(/\s+/g, " ").slice(0, 400), label: d.label, href: manualPageHref(d.path, r.page) }] : [];
  });
}

const QUERY_MAX = 120;

export { NOT_FOUND_MESSAGE };
