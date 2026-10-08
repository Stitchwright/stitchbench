import "server-only";
// Want lists (shop-features-round-2-design.md 1.4): the notebook at the counter ("call me when the next Tula Pink line
// lands"). A line is an item of the shop's, or words to watch for (a designer, a collection, a maker). When an item that
// matches arrives (received by order or by hand, imported from a supplier's list, added) the line shows "Here now" and
// offers "Let her know" (the order_in message with the item's name); the shop chooses, nothing goes by itself. Words
// match when every one is found in the item's number, description, maker, collection, designer or color name. Every
// query by shopId; bodies take the user so the check script can drive them.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { noticesOn } from "@/lib/module-gate";
import { queueToCustomer } from "@/lib/messaging/queue";
import { messagingView } from "@/lib/messaging/settings";
import { firstName, renderKind } from "@/lib/messaging/templates";

const MAX_OPEN = 50;

/** The words a want line watches for, cleaned: lower case, at most 6, each 2 letters or more. */
export function wantWords(text: string | null | undefined): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 6);
}

type PartText = { id: string; partNumber: string; description: string; brand: string | null; collection: string | null; designer: string | null; colorName: string | null; onlineTitle: string | null };

/** Whether an item matches a want line's words (every word somewhere in what the item is called). Pure. */
export function wordsMatch(words: string[], p: Omit<PartText, "id">): boolean {
  if (!words.length) return false;
  const hay = ` ${[p.partNumber, p.description, p.brand, p.collection, p.designer, p.colorName, p.onlineTitle].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return words.every((w) => hay.includes(` ${w}`));
}

const PART_TEXT = { id: true, partNumber: true, description: true, brand: true, collection: true, designer: true, colorName: true, onlineTitle: true } as const;

// ---------------------------------------------------------------------------------------------------------------------
// The list

export type WantView = {
  id: string;
  customer: { id: string; name: string };
  partId: string | null;
  words: string | null;
  /** What she wants, in words: the item's description, or the words. */
  what: string;
  note: string | null;
  createdAt: Date;
  here: { partId: string; partNumber: string; description: string; qtyOnHand: number } | null;
  matchedAt: Date | null;
  toldAt: Date | null;
};

async function views(shopId: string, rows: { id: string; customerId: string; partId: string | null; words: string | null; note: string | null; createdAt: Date; matchedPartId: string | null; matchedAt: Date | null; toldAt: Date | null; customer: { id: string; name: string } }[]): Promise<WantView[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.partId, r.matchedPartId]).filter((x): x is string => !!x))];
  const parts = new Map((ids.length ? await db.part.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, partNumber: true, description: true, qtyOnHand: true } }) : []).map((p) => [p.id, p]));
  return rows.map((r) => {
    const want = r.partId ? parts.get(r.partId) : null;
    const m = r.matchedPartId ? parts.get(r.matchedPartId) : null;
    return {
      id: r.id,
      customer: r.customer,
      partId: r.partId,
      words: r.words,
      what: want ? `${want.description} (${want.partNumber})` : (r.words ?? ""),
      note: r.note,
      createdAt: r.createdAt,
      here: m ? { partId: m.id, partNumber: m.partNumber, description: m.description, qtyOnHand: m.qtyOnHand } : null,
      matchedAt: r.matchedAt,
      toldAt: r.toldAt,
    };
  });
}

/** Open lines: one customer's, or (no customer) "Here now" first across the shop. */
export async function wantsFor(shopId: string, o: { customerId?: string | null; hereOnly?: boolean; take?: number } = {}): Promise<WantView[]> {
  const rows = await db.wantItem.findMany({
    where: { shopId, doneAt: null, ...(o.customerId ? { customerId: o.customerId } : {}), ...(o.hereOnly ? { matchedPartId: { not: null } } : {}) },
    include: { customer: { select: { id: true, name: true } } },
    orderBy: [{ matchedAt: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
    take: o.take ?? 200,
  });
  return views(shopId, rows);
}

/** "4 customers want this" on an item's page: open lines for the item itself or whose words match it. */
export async function wantersOf(shopId: string, partId: string): Promise<{ id: string; name: string }[]> {
  const part = await db.part.findFirst({ where: { id: partId, shopId }, select: PART_TEXT });
  if (!part) return [];
  const rows = await db.wantItem.findMany({ where: { shopId, doneAt: null }, include: { customer: { select: { id: true, name: true } } }, take: 2000 });
  const out = new Map<string, { id: string; name: string }>();
  for (const r of rows) if (r.partId === part.id || r.matchedPartId === part.id || (!r.partId && wordsMatch(wantWords(r.words), part))) out.set(r.customer.id, r.customer);
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------------------------------
// Adding, done, telling her

/** "Add to her want list": an item of the shop's, or words to watch for. An item on the shelf now is "Here now" at once. */
export async function addWantFor(user: CurrentUser, a: { customerId: string; partId?: string | null; words?: string | null; note?: string | null }): Promise<string> {
  await requireBaseWritable(user);
  const c = typeof a.customerId === "string" ? await db.customer.findFirst({ where: { id: a.customerId, shopId: user.shopId }, select: { id: true } }) : null;
  if (!c) throw new UserError("Customer not found.");
  const part = a.partId ? await db.part.findFirst({ where: { id: a.partId, shopId: user.shopId }, select: { ...PART_TEXT, qtyOnHand: true } }) : null;
  if (a.partId && !part) throw new UserError("That item isn't in your inventory any more.");
  const words = part ? null : a.words?.trim().slice(0, 120) || null;
  if (!part && !wantWords(words).length) throw new UserError("Say what she wants: pick an item, or type a designer, a collection or a maker (\"Tula Pink\").");
  if ((await db.wantItem.count({ where: { shopId: user.shopId, customerId: c.id, doneAt: null } })) >= MAX_OPEN) throw new UserError(`Her want list is full (${MAX_OPEN}). Take something off first.`);
  const now = new Date();
  const here = part && part.qtyOnHand > 0;
  await db.wantItem.create({ data: { shopId: user.shopId, customerId: c.id, partId: part?.id ?? null, words, note: a.note?.trim().slice(0, 200) || null, createdById: user.id, ...(here ? { matchedPartId: part.id, matchedAt: now } : {}) } });
  return here ? "Added. It's on the shelf now: let her know?" : "Added. You'll see \"Here now\" when it comes in.";
}

/** Off her list (she bought it, or no longer wants it). */
export async function doneWantFor(user: CurrentUser, id: string, now = new Date()): Promise<void> {
  const r = await db.wantItem.updateMany({ where: { id: String(id), shopId: user.shopId, doneAt: null }, data: { doneAt: now } });
  if (!r.count) throw new UserError("Want list line not found.");
}

/** "Let her know": the order_in message naming the item that's here (in the base: email or texts on, her usual way). */
export async function tellWantFor(user: CurrentUser, id: string, now = new Date()): Promise<string> {
  await requireBaseWritable(user);
  const w = await db.wantItem.findFirst({ where: { id: String(id), shopId: user.shopId, doneAt: null }, include: { customer: { select: { id: true, name: true } } } });
  if (!w) throw new UserError("Want list line not found.");
  if (!w.matchedPartId) throw new UserError("Nothing matching is here yet.");
  const part = await db.part.findFirst({ where: { id: w.matchedPartId, shopId: user.shopId }, select: { description: true, onlineTitle: true } });
  if (!part) throw new UserError("That item isn't in your inventory any more.");
  if (!(await noticesOn(user.shopId))) throw new UserError("Messages are off (no email or texts set up). Call her instead, then tap Done.");
  const ms = await messagingView(user.shopId);
  const shop = await db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true, phone: true } });
  const vars = { first_name: firstName(w.customer.name), name: w.customer.name, shop_name: shop.name, shop_phone: shop.phone ?? "", item: part.onlineTitle?.trim() || part.description, ref_line: " It's on your want list with us.", balance_line: "" };
  const q = await queueToCustomer(db, {
    shopId: user.shopId,
    customerId: w.customer.id,
    kind: "order_in",
    channels: "preferred",
    dedupeKey: `order_in:want:${w.id}:${w.matchedPartId}`,
    refType: "want",
    refId: w.id,
    sendAfter: now,
    byUserId: user.id,
    staffCap: false,
    ms,
    content: (ch) => {
      const c = renderKind(ms, "order_in", ch, vars);
      return { ...c, body: c.body.replace(/\s*We're holding it for you( at the counter)?\./, "") };
    },
  });
  if (!q.queued.length && !q.duplicate.length) throw new UserError(`${w.customer.name} has no email or mobile number we may use (or asked for no messages). Call her instead.`);
  await db.wantItem.updateMany({ where: { id: w.id, shopId: user.shopId }, data: { toldAt: now } });
  return q.duplicate.length && !q.queued.length ? "She was told about this one already." : `${firstName(w.customer.name) || "She"} will hear it's in.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching when items arrive

/**
 * Items arrived, were imported or added: open lines that want one of them (the item itself, or words that match) and
 * aren't already "Here now" become so. Returns how many lines matched.
 */
export async function matchWantsFor(shopId: string, partIds: string[], now = new Date()): Promise<number> {
  const ids = [...new Set(partIds.filter(Boolean))];
  if (!ids.length) return 0;
  const open = await db.wantItem.findMany({ where: { shopId, doneAt: null, matchedPartId: null }, select: { id: true, partId: true, words: true }, take: 5000 });
  if (!open.length) return 0;
  const parts = await db.part.findMany({ where: { shopId, id: { in: ids }, kind: { not: "MACHINE" } }, select: PART_TEXT });
  let n = 0;
  for (const w of open) {
    const hit = w.partId ? parts.find((p) => p.id === w.partId) : parts.find((p) => wordsMatch(wantWords(w.words), p));
    if (!hit) continue;
    n += (await db.wantItem.updateMany({ where: { id: w.id, shopId, matchedPartId: null }, data: { matchedPartId: hit.id, matchedAt: now } })).count;
  }
  return n;
}

/** Items made since a moment (a supplier's list imported): matched as above. */
export async function matchWantsSince(shopId: string, since: Date): Promise<number> {
  const made = await db.part.findMany({ where: { shopId, createdAt: { gte: since } }, select: { id: true }, take: 5000 });
  return matchWantsFor(
    shopId,
    made.map((p) => p.id),
  );
}

/** For the to-do lines: open lines that are "Here now" and she hasn't been told. */
export async function wantsHereUntold(shopId: string): Promise<number> {
  return db.wantItem.count({ where: { shopId, doneAt: null, matchedPartId: { not: null }, toldAt: null } });
}
