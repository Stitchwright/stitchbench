// Vac Shop end to end (modules-design.md 13.2, modules-e2e acceptance 1): a vacuum checked in, worked and collected;
// the finder with a local part and a bag rung up through the register's picker for the customer's vacuum; a unit
// received, sold with a warranty, a trade-in taken and its sale voided; a central vac install made, its site set,
// completed and on the invoice; the install on the calendar with Scheduling on; bags due for a unit sold 200 days ago.
//   Runs on a TEST BUILD against the local database, with E2E_EMAIL in PLATFORM_ADMIN_EMAILS (the admin turns the
//   modules on from Companies). Written against the code, not a running page: expect label slips on the first run.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const DAY = 86_400_000;
const company = `Vac ${RUN}`;
const owner = { email: `vac-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const customerName = `Vera Vacuum ${RUN}`;
const serial = `VS${RUN}`;
const unitSerial = `VU${RUN}`;
const installDay = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
let shopId: string;
let admin: Page;
let customerId: string;
const made: string[] = [];

/** Picks the customer on the register by name (the search box, then the hit). */
async function pickCustomer(page: Page, name: string) {
  await page.goto("/register");
  await page.locator("#register-customer").fill(name.slice(0, 12));
  await page.getByRole("button", { name }).first().click();
  await expect(page.getByText(name).first()).toBeVisible();
}

async function completeSale(page: Page, refund = false) {
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: refund ? "Complete refund" : "Complete sale" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Vac Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true WHERE id = $1`, [shopId]);
  await setModule(admin, company, "Vac Shop", true);
  await setModule(admin, company, "Scheduling", true);
});

test.afterAll(async () => {
  for (const id of made) {
    await sql(`DELETE FROM "Ticket" WHERE "shopId" = $1`, [id]);
    await sql(`DELETE FROM "StockUnit" WHERE "shopId" = $1`, [id]);
    await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  }
  await disconnect();
  await admin.context().close();
});

test("a vacuum is checked in, its checklist and readings filled, billed and collected", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/tickets/new?kind=vacuum");
  await expect(page.getByRole("heading", { name: "Check in a vacuum" })).toBeVisible();
  await page.getByLabel("new customer's name").fill(customerName);
  await page.getByLabel("Phone", { exact: true }).fill("+12125550190");
  await page.getByLabel("Brand", { exact: true }).fill("Hoover");
  await page.getByLabel("Model", { exact: true }).fill("UH70120");
  await page.getByLabel("Serial number", { exact: true }).fill(serial);
  await page.getByLabel("Type", { exact: true }).selectOption("Upright");
  await page.getByLabel("Bags or bagless").selectOption("Bagged");
  await page.getByLabel("Bag type").fill("Type Y");
  await page.getByLabel("Power", { exact: true }).selectOption("Corded");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Hoover UH70120/ })).toBeVisible();
  customerId = (await sql<{ id: string }>(`SELECT id FROM "Customer" WHERE "shopId" = $1 AND name = $2`, [shopId, customerName]))[0].id;

  // The vacuum checklist and readings.
  await page.getByLabel("Bag / bin emptied and bag chamber cleaned").check();
  await page.getByLabel("Belt checked or replaced").check();
  await page.getByLabel("Suction as found").fill("55");
  await page.getByLabel("Suction as left").fill("82");
  await page.getByLabel("Brush roll spins under load as left").selectOption("pass");
  await page.getByRole("button", { name: "Save readings" }).click();
  await expect(page.getByText("Readings saved")).toBeVisible();

  // Billed, ready, collected and paid.
  await page.getByLabel("Hours", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Add labor" }).click();
  await expect(page.getByText("Repair labor")).toBeVisible();
  await page.locator("#status").selectOption("READY_FOR_PICKUP");
  await expect(page.getByText("Status: Ready - customer called")).toBeVisible();
  await page.locator("#status").selectOption("COLLECTED");
  await expect(page.getByText("Status: Collected by customer")).toBeVisible();
  const payment = page.locator("form", { has: page.getByRole("button", { name: "Record payment" }) });
  await payment.getByLabel("Amount", { exact: true }).fill("10.00");
  await payment.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Payment recorded")).toBeVisible();
  await page.context().close();
});

test("the finder lists the shop's own bag for the model, and the register's picker rings it up for the customer's vacuum", async ({ browser }) => {
  const page = await login(browser, owner);
  const pn = `BAG${RUN}`;
  await page.goto("/parts");
  await page.getByLabel("Part number", { exact: true }).fill(pn);
  await page.getByLabel("Description", { exact: true }).fill("Hoover Type Y bags (3)");
  await page.getByLabel("Fits models").fill("Hoover, UH70120");
  await page.getByLabel("Cost each ($)").fill("4.00");
  await page.getByLabel("Price each ($, blank = cost + markup)").fill("12.99");
  await page.getByLabel("Quantity on hand").fill("6");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByText("6 on hand")).toBeVisible();

  await page.goto("/vac/finder?brand=Hoover&q=UH70120");
  await expect(page.getByRole("heading", { name: "Bag, belt and filter finder" })).toBeVisible();
  const bags = page.locator("section", { has: page.getByRole("heading", { name: /^Bags/ }) });
  await expect(bags.getByText("Hoover Type Y bags (3)")).toBeVisible();
  await expect(bags.getByText("Your part")).toBeVisible();
  await expect(bags.getByText(/6 on hand/)).toBeVisible();

  await pickCustomer(page, customerName);
  await page.getByRole("button", { name: "Bags, belts, filters" }).click();
  await page.getByRole("button", { name: /Hoover UH70120/ }).click();
  const picker = page.getByLabel("Bags, belts and filters");
  await expect(picker.getByText("Hoover Type Y bags (3)")).toBeVisible();
  await picker.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.getByRole("table", { name: "Sale" })).toContainText("Hoover Type Y bags (3)");
  await completeSale(page);
  const line = await sql<{ machineId: string | null }>(`SELECT l."machineId" FROM "SaleLine" l JOIN "Sale" s ON s.id = l."saleId" WHERE s."shopId" = $1 AND l.description LIKE 'Hoover Type Y bags%'`, [shopId]);
  expect(line[0]?.machineId).toBeTruthy();
  await page.context().close();
});

test("a unit is received, sold with a warranty, a trade-in taken, and the trade-in's sale voided", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/units?kind=vacuum");
  await page.getByLabel("Brand", { exact: true }).fill("Miele");
  await page.getByLabel("Model", { exact: true }).fill("C3");
  await page.getByLabel("Type", { exact: true }).selectOption("Canister");
  await page.getByLabel("Condition", { exact: true }).selectOption("NEW");
  await page.getByLabel("Bags or bagless").selectOption("Bagged");
  await page.getByLabel("Bag type").fill("GN");
  await page.getByLabel("Serial numbers, one per line (one vacuum each)").fill(unitSerial);
  await page.getByLabel("Cost ($)").fill("300.00");
  await page.getByLabel("Price ($)").fill("499.00");
  await page.getByRole("button", { name: "Add to stock" }).click();
  await expect(page.getByRole("heading", { name: "Miele C3" })).toBeVisible();
  await expect(page.getByText("In stock").first()).toBeVisible();

  // Sold to the customer: the receipt carries the warranty line.
  await pickCustomer(page, customerName);
  await page.getByRole("button", { name: "Machine for sale" }).click();
  await page.getByRole("button", { name: "Look up" }).click();
  await page.getByRole("button", { name: "Add $499.00" }).click();
  await expect(page.getByRole("table", { name: "Sale" })).toContainText(`Miele C3 (New) S/N ${unitSerial}`);
  await completeSale(page);
  await page.getByRole("link", { name: "Print receipt" }).click();
  await expect(page.getByText(/warranty through .* from Miele\. Keep this receipt\./)).toBeVisible();
  await page.goto("/units?tab=sold");
  await expect(page.getByRole("row", { name: new RegExp(unitSerial) })).toContainText("Sold");
  await page.goto("/units?tab=register");
  await expect(page.getByRole("row", { name: new RegExp(unitSerial) })).toContainText("to register");

  // A trade-in: credit, no tax, the vacuum in stock with no price; then its sale voided -> off sale.
  await pickCustomer(page, customerName);
  await page.getByRole("button", { name: "Trade-in" }).click();
  const trade = page.getByLabel("Trade-in", { exact: true });
  await trade.getByLabel("What kind").selectOption("vacuum");
  await trade.getByLabel("Brand").fill("Kirby");
  await trade.getByLabel("Model").fill("G4");
  await trade.getByLabel("Serial").fill(`VT${RUN}`);
  await trade.getByLabel("Bags or bagless").selectOption("Bagged");
  await trade.getByLabel("Credit ($)").fill("50.00");
  await trade.getByRole("button", { name: "Add trade-in" }).click();
  await expect(page.getByRole("table", { name: "Sale" })).toContainText("Trade-in: Kirby G4");
  await completeSale(page, true);
  await page.goto("/units?tab=stock");
  const kirby = page.getByRole("row", { name: /Kirby G4/ });
  await expect(kirby).toContainText("none");
  await page.getByRole("link", { name: "Kirby G4" }).click();
  await page.getByRole("link", { name: /sale #\d+/ }).click();
  await page.getByLabel("Void this sale (rung up by mistake)").fill("test");
  await page.getByRole("button", { name: "Void sale" }).click();
  await expect(page.getByText("Sale voided")).toBeVisible();
  // The old Vac Shop address still lands on the list (moved to /units).
  await page.goto("/vac/units?tab=off");
  await expect(page.getByRole("row", { name: /Kirby G4/ })).toContainText("Off sale");
  await page.context().close();
});

test("a central vac install: made, its site and power unit set, completed, and on the invoice", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/vac/installs/new");
  await page.getByLabel("Or a new customer: name").fill(`Ida Install ${RUN}`);
  await page.getByLabel("Phone", { exact: true }).fill("+12125550191");
  await page.getByLabel("Where").fill("12 Oak St, Springfield");
  await page.getByLabel("Date (blank: not scheduled yet)").fill(installDay);
  await page.getByLabel("From", { exact: true }).fill("09:00");
  await page.getByLabel("To", { exact: true }).fill("12:00");
  await page.getByLabel("Contact on site").fill("Ida");
  await page.getByRole("button", { name: "Create the install" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Install #/ })).toBeVisible();
  const site = page.locator("section", { has: page.getByRole("heading", { name: "The site" }) });
  await expect(site.getByRole("link", { name: /12 Oak St, Springfield/ })).toBeVisible();
  await expect(site.getByText("to be chosen")).toBeVisible();
  await site.locator("summary", { hasText: "Set the power unit" }).click();
  await site.getByLabel("Brand").fill("NuTone");
  await site.getByLabel("Model").fill("PP650");
  await site.getByLabel("Serial").fill(`PU${RUN}`);
  await site.getByRole("button", { name: "Set the power unit" }).click();
  await expect(page.getByText("Power unit set")).toBeVisible();
  await expect(page.getByText(/NuTone PP650/).first()).toBeVisible();
  await page.getByLabel("Power unit spot agreed with the customer").check();
  await page.getByLabel("Hours", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Add labor" }).click();
  await page.locator("#status").selectOption("COLLECTED");
  await expect(page.getByText(/Status: Completed/)).toBeVisible();
  await page.getByRole("link", { name: "Invoice", exact: true }).first().click();
  await expect(page.getByText("Work done at")).toBeVisible();
  await expect(page.getByText("12 Oak St, Springfield")).toBeVisible();
  await page.goto("/vac/installs?tab=done");
  await expect(page.getByRole("row", { name: /Ida Install/ })).toContainText("Completed");
  await page.context().close();
});

test("with Scheduling on, the install shows on the calendar's day as 'Install: {customer}'", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/calendar?view=day&date=${installDay}`);
  await expect(page.getByText(`Install: Ida Install ${RUN}`)).toBeVisible();
  await page.context().close();
});

test("bags due lists a bagged vacuum sold 200 days ago", async ({ browser }) => {
  const m = await insert<{ id: string }>("Machine", { shopId, customerId, brand: "Hoover", model: "UH70120", modelKey: "UH70120", serial: `BD${RUN}`, equipment: "VACUUM", kind: "vacuum", details: JSON.stringify({ bagged: "Bagged", bagType: "Type Y" }) });
  await insert("StockUnit", { shopId, machineId: m.id, status: "SOLD", condition: "NEW", soldAt: new Date(Date.now() - 200 * DAY).toISOString(), priceCents: 29900, soldNetCents: 29900, updatedAt: new Date().toISOString() });
  const page = await login(browser, owner);
  await page.goto("/vac/bags-due");
  const row = page.getByRole("row", { name: new RegExp(customerName) });
  await expect(row).toContainText("Hoover UH70120");
  await expect(row).toContainText("overdue");
  await expect(row).toContainText("Hoover Type Y bags (3)");
  await row.getByRole("button", { name: "Snooze 30 days" }).click();
  await expect(page.getByText("Snoozed 30 days")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(customerName) })).toHaveCount(0);
  await page.goto("/vac");
  await expect(page.getByText(/0 due/)).toBeVisible();
  await page.context().close();
});
