// Layaway (tax-machine-sales-layaway-design.md section 4). Runs on a TEST BUILD. A throwaway counter company: a machine
// and an item held at the register for a customer with a deposit, a payment taken, then picked up as one sale at that
// day's tax (the rate changed in between) with the payments taken off; /layaways, the layaway's page and the printed
// terms; and a second layaway cancelled by the shop's fee rule (a $10 fee, the rest back as store credit). The company is
// removed at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, one, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Layaway ${RUN}`;
const owner = { email: `layaway-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const who = `Lena Layaway ${RUN}`;
const brand = "Brother";
const model = `Hold ${RUN}`;
const serial = `LW${RUN}`;
const unitText = `${brand} ${model} (New) S/N ${serial}`;
const notion = `LWN${RUN}`;
const notion2 = `LWC${RUN}`;
let shopId: string;
let customerId: string;
let admin: Page;
let page: Page;
let layawayId: string;
let layawayNo: number;
const made: string[] = [];

async function createCompany(name: string, kind: string, ownerName: string, email: string): Promise<string> {
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(name);
  await admin.getByLabel("Kind of shop").selectOption(kind);
  await admin.getByLabel("Owner's name").fill(ownerName);
  await admin.getByLabel("Owner's email (their login)").fill(email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  const id = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [name]))[0].id;
  made.push(id);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true, "taxRatePct" = 6 WHERE id = $1`, [id]);
  return id;
}

const toast = (p: Page, text: string | RegExp) => p.locator("[data-sonner-toast]").filter({ hasText: text }).first();

async function pickCustomer(p: Page, name: string) {
  await p.locator("#register-customer").fill(name);
  await p.getByRole("listitem").getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(p.getByRole("button", { name: "change", exact: true })).toBeVisible();
}

async function scan(p: Page, code: string, description: string) {
  await p.locator("#register-code").fill(code);
  await p.locator("#register-code").press("Enter");
  await expect(p.getByRole("table", { name: "Sale" })).toContainText(description);
}

/** The after-sale panel a layaway's own sale leaves: its number and receipt address. */
async function doneSale(p: Page) {
  const done = p.getByRole("status").filter({ hasText: /Sale #\d+ done/ });
  await expect(done).toBeVisible();
  const number = Number(/Sale #(\d+) done/.exec((await done.textContent()) ?? "")![1]);
  const receipt = (await done.getByRole("link", { name: "Print receipt" }).getAttribute("href"))!;
  return { number, receipt };
}

/** The register's Layaway panel (the button opens it). */
async function openLayawayPanel(p: Page) {
  await p.getByRole("button", { name: "Layaway", exact: true }).click();
  const panel = p.locator('[aria-label="Layaway"]');
  await expect(panel).toBeVisible();
  return panel;
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  shopId = await createCompany(company, "retail", "Lay Owner", owner.email);
  customerId = (await insert<{ id: string }>("Customer", { shopId, name: who, phone: "5550122" })).id;
  await insert("Part", { shopId, partNumber: notion, numberKeys: [notion], description: `Spec bobbins ${RUN}`, kind: "NOTION", priceCents: 2000, qtyOnHand: 5 });
  await insert("Part", { shopId, partNumber: notion2, numberKeys: [notion2], description: `Spec cutter ${RUN}`, kind: "NOTION", priceCents: 10000, qtyOnHand: 3 });
  page = await login(browser, owner);
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await page?.context().close();
  await admin?.context().close();
});

test("start a layaway at the register: a machine and an item held, a $100 deposit", async () => {
  // A $500 machine for sale.
  await page.goto("/units");
  await page.locator("#ru-brand").fill(brand);
  await page.locator("#ru-model").fill(model);
  await page.locator("#ru-serials").fill(serial);
  await page.locator("#ru-price").fill("500.00");
  await page.getByRole("button", { name: "Add to stock", exact: true }).click();
  await expect(page.getByRole("link", { name: `${brand} ${model}`, exact: true })).toBeVisible();

  await page.goto("/register");
  await pickCustomer(page, who);
  await page.getByRole("button", { name: "Machine for sale", exact: true }).click();
  const sell = page.locator('[aria-label="Machine for sale"]');
  await sell.locator("#vu-q").fill(serial);
  await sell.getByRole("button", { name: "Look up", exact: true }).click();
  await sell.getByRole("list", { name: "Machines in stock" }).getByRole("button", { name: "Add $500.00", exact: true }).click();
  await scan(page, notion, `Spec bobbins ${RUN}`);

  // $520 of items, 6% tax: $551.20; the least deposit is 10% of the price.
  const panel = await openLayawayPanel(page);
  await expect(panel).toContainText(`Hold these items for ${who}`);
  await expect(panel).toContainText("$551.20 with today's tax.");
  await expect(panel).toContainText("At least $52.00 (10%).");
  await panel.locator("#lw-deposit").fill("100");
  await expect(panel.getByText(/^Their payments \(paid off by /)).toBeVisible();
  await panel.getByRole("button", { name: "Start layaway and take $100.00", exact: true }).click();
  await expect(toast(page, /Layaway #\d+ started\. Print the terms for them to sign\./)).toBeVisible();
  await doneSale(page);

  const l = (await one<{ id: string; number: number; status: string }>(`SELECT id, number, status FROM "Layaway" WHERE "shopId" = $1 AND "customerId" = $2`, [shopId, customerId]))!;
  expect(l.status).toBe("OPEN");
  layawayId = l.id;
  layawayNo = l.number;
  const unit = await one<{ status: string; layawayId: string | null }>(`SELECT u.status, u."layawayId" FROM "StockUnit" u JOIN "Machine" m ON m.id = u."machineId" WHERE u."shopId" = $1 AND m.serial = $2`, [shopId, serial]);
  expect(unit).toEqual({ status: "HELD", layawayId });
  const part = await one<{ qtyOnHand: number }>(`SELECT "qtyOnHand" FROM "Part" WHERE "shopId" = $1 AND "partNumber" = $2`, [shopId, notion]);
  expect(part?.qtyOnHand).toBe(4);
});

test("/layaways, the layaway's page and the printed terms", async () => {
  await page.goto("/layaways");
  await expect(page.getByText("Money held for customers:")).toContainText("$100.00");
  const row = page.getByRole("row").filter({ hasText: who });
  await expect(row).toContainText(`#${layawayNo}`);
  await expect(row).toContainText("$100.00");
  await row.getByRole("link", { name: `#${layawayNo}`, exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/layaways/${layawayId}$`));
  await expect(page.getByRole("heading", { level: 1, name: `Layaway #${layawayNo}` })).toBeVisible();
  await expect(page.getByText("Paying", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: unitText, exact: true })).toBeVisible();
  await expect(page.getByText("Tax if picked up today")).toBeVisible();
  await expect(page.getByRole("link", { name: /: sale #\d+$/ })).toHaveCount(1);

  await page.getByRole("link", { name: "Print the terms", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Layaway #${layawayNo}: terms` })).toBeVisible();
  const terms = page.locator(".card").filter({ hasText: "Customer's signature and date" });
  await expect(terms).toContainText(`Layaway #${layawayNo} for ${who}`);
  await expect(terms).toContainText(unitText);
  await expect(terms).toContainText("Deposit: $100.00");
  await expect(terms).toContainText(/Paid in full by [A-Z][a-z]{2} \d{1,2}, \d{4}\./);
  await expect(terms).toContainText("We hold the items above for you until they are paid for.");
  await expect(terms).toContainText("what you paid comes back to you as store credit.");
});

test("take a $50 payment at the register", async () => {
  await page.goto("/register");
  const panel = await openLayawayPanel(page);
  const item = panel.getByRole("listitem").filter({ hasText: `Layaway #${layawayNo}` });
  await expect(item).toContainText("Paid $100.00");
  await item.getByLabel("Payment", { exact: true }).fill("50");
  await item.getByRole("button", { name: "Take $50.00", exact: true }).click();
  await expect(toast(page, /Payment taken: sale #\d+/)).toBeVisible();
  await doneSale(page);
  const paid = await one<{ cents: number }>(
    `SELECT COALESCE(SUM(l.qty * l."unitPriceCents"), 0)::int AS cents FROM "SaleLine" l JOIN "Sale" s ON s.id = l."saleId" WHERE s."shopId" = $1 AND s.status = 'COMPLETED' AND l."layawayId" = $2`,
    [shopId, layawayId],
  );
  expect(paid?.cents).toBe(15000);
});

test("pick up: one sale at that day's tax with the payments taken off", async () => {
  // The rate went up since the layaway began: the pick-up charges today's 7% on $520 ($36.40), less the $150 paid.
  await sql(`UPDATE "Shop" SET "taxRatePct" = 7 WHERE id = $1`, [shopId]);
  await page.goto("/register");
  const panel = await openLayawayPanel(page);
  const item = panel.getByRole("listitem").filter({ hasText: `Layaway #${layawayNo}` });
  await item.getByRole("button", { name: "Pick up ($406.40 to pay)", exact: true }).click();
  await expect(toast(page, /Picked up: sale #\d+/)).toBeVisible();
  const { receipt } = await doneSale(page);

  const l = await one<{ status: string }>(`SELECT status FROM "Layaway" WHERE id = $1`, [layawayId]);
  expect(l?.status).toBe("COMPLETED");
  const unit = await one<{ status: string; warrantyUntil: Date | null }>(`SELECT u.status, u."warrantyUntil" FROM "StockUnit" u JOIN "Machine" m ON m.id = u."machineId" WHERE u."shopId" = $1 AND m.serial = $2`, [shopId, serial]);
  expect(unit?.status).toBe("SOLD");
  expect(unit?.warrantyUntil).toBeTruthy();

  await page.goto(receipt);
  const r = page.locator(".receipt");
  await expect(r).toContainText(unitText);
  await expect(r).toContainText(`Spec bobbins ${RUN}`);
  await expect(r).toContainText(`Layaway #${layawayNo}: paid so far`);
  await expect(r).toContainText("-$150.00");
  await expect(r).toContainText("Tax 7%");
  await expect(r).toContainText("$36.40");
  await expect(r.locator("div").filter({ hasText: /^TOTAL/ }).last()).toContainText("$406.40");

  await page.goto("/layaways?tab=COMPLETED");
  await expect(page.getByRole("row").filter({ hasText: who })).toContainText(`#${layawayNo}`);
});

test("cancel with the shop's fee rule: $10 kept, the rest back as store credit, the item back on sale", async () => {
  await sql(`UPDATE "Shop" SET "taxRatePct" = 6 WHERE id = $1`, [shopId]);
  // Settings → Selling → Layaway: a $10 cancel fee.
  await page.goto("/settings/sales");
  await page.getByText("More options: cancelling, and the terms they sign").click();
  await page.locator("#lw-fee").fill("10.00");
  await page.locator("#lw-feepct").fill("0");
  await expect(page.locator("#lw-refund")).toHaveValue("credit");
  await page.getByRole("button", { name: "Save layaway settings", exact: true }).click();
  await expect(toast(page, "Saved")).toBeVisible();
  const s = await one<{ layawayFeeCents: number }>(`SELECT "layawayFeeCents" FROM "Shop" WHERE id = $1`, [shopId]);
  expect(s?.layawayFeeCents).toBe(1000);

  // A second layaway: a $100 item, $30 down.
  await page.goto("/register");
  await pickCustomer(page, who);
  await scan(page, notion2, `Spec cutter ${RUN}`);
  const panel = await openLayawayPanel(page);
  await panel.locator("#lw-deposit").fill("30");
  await panel.getByRole("button", { name: "Start layaway and take $30.00", exact: true }).click();
  await expect(toast(page, /Layaway #\d+ started/)).toBeVisible();
  await doneSale(page);
  const l2 = (await one<{ id: string; number: number }>(`SELECT id, number FROM "Layaway" WHERE "shopId" = $1 AND status = 'OPEN'`, [shopId]))!;
  expect((await one<{ qtyOnHand: number }>(`SELECT "qtyOnHand" FROM "Part" WHERE "shopId" = $1 AND "partNumber" = $2`, [shopId, notion2]))?.qtyOnHand).toBe(2);

  await page.goto(`/layaways/${l2.id}`);
  await page.getByText("Cancel this layaway", { exact: true }).click();
  await expect(page.getByText("They paid $30.00. Your rule keeps $10.00; $20.00 goes back to them. The items go back on sale.")).toBeVisible();
  await expect(page.getByLabel("As store credit")).toBeChecked();
  await page.getByRole("button", { name: "Cancel the layaway", exact: true }).click();
  await expect(toast(page, "Layaway cancelled. The items are back on sale.")).toBeVisible();
  await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Cancel fee kept")).toBeVisible();

  const after = await one<{ status: string; cancelFeeCents: number | null }>(`SELECT status, "cancelFeeCents" FROM "Layaway" WHERE id = $1`, [l2.id]);
  expect(after).toEqual({ status: "CANCELLED", cancelFeeCents: 1000 });
  expect((await one<{ qtyOnHand: number }>(`SELECT "qtyOnHand" FROM "Part" WHERE "shopId" = $1 AND "partNumber" = $2`, [shopId, notion2]))?.qtyOnHand).toBe(3);
  const credit = await one<{ cents: number }>(`SELECT COALESCE(SUM("balanceCents"), 0)::int AS cents FROM "GiftCard" WHERE "shopId" = $1 AND "customerId" = $2 AND kind = 'credit'`, [shopId, customerId]);
  expect(credit?.cents).toBe(2000);
});
