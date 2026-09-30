// What a tech may and may not do (signed in as the E2E shop's tech from scripts/e2e-setup.ts): no People or company
// settings, no Companies; a part's cost, price and partner price stay as the owner set them; no refunds, no removing a
// payment, no voiding a sale; a collected ticket's bill is locked; and the status dates (ready, closed, warranty) are set
// and cleared as the status changes. The rows it uses are made here (the ticket through the intake form, as a tech would)
// and taken away at the end, so the E2E shop is left as it was found.
import { test, expect, type Page } from "@playwright/test";
import { disconnect, expectRefused, insert, login, one, OWNER, remove, RUN, shopOf, sql, TECH } from "./helpers";

test.describe.configure({ mode: "serial" });

const serial = `ROLE${RUN}`;
let page: Page;
let shopId: string;
let partId: string;
let saleId: string;
let ticketId: string | null = null;

type Dates = { readyAt: Date | null; closedAt: Date | null; warrantyUntil: Date | null };
// The columns are timestamps without a zone holding UTC (Prisma's way); read as such, or pg takes them for local time.
const dates = () =>
  one<Dates>(`SELECT "readyAt" AT TIME ZONE 'UTC' AS "readyAt", "closedAt" AT TIME ZONE 'UTC' AS "closedAt", "warrantyUntil" AT TIME ZONE 'UTC' AS "warrantyUntil" FROM "Ticket" WHERE id = $1`, [ticketId]);
const button = (title: string) => page.locator(`button[title="${title}"]`).first();

test.beforeAll(async ({ browser }) => {
  const tech = await shopOf(TECH);
  expect(tech.role, "the E2E tech is a TECH").toBe("TECH");
  shopId = tech.shopId;
  expect((await shopOf(OWNER)).shopId, "the tech is in the E2E shop").toBe(shopId);
  partId = (
    await insert<{ id: string }>("Part", {
      shopId,
      partNumber: `ROLE-${RUN}`,
      description: "Role test part",
      qtyOnHand: 2,
      costCents: 500,
      priceCents: 900,
      wholesaleCents: 700,
      offerToPartners: false,
      altNumbers: [],
      numberKeys: [`ROLE${RUN}`],
    })
  ).id;
  const top = await one<{ max: number | null }>(`SELECT MAX(number) AS max FROM "Sale" WHERE "shopId" = $1`, [shopId]);
  saleId = (
    await insert<{ id: string }>("Sale", {
      shopId,
      number: (top?.max ?? 1000) + 1,
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
      taxRatePct: 0,
      tenders: JSON.stringify([{ method: "CASH", amountCents: 1000 }]),
      note: `Role test ${RUN}`,
    })
  ).id;
  page = await login(browser, TECH);
});

test.afterAll(async () => {
  await page?.context().close();
  if (ticketId) {
    const t = await one<{ machineId: string; customerId: string | null }>(`SELECT "machineId", "customerId" FROM "Ticket" WHERE id = $1`, [ticketId]);
    await remove("Ticket", ticketId);
    if (t) {
      await remove("Machine", t.machineId);
      if (t.customerId) await remove("Customer", t.customerId);
    }
  }
  if (partId) await remove("Part", partId);
  if (saleId) await remove("Sale", saleId);
  await disconnect();
});

test("a tech has no People, company settings or Companies", async () => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add person" })).toHaveCount(0);
  await expect(page.getByText("What this company does")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Leave the hub" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Companies" })).toHaveCount(0);
  const r = await page.goto("/companies");
  expect(r?.status()).toBe(404);
});

test("a tech's save keeps a part's cost, price and partner price as they were", async () => {
  await page.goto(`/parts/${partId}`);
  for (const id of ["#cost", "#price", "#wholesale"]) await expect(page.locator(id)).toBeDisabled();
  await expect(page.locator('input[name="offerToPartners"]')).toBeDisabled();
  // Typed anyway (a crafted form would): the server keeps the money fields and saves the rest.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLInputElement>("#cost, #price, #wholesale, input[name=offerToPartners]")) el.disabled = false;
  });
  await page.locator("#cost").fill("1.00");
  await page.locator("#price").fill("99.00");
  await page.locator("#wholesale").fill("2.00");
  await page.locator('input[name="offerToPartners"]').check();
  await page.locator("#description").fill(`Role test part, described by the tech ${RUN}`);
  await page.locator("form", { has: page.locator("#description") }).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const p = await one<{ description: string; costCents: number; priceCents: number; wholesaleCents: number; offerToPartners: boolean }>(
    `SELECT description, "costCents", "priceCents", "wholesaleCents", "offerToPartners" FROM "Part" WHERE id = $1`,
    [partId],
  );
  expect(p?.description).toBe(`Role test part, described by the tech ${RUN}`);
  expect(p?.costCents).toBe(500);
  expect(p?.priceCents).toBe(900);
  expect(p?.wholesaleCents).toBe(700);
  expect(p?.offerToPartners).toBe(false);
});

test("a tech can bill and take payment, but not refund, remove a payment or void a sale", async () => {
  await page.goto("/tickets/new");
  await page.getByLabel("New customer name").fill(`Role Customer ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("Janome");
  await page.getByLabel("Model", { exact: true }).fill("MC6700P");
  await page.getByLabel("Serial number", { exact: true }).fill(serial);
  await page.getByLabel("Problem reported", { exact: true }).fill("Role test: skipping stitches");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Janome MC6700P/ })).toBeVisible();
  ticketId = new URL(page.url()).pathname.split("/").pop()!;
  expect(ticketId).toMatch(/^c[a-z0-9]{20,}$/);

  await page.getByLabel("Custom description").fill("Timing (role test)");
  await page.getByLabel("Price", { exact: true }).fill("50.00");
  await page.getByRole("button", { name: "Add service" }).click();
  await expect(page.getByText("Timing (role test)")).toBeVisible();
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Payment recorded")).toBeVisible();
  await expect(page.locator("#amount")).toHaveValue(""); // paid up

  // Money back is the owner's or an admin's call, either way it's written.
  await page.locator("#amount").fill("-5.00");
  await page.getByRole("button", { name: "Record payment" }).click();
  await expectRefused(page, "Only the shop owner or an admin can record a refund.");
  await button("Remove payment").click();
  await button("Remove payment").click(); // the second tap confirms
  await expectRefused(page, "Only the shop owner or an admin can change this.");
  const payments = await sql<{ amountCents: number }>(`SELECT "amountCents" FROM "Payment" WHERE "ticketId" = $1`, [ticketId]);
  expect(payments).toHaveLength(1);
  expect(payments[0].amountCents).toBeGreaterThan(0);

  // A register sale can't be voided by a tech: the receipt offers no void.
  const r = await page.goto(`/register/sales/${saleId}`);
  expect(r?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Sale #/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Void sale" })).toHaveCount(0);
  await expect(page.locator("#reason")).toHaveCount(0);
  expect((await one<{ status: string }>(`SELECT status FROM "Sale" WHERE id = $1`, [saleId]))?.status).toBe("COMPLETED");
});

test("status changes set the dates, and a collected ticket's bill is locked for a tech", async () => {
  expect(ticketId, "the ticket from the previous test").not.toBeNull();
  await page.goto(`/tickets/${ticketId}`);
  const d0 = await dates();
  expect(d0).toEqual({ readyAt: null, closedAt: null, warrantyUntil: null });

  // Ready: the storage-fee clock starts; nothing is closed yet.
  await page.locator("#status").selectOption("READY_FOR_PICKUP");
  await expect(page.getByText("Status: Ready - customer called")).toBeVisible();
  const d1 = await dates();
  expect(d1?.readyAt).toBeInstanceOf(Date);
  expect(d1?.closedAt).toBeNull();
  expect(d1?.warrantyUntil).toBeNull();

  // Collected: closed today, warranty from the shop's warranty days, still marked ready.
  await page.locator("#status").selectOption("COLLECTED");
  await expect(page.getByText("Status: Collected by customer")).toBeVisible();
  const d2 = await dates();
  expect(d2?.readyAt?.getTime()).toBe(d1?.readyAt?.getTime());
  expect(d2?.closedAt).toBeInstanceOf(Date);
  expect(Math.abs(d2!.closedAt!.getTime() - Date.now())).toBeLessThan(5 * 60_000);
  const shop = await one<{ warrantyDays: number }>(`SELECT "warrantyDays" FROM "Shop" WHERE id = $1`, [shopId]);
  expect(d2!.warrantyUntil!.getTime() - d2!.closedAt!.getTime()).toBe(shop!.warrantyDays * 86_400_000);
  await page.reload();
  await expect(page.locator("#status")).toHaveValue("COLLECTED");
  await expect(page.getByText("Warranty until")).toBeVisible();

  // The bill of a closed ticket is the owner's or an admin's to change.
  const linesBefore = await sql(`SELECT id FROM "TicketLine" WHERE "ticketId" = $1`, [ticketId]);
  await button("Remove line").click();
  await button("Remove line").click();
  await expectRefused(page, "The ticket is closed: only the owner or an admin can change its bill.");
  await page.locator('input[name="price"][aria-label="Amount"]').fill("5.00");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expectRefused(page, "The ticket is closed: only the owner or an admin can change its bill.");
  await page.getByLabel("Custom description").fill("After closing");
  await page.getByLabel("Price", { exact: true }).fill("10.00");
  await page.getByRole("button", { name: "Add service" }).click();
  await expectRefused(page, "The ticket is closed: only the owner or an admin can change its bill.");
  expect(await sql(`SELECT id FROM "TicketLine" WHERE "ticketId" = $1`, [ticketId])).toEqual(linesBefore);

  // Opened again (a mis-click): no longer closed, no warranty, not ready either.
  await page.locator("#status").selectOption("ON_BENCH");
  await expect(page.getByText("Status: On bench")).toBeVisible();
  expect(await dates()).toEqual({ readyAt: null, closedAt: null, warrantyUntil: null });
  // A tech may change the bill again.
  await page.locator('input[name="price"][aria-label="Amount"]').fill("5.00");
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.locator("table tr").filter({ hasText: "Fee" }).filter({ hasText: "$5.00" })).toBeVisible();
  expect(await sql(`SELECT id FROM "TicketLine" WHERE "ticketId" = $1`, [ticketId])).toHaveLength(linesBefore.length + 1);
});
