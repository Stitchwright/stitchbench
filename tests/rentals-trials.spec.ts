// Rentals and trial purchases (shop-features-round-2-design.md 1.8): a machine set as a rental is rented out from the
// Loaners, demos and rentals page at $40 a month (card), shows paid through a month with its rent-to-own credit, takes
// another month's rent, and is bought with the rent credit; trial days set on the same page.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Rt ${RUN}`;
const owner = { email: `rt-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const customerName = `Jane Renter ${RUN}`;
let shopId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Rt Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "taxRatePct" = 0 WHERE id = $1`, [shopId]);
  await insert("Customer", { id: newId(), shopId, name: customerName });
  const m = newId();
  await insert("Machine", { id: m, shopId, brand: "Janome", model: "MC9850", modelKey: "MC9850", serial: `RT-${RUN}` });
  await insert("StockUnit", { id: newId(), shopId, machineId: m, priceCents: 100000, use: "RENTAL", updatedAt: new Date() });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("rent it out, take rent, buy it with the rent credit", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/units/loans");
  await page.getByText("Rent one out").click();
  await page.getByLabel("Find the customer").fill(customerName.slice(0, 10));
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
  await page.getByLabel("Rent", { exact: true }).fill("40");
  await page.getByRole("radio", { name: "Card" }).first().click();
  await page.getByRole("button", { name: /^Rent it out/ }).click();
  await expect(page.getByText("Rented out; the first rent is rung up.")).toBeVisible();
  await page.reload();
  await expect(page.getByText(/paid through/)).toBeVisible();
  await expect(page.getByText(/Rent-to-own: \$40\.00 counts toward buying it/)).toBeVisible();
  await page.getByRole("button", { name: /^Take \$40\.00 rent/ }).click();
  await expect(page.getByText("Rent taken.")).toBeVisible();
  await page.getByRole("button", { name: /^Buy it now: \$920\.00/ }).click();
  await expect(page.getByText("Sold to her.")).toBeVisible();
  const u = await sql<{ status: string }>(`SELECT status FROM "StockUnit" WHERE "shopId" = $1`, [shopId]);
  expect(u[0].status).toBe("SOLD");

  await page.getByText("Loaner settings").click();
  await page.getByLabel(/Try it for/).fill("14");
  await page.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.context().close();
});
