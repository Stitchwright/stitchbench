import "server-only";
// Marketing and web-store drafts (shop-features-round-2-design.md 5.2): the bodies of the "Draft it" buttons. Each reads
// the shop's own records (this company's only), builds the request (src/lib/assistant/marketing-prompt.ts) and returns
// the text for the page to put in the field: the campaign's subject and body, a class's "About the class", an item's
// online text, or a social post to copy. Nothing is saved or sent from here; the person changes it and saves.
import { db } from "@/lib/db";
import { detailsLine } from "@/lib/item-details";
import { requireOn } from "@/lib/module-gate";
import type { CurrentUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { UserError } from "@/lib/user-error";
import { fmtWhen } from "@/lib/zoned";
import { runAssistant } from "./client";
import { voiceFor } from "./context";
import { buildArrivals, buildClassBlurb, buildPost, buildProductText, splitSubject, type ArrivalFact, type ClassFacts, type ItemFacts, type PostAbout } from "./marketing-prompt";
import { namesToBlank } from "./redact";

type Who = Pick<CurrentUser, "id" | "shopId" | "role">;
const DAY = 86_400_000;

async function redactionFor(shopId: string) {
  const everyone = await db.customer.findMany({ where: { shopId }, select: { name: true }, take: 5000 });
  return { names: namesToBlank({ allCustomers: everyone.map((c) => c.name) }) };
}

const daysOf = (n: unknown) => {
  const d = Math.round(Number(n));
  return Number.isFinite(d) && d >= 1 ? Math.min(90, d) : 14;
};

/** Items received in the last `days` days (stock moves in), most received first: this company's own, no partner's consigned stock. */
export async function arrivalsFor(shopId: string, days: number, now = new Date()): Promise<ArrivalFact[]> {
  const moves = await db.stockMove.groupBy({ by: ["partId"], where: { shopId, reason: "RECEIVED", qty: { gt: 0 }, createdAt: { gte: new Date(now.getTime() - days * DAY) } }, _sum: { qty: true }, orderBy: { _sum: { qty: "desc" } }, take: 60 });
  if (!moves.length) return [];
  const parts = await db.part.findMany({
    where: { shopId, id: { in: moves.map((m) => m.partId) }, consignLinkId: null, kind: { not: "MACHINE" } },
    select: { id: true, description: true, onlineTitle: true, brand: true, collection: true, colorTags: true, priceCents: true, unit: true, kind: true, itemType: true, colorNumber: true, colorName: true, material: true, specs: true },
  });
  const byId = new Map(parts.map((p) => [p.id, p]));
  return moves
    .map((m) => byId.get(m.partId))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .slice(0, 30)
    .map((p) => ({ name: p.onlineTitle || p.description, brand: p.brand, collection: p.collection, details: detailsLine(p) || null, tags: p.colorTags, priceCents: p.priceCents, unit: p.unit }));
}

async function itemFacts(shopId: string, partId: string): Promise<ItemFacts> {
  const p = await db.part.findFirst({
    where: { id: String(partId), shopId },
    select: { description: true, onlineTitle: true, brand: true, kind: true, collection: true, designer: true, colorTags: true, priceCents: true, unit: true, itemType: true, colorNumber: true, colorName: true, material: true, specs: true, notes: true },
  });
  if (!p) throw new UserError("Item not found.");
  return { name: p.onlineTitle || p.description, brand: p.brand, kind: p.kind, collection: p.collection, designer: p.designer, details: detailsLine(p) || null, tags: p.colorTags, content: null, priceCents: p.priceCents, unit: p.unit };
}

async function classFacts(shopId: string, classId: string): Promise<ClassFacts> {
  const c = await db.shopClass.findFirst({ where: { id: String(classId), shopId }, select: { title: true, teacher: true, location: true, firstAt: true, feeCents: true, supplies: true, description: true, _count: { select: { meetings: { where: { cancelled: false } } } } } });
  if (!c) throw new UserError("Class not found.");
  const tz = await shopTimeZone(shopId);
  return { title: c.title, teacher: c.teacher, location: c.location, when: c.firstAt ? fmtWhen(c.firstAt, tz) : null, meetings: c._count.meetings, feeCents: c.feeCents, supplies: c.supplies, notes: c.description };
}

/** "Draft it" on a new campaign: an email about what came in lately. */
export async function draftArrivals(user: Who, o: { days?: number; instruction?: string }): Promise<{ subject: string; body: string; count: number }> {
  await requireOn(user as CurrentUser, "assistant");
  const days = daysOf(o.days);
  const items = await arrivalsFor(user.shopId, days);
  if (!items.length) throw new UserError(`Nothing was received in the last ${days} days. Receive stock first, or try more days.`);
  const { text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildArrivals(items, days, await voiceFor(user.shopId), await redactionFor(user.shopId), o.instruction) });
  return { ...splitSubject(text), count: items.length };
}

/**
 * "Draft it" for a class's "About the class": from the form as typed (a new class isn't saved yet), and for a saved
 * class its first meeting and number of meetings too.
 */
export async function draftClassBlurb(user: Who, o: { classId?: string | null; title?: string; teacher?: string; location?: string; supplies?: string; fee?: string; instruction?: string }): Promise<string> {
  await requireOn(user as CurrentUser, "assistant");
  const saved = o.classId ? await classFacts(user.shopId, o.classId) : null;
  const fee = String(o.fee ?? "").replace(/[$,\s]/g, "");
  const feeCents = fee && Number.isFinite(Number(fee)) ? Math.round(Number(fee) * 100) : (saved?.feeCents ?? null);
  const facts: ClassFacts = {
    title: String(o.title ?? "").trim() || saved?.title || "",
    teacher: String(o.teacher ?? "").trim() || saved?.teacher || null,
    location: String(o.location ?? "").trim() || saved?.location || null,
    when: saved?.when ?? null,
    meetings: saved?.meetings ?? null,
    feeCents,
    supplies: String(o.supplies ?? "").trim() || saved?.supplies || null,
    notes: null,
  };
  if (!facts.title) throw new UserError("Type the class name first.");
  const { text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildClassBlurb(facts, await voiceFor(user.shopId), await redactionFor(user.shopId), o.instruction) });
  return text.trim().slice(0, 4000);
}

/** "Draft it" for an item's online text. */
export async function draftProductText(user: Who, o: { partId: string; instruction?: string }): Promise<string> {
  await requireOn(user as CurrentUser, "assistant");
  const facts = await itemFacts(user.shopId, o.partId);
  const { text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildProductText(facts, await voiceFor(user.shopId), await redactionFor(user.shopId), o.instruction), target: { partId: String(o.partId) } });
  return text.trim().slice(0, 2000);
}

/** "Draft a social post" about what came in, a class or an item: text to copy. */
export async function draftSocialPost(user: Who, o: { about: string; id?: string | null; days?: number; instruction?: string }): Promise<string> {
  await requireOn(user as CurrentUser, "assistant");
  let about: PostAbout;
  if (o.about === "class" && o.id) about = { kind: "class", facts: await classFacts(user.shopId, o.id) };
  else if (o.about === "item" && o.id) about = { kind: "item", facts: await itemFacts(user.shopId, o.id) };
  else if (o.about === "arrivals") {
    const days = daysOf(o.days);
    const items = await arrivalsFor(user.shopId, days);
    if (!items.length) throw new UserError(`Nothing was received in the last ${days} days.`);
    about = { kind: "arrivals", items, days };
  } else throw new UserError("That isn't something the Assistant drafts.");
  const { text } = await runAssistant({ shopId: user.shopId, userId: user.id, built: buildPost(about, await voiceFor(user.shopId), await redactionFor(user.shopId), o.instruction), target: about.kind === "item" ? { partId: String(o.id) } : {} });
  return text.trim().slice(0, 1500);
}
