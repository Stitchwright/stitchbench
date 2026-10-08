// Want lists (shop-features-round-2-design.md 1.4): on a customer's page, Add to her want list ("Tula Pink"); a new
// item by Tula Pink is received by hand; the customer's line shows "Here now"; the item's page says "1 customer wants
// this"; the Want lists page lists it; Done takes it off.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Wl ${RUN}`;
const owner = { email: `wl-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let customerId: string;
let partId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Wl Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  customerId = newId();
  await insert("Customer", { id: customerId, shopId, name: `Jane Wants ${RUN}`, notifyBy: "none" });
  partId = newId();
  await insert("Part", { id: partId, shopId, partNumber: `FS-${RUN}`, description: "Untamed charm pack", designer: "Tula Pink", qtyOnHand: 0, priceCents: 3000, altNumbers: [], numberKeys: [`FS${RUN}`.toUpperCase()], kind: "FABRIC" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("a want list line in words; the item comes in; Here now; Done", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/customers/${customerId}`);
  await expect(page.getByText("Nothing on her want list.")).toBeVisible();
  await page.getByText("Add to her want list", { exact: true }).first().click();
  await page.getByLabel("What she wants: an item, or a designer, collection or maker").fill("Tula Pink");
  await page.getByRole("button", { name: "Add to her want list" }).click();
  await expect(page.getByText(/You'll see "Here now" when it comes in/)).toBeVisible();

  await page.goto(`/parts/${partId}`);
  await page.getByLabel("Quantity received").fill("3");
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(page.getByText(/1 want list line matches/)).toBeVisible();
  await page.reload();
  await expect(page.getByText("1 customer wants this")).toBeVisible();

  await page.goto(`/customers/${customerId}`);
  await expect(page.getByText("Here now", { exact: true })).toBeVisible();
  await page.goto("/want-lists");
  await expect(page.getByRole("link", { name: `Jane Wants ${RUN}` })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Taken off her list")).toBeVisible();
  await page.context().close();
});
