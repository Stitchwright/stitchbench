import "server-only";
// Notes between stores (shop-features-round-2-design.md 7.7): a simple board on the Today page. A note goes to one store
// or to all; pinned notes come first; each person's read tick; older ones fold away. No chat: no replies, no typing
// indicators. Only with more than one store. Every query by shopId.
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { activeStores, currentStore, storesOf } from "@/lib/stores";

export type NoteView = { id: string; text: string; pinned: boolean; at: Date; from: string; fromStore: string | null; to: string; mine: boolean; read: boolean; readBy: string[] };

/** Post a note to one store (toId) or to every store ("all"). */
export async function postNoteFor(user: CurrentUser, a: { to: string; text: string; pinned?: boolean }, now = new Date()): Promise<string> {
  const stores = await activeStores(user.shopId);
  if (stores.length <= 1) throw new UserError("Notes between stores need a second store.");
  const text = String(a.text ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
  if (!text) throw new UserError("Type the note first.");
  const to = a.to === "all" ? null : (stores.find((s) => s.id === a.to)?.id ?? undefined);
  if (to === undefined) throw new UserError("Store not found.");
  const here = await currentStore(user);
  const n = await db.storeNote.create({ data: { shopId: user.shopId, fromLocationId: here?.id ?? null, toLocationId: to, userId: user.id, text, pinned: a.pinned === true && user.role !== "TECH", createdAt: now } });
  // The writer has read her own note.
  await db.storeNoteRead.create({ data: { noteId: n.id, userId: user.id } });
  return n.id;
}

async function ownNote(user: CurrentUser, id: string) {
  const n = typeof id === "string" ? await db.storeNote.findFirst({ where: { id, shopId: user.shopId } }) : null;
  if (!n) throw new UserError("Note not found.");
  return n;
}

/** Pin to the top, or take the pin off (owners and admins). */
export async function pinNoteFor(user: CurrentUser, id: string, pinned: boolean): Promise<void> {
  if (user.role === "TECH") throw new UserError("Only the owner or an admin pins notes.");
  const n = await ownNote(user, id);
  await db.storeNote.updateMany({ where: { id: n.id, shopId: user.shopId }, data: { pinned } });
}

/** Take a note down (its writer, or an owner or admin). */
export async function removeNoteFor(user: CurrentUser, id: string): Promise<void> {
  const n = await ownNote(user, id);
  if (n.userId !== user.id && user.role === "TECH") throw new UserError("Only the writer or the owner takes a note down.");
  await db.storeNote.deleteMany({ where: { id: n.id, shopId: user.shopId } });
}

/** Tick the notes as read by this person. */
export async function markNotesReadFor(user: CurrentUser, ids: string[]): Promise<void> {
  const mine = await db.storeNote.findMany({ where: { shopId: user.shopId, id: { in: ids.filter((x) => typeof x === "string").slice(0, 200) } }, select: { id: true } });
  if (!mine.length) return;
  await db.storeNoteRead.createMany({ data: mine.map((n) => ({ noteId: n.id, userId: user.id })), skipDuplicates: true });
}

/**
 * The board for a store: notes to it or to all stores, and the ones it sent; pinned first, then newest. `days`: the
 * recent ones (the rest fold away under "Older notes").
 */
export async function notesFor(user: CurrentUser, storeId: string | null, o: { days?: number; older?: boolean } = {}, now = new Date()): Promise<NoteView[]> {
  const since = new Date(now.getTime() - (o.days ?? 14) * 86_400_000);
  const rows = await db.storeNote.findMany({
    where: {
      shopId: user.shopId,
      ...(storeId ? { OR: [{ toLocationId: storeId }, { toLocationId: null }, { fromLocationId: storeId }] } : {}),
      ...(o.older ? { pinned: false, createdAt: { lt: since } } : { OR: [{ pinned: true }, { createdAt: { gte: since } }] }),
    },
    include: { reads: { select: { userId: true } } },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    take: 100,
  });
  const ids = [...new Set(rows.flatMap((r) => [r.userId, ...r.reads.map((x) => x.userId)]).filter((x): x is string => !!x))];
  const names = new Map((await db.user.findMany({ where: { shopId: user.shopId, id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const stores = new Map((await storesOf(user.shopId)).map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    pinned: r.pinned,
    at: r.createdAt,
    from: (r.userId && names.get(r.userId)) || "Someone",
    fromStore: r.fromLocationId ? (stores.get(r.fromLocationId) ?? null) : null,
    to: r.toLocationId ? (stores.get(r.toLocationId) ?? "a closed store") : "All stores",
    mine: r.userId === user.id,
    read: r.reads.some((x) => x.userId === user.id),
    readBy: r.reads.filter((x) => x.userId !== r.userId).map((x) => names.get(x.userId) ?? "").filter(Boolean),
  }));
}

/** Notes to this store (or all) this person hasn't read: the Today page's count. */
export async function unreadNotes(user: CurrentUser, storeId: string | null): Promise<number> {
  return db.storeNote.count({ where: { shopId: user.shopId, ...(storeId ? { OR: [{ toLocationId: storeId }, { toLocationId: null }] } : {}), reads: { none: { userId: user.id } } } });
}
