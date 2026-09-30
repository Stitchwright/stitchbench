// Creates (or resets the passwords of) the throwaway companies and logins the Playwright specs sign in as. Safe to run
// again: nothing is made twice, and each password is set back to what the specs expect.
//   - The E2E shop ("E2E Test Shop"): its owner (E2E_EMAIL, used by every spec) and a tech (E2E_TECH_EMAIL, for
//     tests/roles.spec.ts). The shop's own records are left alone: the specs make what they need.
//   - A second company ("E2E Other Shop") with its owner (E2E_OTHER_EMAIL) and a customer, a machine, a ticket (one
//     line, one payment, one photo) and a part, for tests/tenant.spec.ts, which tries the E2E shop's ids from it. It is
//     made the way Companies / sign-up make one (src/lib/shops.ts createShopWithOwner: the default checklist, the
//     service menu without prices, the server's time zone), without importing that server-only module.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { normalizeEmail } from "../src/lib/email";
import { modelKey } from "../src/lib/format";
import { DEFAULT_CHECKLIST, DEFAULT_SERVICE_MENU } from "../src/lib/service-menu";
import { serverTimeZone } from "../src/lib/time-zone";

type Role = "OWNER" | "ADMIN" | "TECH";

/** What the other shop's records are called, so a spec (or a person in the app) can find them. */
export const OTHER_SHOP = {
  name: "E2E Other Shop",
  customer: "Other Shop Customer",
  serial: "OTHER-0001",
  ticketNumber: 1,
  partNumber: "OTHER-001",
};

// 1x1 PNG, the photo on the other shop's ticket
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** A login in `shopId` with this password and role: made, or set back to that. Refuses an email that belongs to another shop. */
async function ensureUser(shopId: string, email: string, name: string, role: Role, password: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await db.user.findUnique({ where: { email }, select: { id: true, shopId: true } });
  if (existing) {
    if (existing.shopId !== shopId) throw new Error(`${email} already belongs to another shop; pick another email or remove that login.`);
    await db.user.update({ where: { email }, data: { passwordHash, active: true, role } });
    return existing.id;
  }
  return (await db.user.create({ data: { shopId, email, name, role, passwordHash }, select: { id: true } })).id;
}

/** The company `email` owns, made with its owner login when there is none. */
async function ensureShop(email: string, ownerName: string, password: string, shopName: string, menuPrices: boolean) {
  const owner = await db.user.findUnique({ where: { email }, select: { shopId: true } });
  if (owner) {
    await ensureUser(owner.shopId, email, ownerName, "OWNER", password);
    return owner.shopId;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const shop = await db.shop.create({
    data: {
      name: shopName,
      timeZone: serverTimeZone() ?? undefined,
      checklistItems: DEFAULT_CHECKLIST,
      users: { create: { email, name: ownerName, role: "OWNER", passwordHash } },
      serviceItems: { create: DEFAULT_SERVICE_MENU.map((s, i) => ({ name: s.name, priceCents: menuPrices ? s.priceCents : 0, sortOrder: i })) },
    },
    select: { id: true },
  });
  return shop.id;
}

/** The other shop's few records, each made once. */
async function ensureOtherRecords(shopId: string) {
  const customer =
    (await db.customer.findFirst({ where: { shopId, name: OTHER_SHOP.customer }, select: { id: true } })) ??
    (await db.customer.create({ data: { shopId, name: OTHER_SHOP.customer, phone: "555-0100" }, select: { id: true } }));
  const machine =
    (await db.machine.findFirst({ where: { shopId, serial: OTHER_SHOP.serial }, select: { id: true } })) ??
    (await db.machine.create({
      data: { shopId, brand: "Janome", model: "MC6700P", modelKey: modelKey("MC6700P"), serial: OTHER_SHOP.serial, customerId: customer.id },
      select: { id: true },
    }));
  const ticket =
    (await db.ticket.findFirst({ where: { shopId, number: OTHER_SHOP.ticketNumber }, select: { id: true } })) ??
    (await db.ticket.create({
      data: {
        shopId,
        number: OTHER_SHOP.ticketNumber,
        machineId: machine.id,
        customerId: customer.id,
        status: "ON_BENCH",
        serviceRequested: "Clean, oil and adjust",
        problem: "Noisy, skipping stitches",
        accessories: ["Power cord"],
      },
      select: { id: true },
    }));
  if (!(await db.ticketLine.count({ where: { ticketId: ticket.id } }))) {
    await db.ticketLine.create({ data: { ticketId: ticket.id, kind: "SERVICE", description: "Clean, oil and adjust", qty: 1, unitPriceCents: 8900 } });
  }
  if (!(await db.payment.count({ where: { ticketId: ticket.id } }))) {
    await db.payment.create({ data: { ticketId: ticket.id, method: "CASH", amountCents: 2000, note: "Deposit" } });
  }
  if (!(await db.machinePhoto.count({ where: { machineId: machine.id } }))) {
    await db.machinePhoto.create({ data: { shopId, machineId: machine.id, ticketId: ticket.id, mime: "image/png", data: PNG, caption: "As it came in" } });
  }
  const part =
    (await db.part.findFirst({ where: { shopId, partNumber: OTHER_SHOP.partNumber }, select: { id: true } })) ??
    (await db.part.create({
      data: {
        shopId,
        partNumber: OTHER_SHOP.partNumber,
        description: "Bobbin case (other shop)",
        fits: "MC6700P",
        qtyOnHand: 4,
        costCents: 1000,
        priceCents: 1999,
        numberKeys: [OTHER_SHOP.partNumber.replace(/[^A-Z0-9]/g, "")],
      },
      select: { id: true },
    }));
  return { customer: customer.id, machine: machine.id, ticket: ticket.id, part: part.id };
}

async function main() {
  // The E2E shop and its owner, as before (the shop was made with the menu's prices; a new one gets them too).
  const email = normalizeEmail(process.env.E2E_EMAIL ?? "e2e@stitchbench.test");
  const password = process.env.E2E_PASSWORD ?? "e2e-password-1";
  const e2eShopId = await ensureShop(email, "E2E Tech", password, "E2E Test Shop", true);
  console.log(`E2E user ready: ${email}`);

  // A tech in the E2E shop.
  const techEmail = normalizeEmail(process.env.E2E_TECH_EMAIL ?? "e2e-tech@stitchbench.test");
  await ensureUser(e2eShopId, techEmail, "E2E Bench Tech", "TECH", process.env.E2E_TECH_PASSWORD ?? "e2e-password-1");
  console.log(`E2E tech ready: ${techEmail}`);

  // The second company, its owner and its records.
  const otherEmail = normalizeEmail(process.env.E2E_OTHER_EMAIL ?? "e2e-other@stitchbench.test");
  const otherShopId = await ensureShop(otherEmail, "Other Owner", process.env.E2E_OTHER_PASSWORD ?? "e2e-password-1", OTHER_SHOP.name, false);
  if (otherShopId === e2eShopId) throw new Error(`${otherEmail} is in the E2E shop; the other owner needs a shop of its own.`);
  const ids = await ensureOtherRecords(otherShopId);
  console.log(`E2E other shop ready: ${otherEmail} (${OTHER_SHOP.name}) customer ${ids.customer} machine ${ids.machine} ticket ${ids.ticket} part ${ids.part}`);
}
main().finally(() => db.$disconnect());
