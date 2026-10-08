import "server-only";
// The shop's own care tips per kind of machine and the pickup sheet (shop-features-round-2-design.md 5.5): "What we
// did" in plain words and the tips chosen from the shop's list, printed with the invoice. The Assistant may draft the
// words and pick tips from the list; it never writes new advice. Every query filters by the company.
import { db } from "@/lib/db";
import type { CurrentUser } from "@/lib/session";
import { UserError } from "@/lib/user-error";
import { MAX_TIP, MAX_TIPS_PER_KIND, startersFor } from "@/lib/care-tips-starters";

export type CareTipRow = { id: string; kind: string; text: string };

export async function careTipsFor(shopId: string, kind?: string): Promise<CareTipRow[]> {
  return db.careTip.findMany({ where: { shopId, ...(kind ? { kind } : {}) }, orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, kind: true, text: true } });
}

const admin = (user: Pick<CurrentUser, "role">) => {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin can change the care tips.");
};
const cleanKind = (k: string) => {
  const kind = String(k ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(kind)) throw new UserError("Pick the kind of machine.");
  return kind;
};

export async function addCareTipFor(user: Pick<CurrentUser, "shopId" | "role">, kindIn: string, textIn: string): Promise<string> {
  admin(user);
  const kind = cleanKind(kindIn);
  const text = String(textIn ?? "").trim().replace(/\s+/g, " ");
  if (text.length < 5) throw new UserError("Write the tip in a sentence.");
  if (text.length > MAX_TIP) throw new UserError(`Keep a tip under ${MAX_TIP} characters.`);
  const count = await db.careTip.count({ where: { shopId: user.shopId, kind } });
  if (count >= MAX_TIPS_PER_KIND) throw new UserError(`At most ${MAX_TIPS_PER_KIND} tips for one kind.`);
  const row = await db.careTip.create({ data: { shopId: user.shopId, kind, text, sortOrder: count } });
  return row.id;
}

/** Removes a tip; returns what the Undo needs to put it back. */
export async function removeCareTipFor(user: Pick<CurrentUser, "shopId" | "role">, id: string): Promise<{ kind: string; text: string; sortOrder: number }> {
  admin(user);
  const row = await db.careTip.findFirst({ where: { id: String(id), shopId: user.shopId } });
  if (!row) throw new UserError("Tip not found.");
  await db.careTip.delete({ where: { id: row.id } });
  return { kind: row.kind, text: row.text, sortOrder: row.sortOrder };
}

export async function restoreCareTipFor(user: Pick<CurrentUser, "shopId" | "role">, o: { kind: string; text: string; sortOrder: number }): Promise<void> {
  admin(user);
  await db.careTip.create({ data: { shopId: user.shopId, kind: cleanKind(o.kind), text: String(o.text ?? "").slice(0, MAX_TIP), sortOrder: Math.max(0, Math.round(Number(o.sortOrder) || 0)) } });
}

/** "Add the starter tips" for a kind with none yet. */
export async function addStartersFor(user: Pick<CurrentUser, "shopId" | "role">, kindIn: string): Promise<number> {
  admin(user);
  const kind = cleanKind(kindIn);
  if (await db.careTip.count({ where: { shopId: user.shopId, kind } })) throw new UserError("This kind already has tips.");
  const tips = startersFor(kind);
  if (!tips.length) throw new UserError("There are no starter tips for this kind. Write your own.");
  await db.careTip.createMany({ data: tips.map((text, i) => ({ shopId: user.shopId, kind, text, sortOrder: i })) });
  return tips.length;
}

/**
 * The pickup sheet saved on a ticket of this company: "What we did" and the tips ticked, each one a tip on the shop's
 * list for the machine's kind (copied as printed). Empty clears it.
 */
export async function savePickupSheetFor(user: Pick<CurrentUser, "shopId">, ticketId: string, o: { what: string; tipIds: string[] }): Promise<void> {
  const t = await db.ticket.findFirst({ where: { id: String(ticketId), shopId: user.shopId }, select: { id: true, machine: { select: { kind: true } } } });
  if (!t) throw new UserError("Ticket not found.");
  const what = String(o.what ?? "").trim().slice(0, 2000) || null;
  const ids = [...new Set((o.tipIds ?? []).map(String))].slice(0, 10);
  const tips = ids.length ? await db.careTip.findMany({ where: { shopId: user.shopId, kind: t.machine.kind, id: { in: ids } }, orderBy: { sortOrder: "asc" }, select: { text: true } }) : [];
  if (tips.length !== ids.length) throw new UserError("A tip isn't on your list for this kind of machine any more. Refresh the page.");
  await db.ticket.update({ where: { id: t.id }, data: { pickupWhat: what, pickupTips: tips.map((x) => x.text) } });
}
