// Trade-up credit (shop-features-round-2-design.md 1.9): Settings → Selling turns it on for 30 days; a collected repair's
// invoice prints "If you'd rather buy a new machine by ..., we'll take $89.00 off"; at the register, with the customer
// and a machine for sale on the sale, "Repair credit $89.00" Use it puts "Trade-up credit" on the machine's line.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Tu ${RUN}`;
const owner = { email: `tu-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const customerName = `Jane Trader ${RUN}`;
let shopId: string;
let ticketId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Tu Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "taxRatePct" = 0 WHERE id = $1`, [shopId]);
  const customerId = newId();
  await insert("Customer", { id: customerId, shopId, name: customerName });
  const hers = newId();
  await insert("Machine", { id: hers, shopId, customerId, brand: "Singer", model: "Featherweight", modelKey: "FEATHERWEIGHT" });
  ticketId = newId();
  await insert("Ticket", { id: ticketId, shopId, number: 7, customerId, machineId: hers, status: "COLLECTED", readyAt: new Date(), closedAt: new Date(), updatedAt: new Date() });
  await insert("TicketLine", { id: newId(), ticketId, kind: "LABOR", description: "Clean, oil and adjust", qty: 1, unitPriceCents: 8900 });
  const m = newId();
  await insert("Machine", { id: m, shopId, brand: "Janome", model: "Skyline S5", modelKey: "SKYLINES5", serial: `TU-${RUN}` });
  await insert("StockUnit", { id: newId(), shopId, machineId: m, priceCents: 120000, updatedAt: new Date() });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("on for 30 days: the invoice says so, and the register takes it off a machine", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/sales");
  await page.getByText(/If she buys a new machine within/).click();
  const tradeUp = page.locator("form", { has: page.getByLabel("Trade-up days") });
  await tradeUp.getByLabel("Trade-up days").fill("30");
  await tradeUp.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();

  await page.goto(`/tickets/${ticketId}/invoice`);
  await expect(page.getByText(/If you'd rather buy a new machine by .*, we'll take \$89\.00 off\./)).toBeVisible();

  await page.goto("/register");
  await page.getByLabel("Customer (optional)").fill(customerName.slice(0, 10));
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
  await expect(page.getByText("Repair credit $89.00")).toBeVisible();
  await page.getByLabel("Scan a barcode or search").fill(`TU-${RUN}`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Use it" }).click();
  await expect(page.getByRole("button", { name: /Trade-up credit: take it off this line/ })).toBeVisible();
  await expect(page.getByText("$1111.00").first()).toBeVisible();
  await page.context().close();
});
