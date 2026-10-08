import "server-only";
// Help switching (shop-features-round-2-design.md 4.7): "From Square", "From Rain or Like Sew", "From QuickBooks Point of
// Sale". Choose one, open the exported file, see what will come in, "Bring them in". Items go through the spreadsheet
// import (src/lib/inventory-import.ts: new items added, ones here by number updated, stock received); customers are
// matched by email or phone (missing details filled, nothing overwritten) with what they spent there in their notes;
// gift card balances become existing cards (OPENING on the ledger) under their own numbers, so customers' cards keep
// working. Owners and admins. Every query by shopId.
import { db } from "@/lib/db";
import { UserError, isUserError } from "@/lib/user-error";
import type { CurrentUser } from "@/lib/session";
import { requireBaseWritable } from "@/lib/base-gate";
import { actorOf, audit } from "@/lib/audit";
import { parseTable } from "@/lib/parse-table";
import { toE164, validEmail } from "@/lib/phone";
import { numberKey } from "@/lib/parts";
import { runImport } from "@/lib/inventory-import";
import { addExistingCardAs } from "@/lib/gift-cards";
import { parseCardNumber } from "@/lib/gift-card-number";
import { KINDS, SYSTEMS, missingColumns, readCards, readCustomers, readItems, type Kind, type System } from "@/lib/switch/formats";

const MAX_ROWS = 20_000;
const MAX_TEXT = 12 * 1024 * 1024;

function admin(user: CurrentUser) {
  if (user.role === "TECH") throw new UserError("Only an owner or admin can bring in another system's records.");
}

function tableOf(text: string): string[][] {
  if (typeof text !== "string" || !text.trim()) throw new UserError("Open the exported file first.");
  if (text.length > MAX_TEXT) throw new UserError("That file is too big for one go: export it in parts (by category or by letter).");
  const t = parseTable(text);
  if (t.length < 2) throw new UserError("The file has no rows under its header.");
  if (t.length > MAX_ROWS + 1) throw new UserError(`Up to ${MAX_ROWS.toLocaleString("en-US")} rows at a time: export it in parts.`);
  return t;
}

function read(system: System, kind: Kind, table: string[][]) {
  const r = kind === "items" ? readItems(system, table) : kind === "customers" ? readCustomers(system, table) : readCards(system, table);
  const missing = missingColumns(kind, r.cols);
  if (missing) throw new UserError(missing);
  return r;
}

export type SwitchPreview = {
  system: string;
  kind: string;
  total: number;
  fresh: number;
  already: number;
  sample: string[][];
  sampleHead: string[];
  problems: string[];
  /** The file's columns that were read, in shop words. */
  found: string[];
};

/** "See what will come in": the rows read, how many are new and how many are already here, the first ten, the problems. */
export async function previewSwitch(user: CurrentUser, system: string, kind: string, text: string): Promise<SwitchPreview> {
  admin(user);
  if (!(system in SYSTEMS) || !(kind in KINDS)) throw new UserError("Choose the system and what's in the file.");
  const s = system as System;
  const k = kind as Kind;
  const table = tableOf(text);
  const head = table[0];
  const shopId = user.shopId;
  const base = { system: SYSTEMS[s], kind: KINDS[k] };
  if (k === "items") {
    const r = read(s, k, table) as ReturnType<typeof readItems>;
    const keys = await db.part.findMany({ where: { shopId }, select: { numberKeys: true } });
    const have = new Set(keys.flatMap((p) => p.numberKeys));
    const already = r.rows.filter((x) => have.has(numberKey(x.partNumber)) || (x.barcode && have.has(numberKey(x.barcode)))).length;
    return {
      ...base,
      total: r.rows.length,
      fresh: r.rows.length - already,
      already,
      sampleHead: ["Number", "Name", "Price", "Cost", "On hand"],
      sample: r.rows.slice(0, 10).map((x) => [x.partNumber, x.description, x.priceCents == null ? "" : `$${(x.priceCents / 100).toFixed(2)}`, x.costCents == null ? "" : `$${(x.costCents / 100).toFixed(2)}`, x.qty == null ? "" : String(x.qty)]),
      problems: r.problems.slice(0, 50),
      found: Object.entries(r.cols).filter(([, i]) => i >= 0).map(([f, i]) => `${f}: ${head[i]}`),
    };
  }
  if (k === "customers") {
    const r = read(s, k, table) as ReturnType<typeof readCustomers>;
    const { byEmail, byPhone } = await customerIndex(shopId);
    const already = r.rows.filter((x) => matchOf(x, byEmail, byPhone)).length;
    return {
      ...base,
      total: r.rows.length,
      fresh: r.rows.length - already,
      already,
      sampleHead: ["Name", "Email", "Phone", "History"],
      sample: r.rows.slice(0, 10).map((x) => [x.name, x.email ?? "", x.phone ?? "", x.history ?? ""]),
      problems: r.problems.slice(0, 50),
      found: Object.entries(r.cols).filter(([, i]) => i >= 0).map(([f, i]) => `${f}: ${head[i]}`),
    };
  }
  const r = read(s, k, table) as ReturnType<typeof readCards>;
  const have = new Set((await db.giftCard.findMany({ where: { shopId }, select: { number: true } })).map((c) => c.number.replace(/-/g, "")));
  const already = r.rows.filter((x) => have.has(x.number)).length;
  return {
    ...base,
    total: r.rows.length,
    fresh: r.rows.length - already,
    already,
    sampleHead: ["Card", "Balance"],
    sample: r.rows.slice(0, 10).map((x) => [x.number, `$${(x.balanceCents / 100).toFixed(2)}`]),
    problems: r.problems.slice(0, 50),
    found: Object.entries(r.cols).filter(([, i]) => i >= 0).map(([f, i]) => `${f}: ${head[i]}`),
  };
}

async function customerIndex(shopId: string) {
  const existing = await db.customer.findMany({ where: { shopId }, select: { id: true, email: true, phone: true, address: true, notes: true } });
  const byEmail = new Map<string, (typeof existing)[number]>();
  const byPhone = new Map<string, (typeof existing)[number]>();
  for (const c of existing) {
    const e = validEmail(c.email);
    const p = toE164(c.phone);
    if (e && !byEmail.has(e)) byEmail.set(e, c);
    if (p && !byPhone.has(p)) byPhone.set(p, c);
  }
  return { byEmail, byPhone };
}

function matchOf<T>(x: { email: string | null; phone: string | null }, byEmail: Map<string, T>, byPhone: Map<string, T>): T | null {
  const e = validEmail(x.email);
  const p = toE164(x.phone);
  return (e && byEmail.get(e)) || (p && byPhone.get(p)) || null;
}

export type SwitchOptions = { itemKind?: string | null; addQty?: boolean };

/** "Bring them in": writes what the preview showed. Returns what happened, in words. */
export async function applySwitchFor(user: CurrentUser, system: string, kind: string, text: string, o: SwitchOptions = {}): Promise<string> {
  admin(user);
  await requireBaseWritable(user);
  if (!(system in SYSTEMS) || !(kind in KINDS)) throw new UserError("Choose the system and what's in the file.");
  const s = system as System;
  const k = kind as Kind;
  const table = tableOf(text);
  const shopId = user.shopId;
  const from = SYSTEMS[s];
  if (k === "items") {
    const r = read(s, k, table) as ReturnType<typeof readItems>;
    if (!r.rows.length) throw new UserError("No items could be read from the file.");
    const res = await runImport(
      shopId,
      user.id,
      r.rows.map((x) => ({ partNumber: x.partNumber, barcode: x.barcode, description: x.description, brand: x.brand, costCents: x.costCents != null && x.costCents >= 0 ? x.costCents : null, priceCents: x.priceCents != null && x.priceCents >= 0 ? x.priceCents : null, qty: x.qty })),
      { kind: o.itemKind || "NOTION", unit: null, supplier: null, addQty: o.addQty !== false, updateExisting: true },
    );
    // The supplier each row names, on items that have none yet.
    const bySupplier = new Map<string, string[]>();
    for (const x of r.rows) if (x.supplier) bySupplier.set(x.supplier.slice(0, 120), [...(bySupplier.get(x.supplier.slice(0, 120)) ?? []), x.partNumber]);
    for (const [supplier, numbers] of bySupplier) await db.part.updateMany({ where: { shopId, partNumber: { in: numbers }, supplier: null }, data: { supplier } });
    await audit(db, actorOf(user), { action: "import.items", subjectType: "Items", subjectLabel: `From ${from}: ${res.added} added, ${res.updated} updated, ${res.skipped} skipped`, changes: { added: [0, res.added], updated: [0, res.updated], skipped: [0, res.skipped] } });
    return `From ${from}: ${res.added} item${res.added === 1 ? "" : "s"} added, ${res.updated} updated${res.skipped ? `, ${res.skipped} left out` : ""}.${r.problems.length ? ` ${r.problems.length} row${r.problems.length === 1 ? "" : "s"} couldn't be read.` : ""}`;
  }
  if (k === "customers") {
    const r = read(s, k, table) as ReturnType<typeof readCustomers>;
    const { byEmail, byPhone } = await customerIndex(shopId);
    let added = 0;
    let matched = 0;
    for (const x of r.rows) {
      const email = validEmail(x.email);
      const phone = x.phone ? x.phone.slice(0, 40) : null;
      const notes = [x.notes, x.history].filter(Boolean).join("\n") || null;
      const hit = matchOf(x, byEmail, byPhone);
      if (hit) {
        matched += 1;
        await db.customer.updateMany({
          where: { id: hit.id, shopId },
          data: {
            ...(email && !hit.email ? { email } : {}),
            ...(phone && !hit.phone ? { phone } : {}),
            ...(x.address && !hit.address ? { address: x.address } : {}),
            ...(notes && !(hit.notes ?? "").includes(x.history ?? notes) ? { notes: [hit.notes, notes].filter(Boolean).join("\n").slice(0, 4000) } : {}),
          },
        });
        continue;
      }
      const c = await db.customer.create({ data: { shopId, kind: "RETAIL", name: x.name, email, phone, address: x.address, notes: notes?.slice(0, 4000) ?? null, notifyBy: "" }, select: { id: true, email: true, phone: true, address: true, notes: true } });
      if (email) byEmail.set(email, c);
      const p = toE164(phone);
      if (p) byPhone.set(p, c);
      added += 1;
    }
    await audit(db, actorOf(user), { action: "import.customers", subjectType: "Customers", subjectLabel: `From ${from}: ${added} added, ${matched} already here`, changes: { added: [0, added], matched: [0, matched] } });
    return `From ${from}: ${added} customer${added === 1 ? "" : "s"} added, ${matched} already here (missing details filled in).${r.problems.length ? ` ${r.problems.length} row${r.problems.length === 1 ? "" : "s"} couldn't be read.` : ""} Nobody was signed up for marketing: ask each customer first.`;
  }
  const r = read(s, k, table) as ReturnType<typeof readCards>;
  const { byEmail } = await customerIndex(shopId);
  let added = 0;
  let total = 0;
  const not: string[] = [];
  for (const x of r.rows) {
    if (parseCardNumber(x.number).kind === "none") {
      not.push(`${x.number}: not a card number we can keep (6 to 24 letters and digits)`);
      continue;
    }
    try {
      const owner = x.email ? byEmail.get(validEmail(x.email) ?? "") : undefined;
      await addExistingCardAs(user, { number: x.number, amountCents: x.balanceCents, customerId: owner?.id ?? null });
      added += 1;
      total += x.balanceCents;
    } catch (e) {
      if (!isUserError(e)) {
        if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
          not.push(`${x.number}: already here`);
          continue;
        }
        throw e;
      }
      not.push(`${x.number}: ${e.message}`);
    }
  }
  return `From ${from}: ${added} gift card${added === 1 ? "" : "s"} added with $${(total / 100).toFixed(2)} on them.${not.length ? ` Not added: ${not.slice(0, 10).join("; ")}${not.length > 10 ? `, and ${not.length - 10} more` : ""}.` : ""}`;
}
