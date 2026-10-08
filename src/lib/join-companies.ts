import "server-only";
// Bring an existing company in as a store (shop-features-round-2-design.md 7.6). An owner who runs two companies on
// this install joins the second into the first. She proves she owns both by signing in to both: in the second she
// makes a one-time join code (30 minutes), in the first she types it (never a matching email: emails aren't verified): its items, customers, gift
// cards, tickets, sales and the rest of its history come in as a new store of the first, every row as it was (the
// tables the company file carries, src/lib/move/format.ts). What can't share a number is made to fit: the second
// company's tickets, sales and orders are numbered on from the first's (ticket 51 becomes 1051), an item number both
// use gets the store's name ("BN-2 (Florida)"), a login whose email the first already has is kept for the history but
// switched off. Customers that look the same are listed after, for the existing customer merge (never merged by
// itself). The second company is left closed ("joined into ..."), with what can't move (its licence keys, partner
// shops, settings, audit log): its StitchHub subscription is the owner's to cancel; the first company's bill counts
// the extra store. Partnerships with other shops must be ended first (they belong to the second company on the hub).
import crypto from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { actorOf, audit } from "@/lib/audit";
import { MOVE_TABLES } from "@/lib/move/format";
import { ensureMainStore } from "@/lib/stores";
import { sameText } from "@/lib/input";

/** Tables that stay with the second company: its own settings, licence keys, partnerships, hub hops and audit log. */
const STAY = new Set([
  "Shop",
  "Location",
  "BooksSettings",
  "OffsiteSettings",
  "OffsiteObject",
  "AuditEntry",
  "MessagingSettings",
  "AssistantSettings",
  "License",
  "ModuleGrant",
  "PartnerKey",
  "PartnerLink",
  "PartnerOutbox",
  "RepairJob",
  "PartnerOrder",
  "ConsignItem",
  "ConsignSale",
  "Settlement",
  "PartnerSeen",
  "PartnerFailure",
  "PartnerRun",
  "ShopHop",
  "HopStampLocal",
]);

/** Numbered records: the second company's are numbered on from the first's, and the first's counter moves past them. */
const NUMBERED: { table: string; counter: keyof Prisma.ShopUncheckedUpdateInput | null }[] = [
  { table: "Ticket", counter: "nextTicketNumber" },
  { table: "Sale", counter: "nextSaleNumber" },
  { table: "WebOrder", counter: "nextWebOrderNumber" },
  { table: "MakeJob", counter: "nextMakeJobNumber" },
  { table: "PurchaseOrder", counter: null },
  { table: "LongarmOrder", counter: "nextLongarmNumber" },
  { table: "Layaway", counter: "nextLayawayNumber" },
  { table: "SpecialOrder", counter: "nextSpecialOrderNumber" },
  { table: "WarrantyClaim", counter: "nextClaimNumber" },
  { table: "CoopClaim", counter: "nextCoopNumber" },
  { table: "Appraisal", counter: "nextAppraisalNumber" },
  { table: "StockTransfer", counter: "nextTransferNumber" },
];

/** Tables with a store (locationId): the second company's rows without one were its main store's. */
const WITH_STORE = ["Sale", "Ticket", "WebOrder", "StockUnit", "PurchaseOrder", "ShopClass", "AppointmentType", "Shift", "LongarmOrder", "MakeJob", "SpecialOrder", "UnitLoan", "GiftCardEntry", "Layaway", "LiveSale", "AccountEntry", "CardReader", "StockMove", "User", "Approval"];

/** How long a join code is good for. */
export const JOIN_CODE_MINUTES = 30;

const hashJoinCode = (code: string) => crypto.createHash("sha256").update(code.replace(/[^A-Z0-9]/gi, "").toUpperCase()).digest("hex");

/**
 * "Join this company into another of yours": the owner, signed in to the company that will become a store, makes a
 * one-time code (shown once, good for 30 minutes) and types it into the other company. Owning both is proved by
 * signing in to both, never by a matching email (emails aren't verified).
 */
export async function makeJoinCodeFor(user: CurrentUser, now = new Date()): Promise<{ code: string; until: Date }> {
  if (user.role !== "OWNER") throw new UserError("Only the owner joins companies.");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join("");
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  const until = new Date(now.getTime() + JOIN_CODE_MINUTES * 60_000);
  await db.shop.update({ where: { id: user.shopId }, data: { joinCodeHash: hashJoinCode(code), joinCodeUntil: until, joinCodeById: user.id } });
  await audit(db, actorOf(user), { action: "store.join_code", subjectType: "Shop", subjectId: user.shopId, subjectLabel: "Join code made" });
  return { code, until };
}

/** The company a join code is for: still good, made by an owner of it who is still its active owner. Null otherwise. */
async function companyForCode(user: CurrentUser, code: string, now: Date) {
  const c = String(code ?? "").trim();
  if (c.replace(/[^A-Z0-9]/gi, "").length !== 10) return null;
  const from = await db.shop.findFirst({
    where: { joinCodeHash: hashJoinCode(c), joinCodeUntil: { gt: now }, id: { not: user.shopId } },
    select: { id: true, name: true, address: true, phone: true, timeZone: true, taxRatePct: true, receiptNote: true, hoursNote: true, movingAt: true, movedOutAt: true, joinCodeById: true },
  });
  if (!from || !from.joinCodeById || from.movedOutAt) return null;
  const owner = await db.user.count({ where: { id: from.joinCodeById, shopId: from.id, role: "OWNER", active: true } });
  return owner ? from : null;
}

/** Why the second company can't be joined in now, or null. */
async function joinProblem(intoId: string, fromId: string, movingAt: Date | null): Promise<string | null> {
  if (movingAt) return "It is moving to another install.";
  if (await db.partnerLink.count({ where: { shopId: fromId } })) return "It has partner shops: end those partnerships first (they belong to it on StitchHub).";
  const clash = await db.$queryRaw<{ number: string }[]>`SELECT b."number" FROM "GiftCard" b JOIN "GiftCard" a ON a."number" = b."number" AND a."shopId" = ${intoId} WHERE b."shopId" = ${fromId} LIMIT 1`;
  if (clash.length) return `Gift card ${clash[0].number} is in both companies: change one of them first.`;
  return null;
}

export type JoinResult = { storeId: string; storeName: string; renumbered: number; renamedItems: number; loginsOff: number; maybeSame: { intoId: string; fromId: string; name: string }[] };

/**
 * Join the company whose join code this is (made by its owner while signed in there) into the signed-in owner's
 * company as a new store named `storeName` (default: its company name). The owner types the other company's name to
 * confirm. The code is used up by the join.
 */
export async function joinCompanyFor(user: CurrentUser, code: string, typedName: string, storeName?: string | null, now = new Date()): Promise<JoinResult> {
  if (user.role !== "OWNER") throw new UserError("Only the owner joins companies.");
  const from = await companyForCode(user, code, now);
  if (!from) throw new UserError("That join code isn't right or has run out. Sign in to the other company, make a new one under Settings, Stores, and type it here.");
  if (typedName.trim().toLowerCase() !== from.name.trim().toLowerCase()) throw new UserError(`Type ${from.name} to confirm.`);
  const problem = await joinProblem(user.shopId, from.id, from.movingAt);
  if (problem) throw new UserError(problem);
  const into = user.shopId;
  const name = (storeName?.trim() || from.name).slice(0, 60);
  if (await db.location.count({ where: { shopId: into, name: sameText(name) } })) throw new UserError(`A store is already called ${name}. Give the new store another name.`);

  const result = await db.$transaction(
    async (tx) => {
      // The code is used once (two tries at the same time can't both join).
      const used = await tx.shop.updateMany({ where: { id: from.id, joinCodeHash: hashJoinCode(code), joinCodeUntil: { gt: now }, movedOutAt: null }, data: { joinCodeHash: null, joinCodeUntil: null, joinCodeById: null } });
      if (!used.count) throw new UserError("That join code was used already. Make a new one in the other company.");
      // 1. The new store, from the second company's own details; its own stores come along (its main one is the new one).
      await ensureMainStore(tx, into);
      const order = await tx.location.count({ where: { shopId: into } });
      const store = await tx.location.create({
        data: { shopId: into, name, address: from.address, phone: from.phone, timeZone: from.timeZone, taxRatePct: from.taxRatePct, receiptFooter: from.receiptNote, hours: from.hoursNote, sortOrder: order },
      });
      const fromMain = await tx.location.findFirst({ where: { shopId: from.id, main: true }, select: { id: true } });
      const fromOthers = await tx.location.findMany({ where: { shopId: from.id, main: false }, select: { id: true, name: true } });
      for (const t of WITH_STORE) {
        await tx.$executeRawUnsafe(`UPDATE "${t}" SET "locationId" = $1 WHERE "shopId" = $2 AND ("locationId" IS NULL OR "locationId" = $3)`, store.id, from.id, fromMain?.id ?? "");
      }
      await tx.$executeRaw`UPDATE "StockTransfer" SET "fromId" = ${store.id} WHERE "shopId" = ${from.id} AND "fromId" = ${fromMain?.id ?? ""}`;
      await tx.$executeRaw`UPDATE "StockTransfer" SET "toId" = ${store.id} WHERE "shopId" = ${from.id} AND "toId" = ${fromMain?.id ?? ""}`;
      await tx.$executeRaw`UPDATE "StoreNote" SET "fromLocationId" = ${store.id} WHERE "shopId" = ${from.id} AND ("fromLocationId" IS NULL OR "fromLocationId" = ${fromMain?.id ?? ""})`;
      await tx.$executeRaw`UPDATE "StoreNote" SET "toLocationId" = ${store.id} WHERE "shopId" = ${from.id} AND "toLocationId" = ${fromMain?.id ?? ""}`;
      for (const o of fromOthers) {
        const clash = await tx.location.count({ where: { shopId: into, name: sameText(o.name) } });
        await tx.location.update({ where: { id: o.id }, data: { shopId: into, main: false, sortOrder: order + 1, ...(clash ? { name: `${o.name} (${name})`.slice(0, 60) } : {}) } });
      }

      // 2. The second company's stock is the new store's: in this company the main store's stock is the total less the
      // other stores' levels, so each item's own stock (less its other stores') becomes a level of the new store.
      await tx.$executeRaw`
        INSERT INTO "StockLevel" ("id", "shopId", "partId", "locationId", "qtyOnHand", "reorderAt", "bin", "updatedAt")
        SELECT 'lvl' || md5(random()::text || p."id"), ${from.id}, p."id", ${store.id},
               p."qtyOnHand" - COALESCE((SELECT SUM(l."qtyOnHand") FROM "StockLevel" l WHERE l."partId" = p."id"), 0), p."reorderAt", p."location", now()
        FROM "Part" p WHERE p."shopId" = ${from.id}
        ON CONFLICT ("partId", "locationId") DO NOTHING`;

      // 3. Numbers both companies use: the second's numbered on from the first's (to the next thousand).
      let renumbered = 0;
      const counters: Record<string, number> = {};
      for (const n of NUMBERED) {
        const [a] = await tx.$queryRawUnsafe<{ m: number | null }[]>(`SELECT MAX("number")::int AS m FROM "${n.table}" WHERE "shopId" = $1`, into);
        const [b] = await tx.$queryRawUnsafe<{ m: number | null; c: number }[]>(`SELECT MAX("number")::int AS m, COUNT(*)::int AS c FROM "${n.table}" WHERE "shopId" = $1`, from.id);
        if (!b.c) continue;
        const offset = a.m ? Math.ceil((a.m + 1) / 1000) * 1000 : 0;
        if (offset) {
          await tx.$executeRawUnsafe(`UPDATE "${n.table}" SET "number" = "number" + $1 WHERE "shopId" = $2`, offset, from.id);
          renumbered += b.c;
        }
        if (n.counter) counters[n.counter] = (b.m ?? 0) + offset + 1;
      }
      const intoShop = await tx.shop.findUniqueOrThrow({ where: { id: into } });
      const data: Record<string, number> = {};
      for (const [k, v] of Object.entries(counters)) if (v > Number((intoShop as unknown as Record<string, number>)[k] ?? 0)) data[k] = v;
      if (Object.keys(data).length) await tx.shop.update({ where: { id: into }, data });

      // 4. Names both companies use, made to fit.
      const tag = ` (${name})`;
      const items = await tx.$queryRaw<{ id: string; partNumber: string }[]>`SELECT b."id", b."partNumber" FROM "Part" b WHERE b."shopId" = ${from.id} AND EXISTS (SELECT 1 FROM "Part" a WHERE a."shopId" = ${into} AND lower(a."partNumber") = lower(b."partNumber"))`;
      for (const it of items) {
        let pn = `${it.partNumber}${tag}`.slice(0, 120);
        for (let i = 2; await tx.part.count({ where: { shopId: { in: [into, from.id] }, partNumber: sameText(pn) } }); i++) pn = `${it.partNumber}${tag} ${i}`.slice(0, 120);
        const p = await tx.part.findUniqueOrThrow({ where: { id: it.id }, select: { altNumbers: true } });
        await tx.part.update({ where: { id: it.id }, data: { partNumber: pn, altNumbers: [...new Set([...p.altNumbers, it.partNumber])] } });
      }
      for (const t of ["StarterBundle", "FitGroup"]) {
        await tx.$executeRawUnsafe(`UPDATE "${t}" b SET "name" = left(b."name" || $3, 120) WHERE b."shopId" = $1 AND EXISTS (SELECT 1 FROM "${t}" a WHERE a."shopId" = $2 AND a."name" = b."name")`, from.id, into, tag);
      }
      // The same supplier in both: one supplier, the second's orders on it.
      const sups = await tx.$queryRaw<{ bid: string; aid: string }[]>`SELECT b."id" AS bid, a."id" AS aid FROM "FabricSupplier" b JOIN "FabricSupplier" a ON a."shopId" = ${into} AND lower(a."name") = lower(b."name") WHERE b."shopId" = ${from.id}`;
      for (const s of sups) {
        await tx.purchaseOrder.updateMany({ where: { supplierId: s.bid }, data: { supplierId: s.aid } });
        await tx.fabricSupplier.delete({ where: { id: s.bid } });
      }
      // Kinds of machine and makers' warranty terms the first already has: the first's are kept.
      await tx.$executeRaw`DELETE FROM "ShopEquipmentKind" b WHERE b."shopId" = ${from.id} AND EXISTS (SELECT 1 FROM "ShopEquipmentKind" a WHERE a."shopId" = ${into} AND a."key" = b."key")`;
      await tx.$executeRaw`DELETE FROM "CardReader" b WHERE b."shopId" = ${from.id} AND EXISTS (SELECT 1 FROM "CardReader" a WHERE a."shopId" = ${into} AND a."readerId" = b."readerId")`;
      await tx.$executeRaw`DELETE FROM "MakerWarranty" b WHERE b."shopId" = ${from.id} AND EXISTS (SELECT 1 FROM "MakerWarranty" a WHERE a."shopId" = ${into} AND a."brandKey" = b."brandKey")`;
      // Messages and opt-outs the first already has (the same key or address): the first's stand.
      await tx.$executeRaw`DELETE FROM "OutMessage" b WHERE b."shopId" = ${from.id} AND b."dedupeKey" IS NOT NULL AND EXISTS (SELECT 1 FROM "OutMessage" a WHERE a."shopId" = ${into} AND a."dedupeKey" = b."dedupeKey")`;
      await tx.$executeRaw`DELETE FROM "Suppression" b WHERE b."shopId" = ${from.id} AND EXISTS (SELECT 1 FROM "Suppression" a WHERE a."shopId" = ${into} AND a."channel" = b."channel" AND a."address" = b."address")`;
      // Logins the first already has (the owner's own, someone at both): kept for the history, switched off.
      const dupLogins = await tx.$queryRaw<{ id: string; email: string; name: string }[]>`SELECT b."id", b."email", b."name" FROM "User" b WHERE b."shopId" = ${from.id} AND EXISTS (SELECT 1 FROM "User" a WHERE a."shopId" = ${into} AND lower(a."email") = lower(b."email"))`;
      for (const u of dupLogins) {
        await tx.user.update({ where: { id: u.id }, data: { active: false, sessionVersion: { increment: 1 }, email: `joined-${crypto.randomBytes(4).toString("hex")}-${u.email}`.slice(0, 200), name: `${u.name} (${name})`.slice(0, 120) } });
      }

      // 5. Every other row comes over as it is (the tables the company file carries; the rest stay with the second company).
      for (const t of MOVE_TABLES) {
        if (t.via || STAY.has(t.t)) continue;
        await tx.$executeRawUnsafe(`UPDATE "${t.t}" SET "shopId" = $1 WHERE "shopId" = $2`, into, from.id);
      }

      // 6. The second company is closed: read-only, saying where it went.
      await tx.shop.update({ where: { id: from.id }, data: { movingAt: now, movedOutAt: now, movedTo: `Joined into ${(await tx.shop.findUniqueOrThrow({ where: { id: into }, select: { name: true } })).name} as the ${name} store` } });
      await tx.location.deleteMany({ where: { shopId: from.id } });
      await audit(tx, actorOf(user), { action: "store.join", subjectType: "Location", subjectId: store.id, subjectLabel: `${from.name} joined in as ${name}` });
      return { storeId: store.id, storeName: name, renumbered, renamedItems: items.length, loginsOff: dupLogins.length };
    },
    { timeout: 180_000, maxWait: 20_000 },
  );
  return { ...result, maybeSame: await maybeSameCustomers(into, result.storeId) };
}

/** Customers at a joined store who may be the same person as one at another store (Settings -> Stores lists them). */
export async function sameCustomersFor(user: CurrentUser, storeId: string): Promise<{ intoId: string; fromId: string; name: string }[]> {
  if (user.role === "TECH") return [];
  const s = await db.location.findFirst({ where: { id: storeId, shopId: user.shopId, main: false }, select: { id: true } });
  return s ? maybeSameCustomers(user.shopId, s.id) : [];
}

/**
 * Customers who may be the same person at both (the same email, or the same phone digits, or the same name): one from
 * the joined store's (whose first record is at that store) and one from the rest. Never merged by themselves: each is
 * offered to the existing customer merge.
 */
async function maybeSameCustomers(shopId: string, storeId: string): Promise<{ intoId: string; fromId: string; name: string }[]> {
  // The joined company's customers are those first seen at the new store: its rows carry its locationId.
  const joined = new Set((await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c."id" FROM "Customer" c
    WHERE c."shopId" = ${shopId} AND (
      EXISTS (SELECT 1 FROM "Sale" s WHERE s."customerId" = c."id" AND s."locationId" = ${storeId})
      OR EXISTS (SELECT 1 FROM "Ticket" t WHERE t."customerId" = c."id" AND t."locationId" = ${storeId}))`).map((r) => r.id));
  if (!joined.size) return [];
  const all = await db.customer.findMany({ where: { shopId }, select: { id: true, name: true, email: true, phone: true } });
  const digits = (p: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);
  const out: { intoId: string; fromId: string; name: string }[] = [];
  for (const b of all.filter((c) => joined.has(c.id))) {
    const twin = all.find(
      (a) =>
        !joined.has(a.id) &&
        ((b.email && a.email && a.email.toLowerCase() === b.email.toLowerCase()) || (digits(b.phone).length === 10 && digits(a.phone) === digits(b.phone)) || a.name.trim().toLowerCase() === b.name.trim().toLowerCase()),
    );
    if (twin) out.push({ intoId: twin.id, fromId: b.id, name: b.name });
    if (out.length >= 200) break;
  }
  return out;
}
