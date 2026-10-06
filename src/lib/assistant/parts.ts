import "server-only";
// The parts helpers (ai-assistant-scope.md 1.5 and 1.6 a), the bodies the actions call: "Looks like" for a part with no
// cross-reference match, "Parts this job usually needs" on a ticket, and "Match the columns" on the inventory import.
// Candidates are chosen here, in this company's own database and the hub's copy of the cross-reference (every shop query
// filters by shopId); only a few dozen part numbers and names go to the model. Nothing changes a record: the answers
// are links and a proposed column map, and a person confirms. Nothing runs on its own.
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { modelKey } from "@/lib/format";
import { sameText } from "@/lib/input";
import { requireOn } from "@/lib/module-gate";
import { partsFittingModel, xrefForKeys, type XFit, type XNumber } from "@/lib/parts";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";
import { runAssistant } from "./client";
import { ticketContext } from "./context";
import {
  buildLooksLike,
  buildMatchColumns,
  buildPartsForJob,
  nameTerms,
  numberVariants,
  parseColumnMap,
  parseJobParts,
  parseMatches,
  type ColumnField,
  type JobCandidate,
  type LookCandidate,
} from "./parts-prompt";
import { namesToBlank } from "./redact";

// ----- Looks like -----

export type LooksLikeMatch = { ref: string; kind: "xpart" | "part"; name: string; numbers: string; href: string; confidence: "likely" | "possible"; why: string; qty?: number };
export type LooksLikeResult = { matches: LooksLikeMatch[]; /** Candidates that went to the model (0: nothing to compare, no call made). */ sent: number; callId?: string };

const numbersText = (xs: XNumber[]) => xs.slice(0, 8).map((n) => `${n.brand} ${n.number}`).join("; ");
const fitsText = (fits: XFit[]) => [...new Set(fits.map((f) => `${f.brand} ${f.model}`))].slice(0, 6).join(", ");

/** The shared cross-reference entries and this company's other stock that might be the same part, best first (at most 30 and 10). */
export async function looksLikeCandidates(shopId: string, p: { id: string; partNumber: string; altNumbers: string[]; description: string; brand: string | null }): Promise<LookCandidate[]> {
  const variants = numberVariants(p.partNumber, ...p.altNumbers);
  const terms = nameTerms(`${p.description} ${p.brand ?? ""}`, 5);
  const like = variants.filter((v) => v.length >= 4).map((v) => `%${v}%`);
  const nameLike = terms.map((t) => `%${t}%`);
  const byNumber = variants.length ? Prisma.sql`x."numberKeys" && ${variants}::text[]` : Prisma.sql`false`;
  const byPart = like.length ? Prisma.sql`EXISTS (SELECT 1 FROM unnest(x."numberKeys") k WHERE length(k) >= 4 AND k LIKE ANY(${like}::text[]))` : Prisma.sql`false`;
  const byName = nameLike.length ? Prisma.sql`x."name" ILIKE ANY(${nameLike}::text[])` : Prisma.sql`false`;
  const ids = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT x."id" FROM "XPart" x WHERE ${byNumber} OR ${byPart} OR ${byName} LIMIT 300`);
  const xs = ids.length ? await db.xPart.findMany({ where: { id: { in: ids.map((r) => r.id) } } }) : [];
  const score = (name: string, keys: string[]) => {
    let s = 0;
    for (const k of keys) {
      if (variants.includes(k)) s += 6;
      else if (variants.some((v) => v.length >= 4 && k.length >= 4 && (k.includes(v) || v.includes(k)))) s += 3;
    }
    const n = name.toLowerCase();
    for (const t of terms) if (n.includes(t)) s += 1;
    return s;
  };
  const xRanked = xs
    .map((x) => ({ x, s: score(x.name, x.numberKeys) }))
    .filter((e) => e.s > 0)
    .sort((a, b) => b.s - a.s || a.x.name.localeCompare(b.x.name))
    .slice(0, 30);

  const stock = await db.part.findMany({
    where: {
      shopId,
      id: { not: p.id },
      OR: [
        ...(variants.length ? [{ numberKeys: { hasSome: variants } }] : []),
        ...terms.slice(0, 4).map((t) => ({ description: { contains: t, mode: "insensitive" as const } })),
      ],
    },
    select: { id: true, partNumber: true, altNumbers: true, description: true, brand: true, fits: true, numberKeys: true, qtyOnHand: true },
    take: 60,
  });
  const sRanked = stock
    .map((s) => ({ s, sc: score(s.description, s.numberKeys) }))
    .filter((e) => e.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 10);

  return [
    ...xRanked.map(({ x }, i): LookCandidate => ({ ref: `x${i + 1}`, kind: "xpart", name: x.name, numbers: numbersText(x.numbers as XNumber[]), fits: fitsText(x.fits as XFit[]), href: `/xref/${x.id}` })),
    ...sRanked.map(({ s }, i): LookCandidate => ({ ref: `s${i + 1}`, kind: "part", name: s.description, numbers: [s.partNumber, ...s.altNumbers].join("; "), fits: s.fits ?? "", href: `/parts/${s.id}`, qty: s.qtyOnHand })),
  ];
}

/**
 * "Looks like" on a part page: only for a part with no cross-reference entry of its own (the exact-number match has
 * already been tried). Returns the checked suggestions; the tech opens one and decides. No candidates = no call.
 */
export async function looksLike(user: CurrentUser, o: { partId: string }): Promise<LooksLikeResult> {
  await requireOn(user, "assistant");
  const p = await db.part.findFirst({ where: { id: String(o.partId), shopId: user.shopId }, select: { id: true, partNumber: true, altNumbers: true, description: true, brand: true, fits: true, numberKeys: true, ownNumber: true } });
  if (!p) throw new UserError("Part not found.");
  if ((await xrefForKeys(p.numberKeys)).length) throw new UserError("This part is already in the cross-reference by its number.");
  const cands = await looksLikeCandidates(user.shopId, p);
  if (!cands.length) return { matches: [], sent: 0 };
  const everyone = await db.customer.findMany({ where: { shopId: user.shopId }, select: { name: true }, take: 5000 });
  const built = buildLooksLike({ number: p.ownNumber ? "(the shop's own number)" : p.partNumber, alts: p.altNumbers, description: p.description, brand: p.brand, fits: p.fits }, cands, { names: namesToBlank({ allCustomers: everyone.map((c) => c.name) }) });
  const { row, text } = await runAssistant({ shopId: user.shopId, userId: user.id, built, target: { partId: p.id } });
  const parsed = parseMatches(text, cands) ?? [];
  const by = new Map(cands.map((c) => [c.ref, c]));
  return {
    sent: Math.min(cands.length, 40),
    callId: row.id,
    matches: parsed.map((m) => {
      const c = by.get(m.ref)!;
      return { ref: m.ref, kind: c.kind, name: c.name, numbers: c.numbers, href: c.href, confidence: m.confidence, why: m.why, ...(c.qty != null ? { qty: c.qty } : {}) };
    }),
  };
}

// ----- Parts this job usually needs -----

export type JobPart = { ref: string; kind: "used" | "fits"; label: string; reason: string; href: string; stockHref?: string; qty?: number };
export type JobPartsResult = { parts: JobPart[]; /** Candidates that went to the model (0: no history and no fitting parts, no call made). */ sent: number; callId?: string };

const CLOSED = 30;

/** The candidates for a ticket: what this shop put on past closed jobs on the model, and what the cross-reference says fits it. */
export async function jobCandidates(shopId: string, ticket: { id: string; brand: string; model: string }): Promise<JobCandidate[]> {
  const key = modelKey(ticket.model);
  const past = await db.ticket.findMany({
    where: { shopId, id: { not: ticket.id }, closedAt: { not: null }, machine: { brand: sameText(ticket.brand), modelKey: key } },
    orderBy: { closedAt: "desc" },
    take: CLOSED,
    select: { id: true, problem: true, lines: { where: { kind: "PART" }, select: { partId: true, description: true } } },
  });
  type Agg = { label: string; partId: string | null; tickets: Set<string>; problems: string[] };
  const used = new Map<string, Agg>();
  for (const t of past) {
    for (const l of t.lines) {
      const k = l.partId ?? `d:${l.description.trim().toLowerCase()}`;
      const a = used.get(k) ?? { label: l.description.trim(), partId: l.partId, tickets: new Set<string>(), problems: [] };
      a.tickets.add(t.id);
      if (t.problem && a.problems.length < 2 && !a.problems.includes(t.problem.slice(0, 80))) a.problems.push(t.problem.slice(0, 80));
      used.set(k, a);
    }
  }
  const usedRanked = [...used.values()].sort((a, b) => b.tickets.size - a.tickets.size).slice(0, 15);
  const out: JobCandidate[] = usedRanked.map((a, i) => ({
    ref: `u${i + 1}`,
    kind: "used",
    label: a.label,
    text: `used on ${a.tickets.size} of ${past.length} closed jobs on this model${a.problems.length ? `; problems then: ${a.problems.join(" / ")}` : ""}`,
    href: a.partId ? `/parts/${a.partId}` : `/tickets/${[...a.tickets][0]}`,
  }));
  const { xparts, stocked } = await partsFittingModel(shopId, ticket.brand, ticket.model, 400);
  xparts.slice(0, 20).forEach((x, i) => {
    const fit = (x.fits as XFit[]).find((f) => f.modelKey === key);
    const stock = stocked.get(x.id);
    out.push({
      ref: `f${i + 1}`,
      kind: "fits",
      label: x.name,
      text: `fits this model (${fit?.evidence ?? "listed"}); numbers: ${numbersText(x.numbers as XNumber[])}${stock ? `; ${stock.qtyOnHand} in stock` : ""}`,
      href: `/xref/${x.id}`,
      ...(stock ? { stockHref: `/parts/${stock.id}`, qty: stock.qtyOnHand } : {}),
    });
  });
  return out;
}

/** "Parts this job usually needs" on a ticket. No past jobs and no fitting parts = no call (the history is thin until a model has been seen). */
export async function partsForJob(user: CurrentUser, o: { ticketId: string; instruction?: string }): Promise<JobPartsResult> {
  await requireOn(user, "assistant");
  const ctx = await ticketContext(user.shopId, o.ticketId);
  const cands = await jobCandidates(user.shopId, { id: ctx.ids.ticketId, brand: ctx.machine.brand, model: ctx.machine.model });
  if (!cands.length) return { parts: [], sent: 0 };
  const built = buildPartsForJob(
    { brand: ctx.machine.brand, model: ctx.machine.model, serviceRequested: ctx.facts.serviceRequested, problem: ctx.facts.problem, diagnosis: ctx.facts.diagnosis },
    cands,
    ctx.redaction,
    { instruction: o.instruction },
  );
  const { row, text } = await runAssistant({ shopId: user.shopId, userId: user.id, built, target: { ticketId: ctx.ids.ticketId, machineId: ctx.ids.machineId }, serials: ctx.redaction.serials });
  const by = new Map(cands.map((c) => [c.ref, c]));
  const picks = parseJobParts(text, cands) ?? [];
  return {
    sent: Math.min(cands.length, 40),
    callId: row.id,
    parts: picks.map((p) => {
      const c = by.get(p.ref)!;
      return { ref: c.ref, kind: c.kind, label: c.label, reason: p.reason, href: c.href, ...(c.stockHref ? { stockHref: c.stockHref } : {}), ...(c.qty != null ? { qty: c.qty } : {}) };
    }),
  };
}

// ----- Match the columns -----

export type ColumnsResult = { map: Record<string, number>; callId: string };

/** "Match the columns": the headings and three sample rows of a pasted file, answered as a proposed field-to-column map the person checks in the picker. */
export async function matchColumns(user: CurrentUser, o: { fields: ColumnField[]; headers: string[]; sample: string[][] }): Promise<ColumnsResult> {
  await requireOn(user, "assistant");
  const headers = (Array.isArray(o.headers) ? o.headers : []).slice(0, 60).map((h) => String(h ?? ""));
  if (headers.length < 2) throw new UserError("Paste the cells with their header row first.");
  const fields = (Array.isArray(o.fields) ? o.fields : []).slice(0, 20).map((f) => ({ key: String(f.key).replace(/[^A-Za-z]/g, "").slice(0, 30), label: String(f.label).slice(0, 80) })).filter((f) => f.key);
  if (!fields.length) throw new UserError("Nothing to match.");
  const sample = (Array.isArray(o.sample) ? o.sample : []).slice(0, 3).map((r) => (Array.isArray(r) ? r.slice(0, 60).map((c) => String(c ?? "")) : []));
  const built = buildMatchColumns(fields, headers, sample);
  const { row, text } = await runAssistant({ shopId: user.shopId, userId: user.id, built });
  const map = parseColumnMap(text, fields.map((f) => f.key), headers.length);
  if (!map) throw new UserError("The Assistant couldn't tell which columns are which. Pick them in the lists below.");
  return { map, callId: row.id };
}
