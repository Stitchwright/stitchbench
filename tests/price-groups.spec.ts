// Customer price groups and memberships (shop-features-round-2-design.md 1.5): Settings → Prices and members adds
// "Guild", 10% off; a customer joins it on her page; at the register her fabric line shows "Guild 10%" and the total is
// 10% lower; tapping the label takes it off; an item set to sell the Club card membership puts the buyer in its group.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Pg ${RUN}`;
const owner = { email: `pg-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const customerName = `Jane Guild ${RUN}`;
let shopId: string;
let customerId: string;
let cardId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Pg Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "taxRatePct" = 0 WHERE id = $1`, [shopId]);
  customerId = newId();
  await insert("Customer", { id: customerId, shopId, name: customerName });
  await insert("Part", { id: newId(), shopId, partNumber: `KONA-${RUN}`, description: "Kona cotton", qtyOnHand: 40, priceCents: 1200, unit: "yd", altNumbers: [], numberKeys: [`KONA${RUN}`.toUpperCase()], kind: "FABRIC" });
  cardId = newId();
  await insert("Part", { id: cardId, shopId, partNumber: `CLUB-${RUN}`, description: "Club card", qtyOnHand: 0, priceCents: 2500, altNumbers: [], numberKeys: [`CLUB${RUN}`.toUpperCase()], kind: "SUPPLY" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("the owner adds Guild 10% and puts a customer in it", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/prices");
  await expect(page.getByText("No price groups yet.")).toBeVisible();
  await page.getByText("Add a price group").click();
  await page.getByLabel("Name").fill("Guild");
  await page.getByLabel("Percent off").fill("10");
  await page.getByRole("button", { name: "Add the group" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.getByText("Add a price group").click();
  await page.getByLabel("Name").last().fill("Club card");
  await page.getByLabel("Percent off").last().fill("15");
  await page.getByRole("button", { name: "Add the group" }).click();
  await page.reload();
  await expect(page.getByText("Guild", { exact: true })).toBeVisible();

  await page.goto(`/customers/${customerId}`);
  await page.getByText("Put her in a group").click();
  await page.getByLabel("Group").selectOption({ label: "Guild" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.context().close();
});

test("at the register her fabric is 10% off, labelled; tapping the label takes it off", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register");
  await page.getByLabel("Customer (optional)").fill(customerName.slice(0, 10));
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
  await expect(page.getByText(/gets 10% off/)).toBeVisible();
  await page.getByLabel("Scan a barcode or search").fill(`KONA-${RUN}`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: /Guild 10%: take it off this line/ })).toBeVisible();
  await expect(page.getByText("$10.80").first()).toBeVisible();
  await page.getByRole("button", { name: /Guild 10%: take it off this line/ }).click();
  await expect(page.getByText("$12.00").first()).toBeVisible();
  await page.context().close();
});

test("an item that sells the Club card membership puts the buyer in its group", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/parts/${cardId}`);
  await page.getByText(/^Sells a membership/).click();
  await page.getByLabel("Puts the buyer in").selectOption({ label: "Club card" });
  await page.getByLabel("For (months)").fill("12");
  await page.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();

  await page.goto("/register");
  await page.getByLabel("Customer (optional)").fill(customerName.slice(0, 10));
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
  await page.getByLabel("Scan a barcode or search").fill(`CLUB-${RUN}`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /^Complete sale/ }).click();
  await expect(page.getByText(/Sale #\d+ done/)).toBeVisible();
  const row = await sql<{ name: string }>(`SELECT g.name FROM "Customer" c JOIN "PriceGroup" g ON g.id = c."priceGroupId" WHERE c.id = $1`, [customerId]);
  expect(row[0].name).toBe("Club card");
  await page.context().close();
});
