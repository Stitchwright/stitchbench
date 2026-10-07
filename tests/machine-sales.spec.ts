// Machines for sale for every shop (tax-machine-sales-layaway-design.md section 3). Runs on a TEST BUILD. A throwaway
// repair+counter company: a service plan and a maker's warranty in Settings → Selling, a machine added on /units with
// "More options" (warranty, what comes with it, owner's classes), sold at the register with a trade-in and the plan, the
// receipt's warranty, bundle, classes and trade-in lines, a repair ticket's line marked "Covered by ...", and the
// machine returned at the register. The company is removed at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, one, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Units ${RUN}`;
const owner = { email: `units-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const buyer = `Mary Machine ${RUN}`;
const brand = "Janome";
const model = `Spec ${RUN}`;
const serial = `SN${RUN}`;
const unitText = `${brand} ${model} (New) S/N ${serial}`;
const plan = `Yearly cleaning ${RUN}`;
let shopId: string;
let customerId: string;
let admin: Page;
let page: Page;
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

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toast = (p: Page, text: string | RegExp) => p.locator("[data-sonner-toast]").filter({ hasText: text }).first();

/** Puts a customer on the register's sale by searching the customer box. */
async function pickCustomer(p: Page, name: string) {
  await p.locator("#register-customer").fill(name);
  await p.getByRole("listitem").getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(p.getByRole("button", { name: "change", exact: true })).toBeVisible();
}

/** Pays what is due (Cash pressed with nothing typed takes the amount due), completes it; the sale's number and receipt address. */
async function payAndComplete(p: Page, button = "Complete sale") {
  await p.getByRole("button", { name: "Cash", exact: true }).click();
  await p.getByRole("button", { name: button, exact: true }).click();
  const done = p.getByRole("status").filter({ hasText: /Sale #\d+ done/ });
  await expect(done).toBeVisible();
  const number = Number(/Sale #(\d+) done/.exec((await done.textContent()) ?? "")![1]);
  const receipt = (await done.getByRole("link", { name: "Print receipt" }).getAttribute("href"))!;
  return { number, receipt };
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  shopId = await createCompany(company, "both", "Unit Owner", owner.email);
  customerId = (await insert<{ id: string }>("Customer", { shopId, name: buyer, phone: "5550111" })).id;
  page = await login(browser, owner);
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await page?.context().close();
  await admin?.context().close();
});

test("Settings → Selling: a service plan and a maker's warranty", async () => {
  await page.goto("/settings/sales");
  await page.locator("#np-name").fill(plan);
  await page.locator("#np-price").fill("99.00");
  await expect(page.locator("#np-visits")).toHaveValue("3");
  await expect(page.locator("#np-months")).toHaveValue("36");
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await expect(toast(page, "Plan added")).toBeVisible();
  await expect(page.getByText(plan, { exact: true })).toBeVisible();

  await page.locator("#mw-brand").fill(brand);
  await page.locator("#mw-parts").fill("25");
  await page.locator("#mw-labor").fill("2");
  await page.getByRole("button", { name: "Save brand", exact: true }).click();
  await expect(toast(page, "Saved")).toBeVisible();
  const terms = await one(`SELECT id FROM "MakerWarranty" WHERE "shopId" = $1 AND brand = $2`, [shopId, brand]);
  expect(terms).toBeTruthy();
});

test("add a machine on /units with More options: warranty, what comes with it, owner's classes", async () => {
  await page.goto("/units");
  await expect(page.getByRole("heading", { level: 1, name: "Machines for sale" })).toBeVisible();
  await page.locator("#ru-brand").fill(brand);
  await page.locator("#ru-model").fill(model);
  await page.locator("#ru-serials").fill(serial);
  await page.locator("#ru-cost").fill("600.00");
  await page.locator("#ru-price").fill("1000.00");
  await page.getByText("More options: warranty, what comes with it, owner's classes").click();
  await page.locator("#ru-months").fill("12");
  await page.locator("#ru-by").fill("Spec Sewing Co");
  await page.locator("#ru-bundle").fill("Extension table\nWalking foot");
  await page.locator("#ru-classes").fill("2");
  await page.getByRole("button", { name: "Add to stock", exact: true }).click();
  await expect(page.getByRole("link", { name: `${brand} ${model}`, exact: true })).toBeVisible();
  const u = await one<{ priceCents: number; classCredits: number; bundle: string; status: string }>(
    `SELECT u."priceCents", u."classCredits", u.bundle, u.status FROM "StockUnit" u JOIN "Machine" m ON m.id = u."machineId" WHERE u."shopId" = $1 AND m.serial = $2`,
    [shopId, serial],
  );
  expect(u).toMatchObject({ priceCents: 100000, classCredits: 2, status: "IN_STOCK" });
  expect(u!.bundle).toContain("Walking foot");
});

test("sell it at the register with a trade-in and a service plan; the receipt has the warranty, bundle, classes and credit", async () => {
  const unit = (await one<{ id: string }>(`SELECT u.id FROM "StockUnit" u JOIN "Machine" m ON m.id = u."machineId" WHERE u."shopId" = $1 AND m.serial = $2`, [shopId, serial]))!;
  const planId = (await one<{ id: string }>(`SELECT id FROM "ServicePlan" WHERE "shopId" = $1 AND name = $2`, [shopId, plan]))!.id;
  await page.goto("/register");
  await pickCustomer(page, buyer);
  const sale = page.getByRole("table", { name: "Sale" });

  // The machine from stock.
  await page.getByRole("button", { name: "Machine for sale", exact: true }).click();
  const sell = page.locator('[aria-label="Machine for sale"]');
  await sell.locator("#vu-q").fill(serial);
  await sell.getByRole("button", { name: "Look up", exact: true }).click();
  await sell.getByRole("list", { name: "Machines in stock" }).getByRole("button", { name: "Add $1000.00", exact: true }).click();
  await expect(sale).toContainText(unitText);

  // A trade-in taken as $200 credit.
  await page.getByRole("button", { name: "Trade-in", exact: true }).click();
  await page.locator("#ti-brand").fill("Singer");
  await page.locator("#ti-model").fill("Featherweight 221");
  await page.locator("#ti-serial").fill(`TI${RUN}`);
  await page.locator("#ti-credit").fill("200");
  await page.getByRole("button", { name: "Add trade-in", exact: true }).click();
  await expect(sale).toContainText(`Trade-in: Singer Featherweight 221 S/N TI${RUN}`);

  // The service plan, for the machine on this sale.
  await page.getByRole("button", { name: "Service plan", exact: true }).click();
  await expect(page.locator("#sp-plan")).toBeVisible();
  await page.locator("#sp-plan").selectOption(planId);
  await page.locator("#sp-for").selectOption(`unit:${unit.id}`);
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await expect(sale).toContainText(`Service plan: ${plan} for ${unitText}`);

  const { receipt } = await payAndComplete(page);
  const sold = await one<{ status: string; warrantyUntil: Date | null; soldLineId: string | null }>(`SELECT status, "warrantyUntil", "soldLineId" FROM "StockUnit" WHERE id = $1`, [unit.id]);
  expect(sold?.status).toBe("SOLD");
  expect(sold?.warrantyUntil).toBeTruthy();
  const trade = await one(`SELECT u.id FROM "StockUnit" u JOIN "Machine" m ON m.id = u."machineId" WHERE u."shopId" = $1 AND m.serial = $2 AND u.status = 'IN_STOCK'`, [shopId, `TI${RUN}`]);
  expect(trade, "the trade-in went into stock").toBeTruthy();

  await page.goto(receipt);
  const r = page.locator(".receipt");
  await expect(r).toContainText(new RegExp(`${esc(unitText)}: warranty through [A-Z][a-z]{2} \\d{1,2}, \\d{4} from Spec Sewing Co\\. Keep this receipt\\.`));
  await expect(r).toContainText(`${brand} warranty:`);
  await expect(r).toContainText("Comes with: Extension table, Walking foot.");
  await expect(r).toContainText("Includes 2 owner's classes. Call us to book.");
  await expect(r).toContainText("Trade-in credit: $200.00");
  await expect(r).toContainText(new RegExp(`Service plan: ${plan}: 3 covered visits through`));
});

test("a repair ticket for the machine: a line marked Covered by the plan", async () => {
  const m = (await one<{ machineId: string }>(`SELECT u."machineId" FROM "StockUnit" u JOIN "Machine" m ON m.id = u."machineId" WHERE u."shopId" = $1 AND m.serial = $2`, [shopId, serial]))!;
  const n = (await one<{ n: number }>(`UPDATE "Shop" SET "nextTicketNumber" = "nextTicketNumber" + 1 WHERE id = $1 RETURNING "nextTicketNumber" - 1 AS n`, [shopId]))!.n;
  const ticket = await insert<{ id: string }>("Ticket", { shopId, number: n, machineId: m.machineId, customerId, status: "ON_BENCH", problem: "Yearly cleaning", updatedAt: new Date() });
  const line = await insert<{ id: string }>("TicketLine", { ticketId: ticket.id, kind: "SERVICE", description: `Clean and oil ${RUN}`, qty: 1, unitPriceCents: 8900 });

  await page.goto(`/tickets/${ticket.id}`);
  await page.getByRole("button", { name: `Covered by ${plan}`, exact: true }).click();
  await expect(page.getByText(`Covered by ${plan} (would have been $89.00 each)`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Charge it instead", exact: true })).toBeVisible();
  const l = await one<{ coveredPlanId: string | null; coveredCents: number | null }>(`SELECT "coveredPlanId", "coveredCents" FROM "TicketLine" WHERE id = $1`, [line.id]);
  expect(l?.coveredPlanId).toBeTruthy();
  expect(l?.coveredCents).toBe(8900);
});

test("return the machine at the register: back in stock, the plan ended", async () => {
  const unit = (await one<{ id: string }>(`SELECT u.id FROM "StockUnit" u JOIN "Machine" m ON m.id = u."machineId" WHERE u."shopId" = $1 AND m.serial = $2`, [shopId, serial]))!;
  await page.goto("/register");
  await page.getByRole("button", { name: /Return an item/ }).click();
  await page.getByRole("button", { name: "Return a machine", exact: true }).click();
  const ret = page.locator('[aria-label="Return a machine"]');
  await ret.locator("#vu-q").fill(serial);
  await ret.getByRole("button", { name: "Look up", exact: true }).click();
  await ret.getByRole("list", { name: "Machines sold" }).getByRole("button", { name: /^Refund \$/ }).click();
  await expect(page.getByRole("table", { name: "Sale" })).toContainText(`Return: ${unitText}`);
  const { receipt } = await payAndComplete(page, "Complete refund");

  const back = await one<{ status: string }>(`SELECT status FROM "StockUnit" WHERE id = $1`, [unit.id]);
  expect(back?.status).toBe("IN_STOCK");
  const plans = await sql<{ voidedAt: Date | null }>(`SELECT "voidedAt" FROM "MachinePlan" WHERE "shopId" = $1 AND "stockUnitId" = $2`, [shopId, unit.id]);
  expect(plans.length).toBeGreaterThan(0);
  expect(plans.every((p) => p.voidedAt != null)).toBe(true);
  await page.goto(receipt);
  await expect(page.locator(".receipt")).toContainText(`Returned: ${unitText}`);
});
