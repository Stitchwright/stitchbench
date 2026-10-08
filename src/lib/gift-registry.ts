import "server-only";
// Wish lists and gift registries (shop-features-round-2-design.md 9.9, package gift-registry). A customer's list of
// what she would like (items from stock, or words), shared by a link she sends to family: the shop's public page shows
// what is still wanted, never who bought what. Bought at the counter (the register's "Gift lists"), the line names the
// list item and it is ticked off by itself; a void or a return on that sale puts it back. Every query filters by shopId.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { str } from "@/lib/format";
import { requireBaseWritable } from "@/lib/base-gate";
import { parseYmd } from "@/lib/zoned";
import { publicBaseUrl } from "@/lib/messaging/settings";
import type { CurrentUser } from "@/lib/session";

const MAX_ITEMS = 100;
const newToken = () => crypto.randomBytes(18).toString("base64url");

export async function createRegistryFor(user: CurrentUser, customerId: string, fd: FormData): Promise<{ id: string }> {
  await requireBaseWritable(user);
  const c = await db.customer.findFirst({ where: { id: assertId(customerId), shopId: user.shopId }, select: { id: true, name: true } });
  if (!c) throw new UserError("Customer not found.");
  const title = (str(fd.get("title")) ?? "").slice(0, 80) || `${c.name.split(/\s+/)[0]}'s wish list`;
  const rawDay = str(fd.get("eventDate"));
  const eventDate = rawDay ? parseYmd(rawDay) : null;
  if (rawDay && !eventDate) throw new UserError("The day: enter it as a date.");
  return db.giftRegistry.create({ data: { shopId: user.shopId, customerId: c.id, name: c.name, title, eventDate, token: newToken() }, select: { id: true } });
}

async function own(shopId: string, id: string) {
  const r = await db.giftRegistry.findFirst({ where: { id: assertId(id), shopId } });
  if (!r) throw new UserError("List not found.");
  return r;
}

/** Adds an item (picked from stock, or typed) with how many she would like. */
export async function addRegistryItemFor(user: CurrentUser, registryId: string, fd: FormData): Promise<string> {
  await requireBaseWritable(user);
  const r = await own(user.shopId, registryId);
  if ((await db.registryItem.count({ where: { registryId: r.id, shopId: user.shopId } })) >= MAX_ITEMS) throw new UserError(`${MAX_ITEMS} things at most on one list.`);
  const qty = Math.round(Number(str(fd.get("qty")) ?? "1"));
  if (!Number.isFinite(qty) || qty < 1 || qty > 99) throw new UserError("How many: 1 to 99.");
  const partId = str(fd.get("partId"));
  // The part box gives "number | description (n on hand)" or a number typed.
  const number = str(fd.get("partNumber"))?.split(" | ")[0].trim();
  let description = (str(fd.get("description")) ?? "").slice(0, 200);
  if (partId || number) {
    const p = await db.part.findFirst({
      where: { shopId: user.shopId, ...(partId ? { id: assertId(partId) } : { partNumber: { equals: number!, mode: "insensitive" } }) },
      select: { id: true, description: true, partNumber: true },
    });
    if (!p) throw new UserError("That item isn't in your inventory.");
    description ||= `${p.description} (${p.partNumber})`;
    await db.registryItem.create({ data: { shopId: user.shopId, registryId: r.id, partId: p.id, description, qtyWanted: qty, note: str(fd.get("note"))?.slice(0, 200) ?? null } });
  } else {
    if (!description) throw new UserError("Pick an item, or say what she would like.");
    await db.registryItem.create({ data: { shopId: user.shopId, registryId: r.id, description, qtyWanted: qty, note: str(fd.get("note"))?.slice(0, 200) ?? null } });
  }
  return `Added: ${description}.`;
}

export async function removeRegistryItemFor(user: CurrentUser, itemId: string): Promise<string> {
  await requireBaseWritable(user);
  const r = await db.registryItem.deleteMany({ where: { id: assertId(itemId), shopId: user.shopId } });
  if (!r.count) throw new UserError("Not found.");
  return "Taken off the list.";
}

/** Stop sharing (the link stops working) or share again with a new link. */
export async function setRegistrySharedFor(user: CurrentUser, registryId: string, shared: boolean): Promise<string> {
  await requireBaseWritable(user);
  const r = await own(user.shopId, registryId);
  await db.giftRegistry.updateMany({ where: { id: r.id, shopId: user.shopId }, data: shared ? { closedAt: null, token: r.closedAt ? newToken() : r.token } : { closedAt: new Date() } });
  return shared ? "Shared: send her the link." : "The link no longer works.";
}

// ---------------------------------------------------------------------------------------------------------------
// The register

/** Checks the list items named on a sale's lines: this shop's, the same item, being bought. Throws UserError. */
export async function checkRegistryLines(shopId: string, lines: { registryItemId?: string | null; partId?: string | null; qty: number }[]) {
  const ids = [...new Set(lines.map((l) => l.registryItemId).filter((x): x is string => typeof x === "string" && !!x))];
  if (!ids.length) return;
  const items = await db.registryItem.findMany({ where: { shopId, id: { in: ids } }, select: { id: true, partId: true } });
  for (const l of lines) {
    if (!l.registryItemId) continue;
    const it = items.find((i) => i.id === l.registryItemId);
    if (!it) throw new UserError("That gift list item isn't one of this shop's.");
    if (it.partId !== (l.partId ?? null)) throw new UserError("A gift list line is the item on the list.");
    if (!(l.qty > 0)) throw new UserError("A gift list line is a purchase. Return it as an ordinary item.");
  }
}

/** How many of each list item were bought on sales that stand (returns on those lines' sales taken off). */
async function boughtOf(shopId: string, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, number>();
  const rows = await db.saleLine.groupBy({ by: ["registryItemId"], where: { registryItemId: { in: itemIds }, sale: { shopId, status: "COMPLETED" } }, _sum: { qty: true } });
  return new Map(rows.map((r) => [r.registryItemId!, Math.max(0, r._sum.qty ?? 0)]));
}

export type RegistryLine = { id: string; partId: string | null; description: string; qtyWanted: number; bought: number; left: number; note: string | null; priceCents: number | null; partNumber: string | null; inStock: number };

async function linesOf(shopId: string, registryId: string): Promise<RegistryLine[]> {
  const items = await db.registryItem.findMany({ where: { shopId, registryId }, orderBy: { createdAt: "asc" } });
  const [bought, parts] = await Promise.all([
    boughtOf(shopId, items.map((i) => i.id)),
    db.part.findMany({ where: { shopId, id: { in: items.map((i) => i.partId).filter((x): x is string => !!x) } }, select: { id: true, priceCents: true, partNumber: true, qtyOnHand: true } }),
  ]);
  return items.map((i) => {
    const p = parts.find((x) => x.id === i.partId);
    const b = bought.get(i.id) ?? 0;
    return { id: i.id, partId: i.partId, description: i.description, qtyWanted: i.qtyWanted, bought: b, left: Math.max(0, i.qtyWanted - b), note: i.note, priceCents: p?.priceCents ?? null, partNumber: p?.partNumber ?? null, inStock: p?.qtyOnHand ?? 0 };
  });
}

/** The register's "Gift lists": lists by the name of the one they are for, with what is still wanted. */
export async function registriesByName(shopId: string, q: string) {
  const t = q.trim().slice(0, 60);
  if (t.length < 2) return [];
  const rs = await db.giftRegistry.findMany({ where: { shopId, OR: [{ name: { contains: t, mode: "insensitive" } }, { title: { contains: t, mode: "insensitive" } }] }, orderBy: { createdAt: "desc" }, take: 5 });
  return Promise.all(rs.map(async (r) => ({ id: r.id, title: r.title, name: r.name, eventDate: r.eventDate, lines: (await linesOf(shopId, r.id)).filter((l) => l.left > 0) })));
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

export async function registriesFor(shopId: string, customerId: string) {
  return db.giftRegistry.findMany({ where: { shopId, customerId }, orderBy: { createdAt: "desc" }, select: { id: true, title: true, eventDate: true, closedAt: true } });
}

export async function registryView(shopId: string, id: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return null;
  const r = await db.giftRegistry.findFirst({ where: { id, shopId } });
  if (!r) return null;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { bookingSlug: true } });
  const base = publicBaseUrl();
  const link = !r.closedAt && shop.bookingSlug && base ? `${base}/shop/${shop.bookingSlug}/wish/${r.token}` : null;
  return { ...r, lines: await linesOf(shopId, r.id), link, hasSlug: !!shop.bookingSlug };
}

/** The public page: a shared list by its token on its own shop's address. What is still wanted only; nothing about buyers. */
export async function publicRegistry(slug: string, token: string) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  const r = await db.giftRegistry.findUnique({ where: { token }, include: { shop: { select: { id: true, name: true, phone: true, address: true, bookingSlug: true } } } });
  if (!r || r.closedAt || r.shop.bookingSlug !== slug) return null;
  const lines = (await linesOf(r.shopId, r.id)).filter((l) => l.left > 0).map((l) => ({ id: l.id, description: l.description, left: l.left, note: l.note, priceCents: l.priceCents, partId: l.partId }));
  return { title: r.title, firstName: r.name.split(/\s+/)[0], eventDate: r.eventDate, shop: { name: r.shop.name, phone: r.shop.phone, address: r.shop.address }, lines };
}
