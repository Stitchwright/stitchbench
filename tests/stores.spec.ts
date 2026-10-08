// More than one store (shop-features-round-2-design.md section 7): a company with one store shows nothing about stores
// but Settings' "Opening another store?"; the owner adds Florida; the menu then says which store this computer is at
// and switches it; an item's page shows "In this store" and the other store; Florida asks Boston for two, Boston sends
// them from Between stores, Florida taps It arrived; the register at Florida finds them in this store; Today shows a
// card per store, an approval the register asked for (Approve), and a note between stores; Reports has a Store choice.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Stores ${RUN}`;
const owner = { email: `stores-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let partId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Stores Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "taxRatePct" = 0 WHERE id = $1`, [shopId]);
  partId = newId();
  await insert("Part", { id: partId, shopId, partNumber: `BB-${RUN}`, description: "Bobbin box", qtyOnHand: 5, priceCents: 1200, altNumbers: [], numberKeys: [`BB${RUN}`.toUpperCase()], kind: "NOTION" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

async function atStore(page: Page, name: string) {
  await page.getByLabel("This computer is at").selectOption({ label: name });
  await expect(page.getByText(`This computer is at ${name} now.`)).toBeVisible();
}

test("one store: nothing about stores but the way to add one", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register");
  await expect(page.getByTestId("store-switch")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Today", exact: true })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByText("One store.")).toBeVisible();
  await page.getByRole("link", { name: "Opening another store? Add it here" }).click();
  await expect(page.getByRole("heading", { name: "Add a second store" })).toBeVisible();
  await page.context().close();
});

test("the owner adds Florida; the menu says which store this computer is at", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/stores");
  await page.getByLabel("This store is called").fill("Boston");
  await page.getByLabel("The new store is called").fill("Florida");
  await page.getByLabel("Sales tax (%)").fill("7");
  await page.getByRole("button", { name: "Add the store" }).click();
  await expect(page.getByText(/Florida added\./)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Boston (main store)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Florida" })).toBeVisible();
  await expect(page.getByLabel("This computer is at")).toBeVisible();
  await expect(page.getByRole("link", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Between stores" })).toBeVisible();
  const rows = await sql<{ name: string; main: boolean }>(`SELECT name, main FROM "Location" WHERE "shopId" = $1 ORDER BY "sortOrder"`, [shopId]);
  expect(rows).toEqual([
    { name: "Boston", main: true },
    { name: "Florida", main: false },
  ]);
  await page.context().close();
});

test("Florida asks Boston for two; Boston sends them; Florida says they arrived", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/parts/${partId}`);
  await atStore(page, "Florida");
  await expect(page.getByTestId("item-stores")).toContainText("In this store: 0");
  await expect(page.getByTestId("item-stores")).toContainText("At Boston: 5");
  await page.getByLabel("How many to ask for").fill("2");
  await page.getByRole("button", { name: "Ask them" }).click();
  await expect(page.getByText(/Asked \(request 1\)/)).toBeVisible();

  await atStore(page, "Boston");
  await page.goto("/parts/transfers");
  await expect(page.getByTestId("asked-of-us")).toContainText("Florida asks for");
  await page.getByRole("button", { name: "Send it" }).click();
  await expect(page.getByText(/^Sent\./)).toBeVisible();

  await atStore(page, "Florida");
  await page.goto("/parts/transfers");
  await expect(page.getByTestId("coming-here")).toContainText("From Boston");
  await page.getByRole("button", { name: "It arrived" }).click();
  await expect(page.getByText(/Transfer 1 from Boston is on the shelf here/)).toBeVisible();
  const levels = await sql<{ qtyOnHand: number }>(`SELECT "qtyOnHand" FROM "StockLevel" WHERE "partId" = $1`, [partId]);
  expect(levels[0].qtyOnHand).toBe(2);

  await page.goto("/register");
  await page.getByLabel("Scan a barcode or search").fill("Bobbin box");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/2 in this store/)).toBeVisible();
  await expect(page.getByText("At Boston: 3").first()).toBeVisible();
  await page.context().close();
});

test("Today: a card per store, an approval answered from the phone, a note between stores", async ({ browser }) => {
  const florida = (await sql<{ id: string }>(`SELECT id FROM "Location" WHERE "shopId" = $1 AND name = 'Florida'`, [shopId]))[0].id;
  const ownerId = (await sql<{ id: string }>(`SELECT id FROM "User" WHERE "shopId" = $1 AND role = 'OWNER'`, [shopId]))[0].id;
  const approvalId = newId();
  await insert("Approval", { id: approvalId, shopId, locationId: florida, kind: "REFUND", amountCents: 25000, reason: "Broken in the box", requestedById: ownerId, status: "ASKED", expiresAt: new Date(Date.now() + 3_600_000) });
  const page = await login(browser, owner);
  await page.goto("/today");
  await expect(page.getByTestId("store-card")).toHaveCount(2);
  await expect(page.getByTestId("approval")).toContainText("a refund of $250.00");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved: the register goes on")).toBeVisible();
  expect((await sql<{ status: string }>(`SELECT status FROM "Approval" WHERE id = $1`, [approvalId]))[0].status).toBe("APPROVED");

  await page.getByLabel("A note for").fill("The Bernina rep visits Thursday");
  await page.getByRole("button", { name: "Post the note" }).click();
  await expect(page.getByTestId("store-note")).toContainText("The Bernina rep visits Thursday");
  await page.context().close();
});

test("Reports: a Store choice, all stores by default for the owner", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/reports");
  await expect(page.getByLabel("Store", { exact: true })).toHaveValue("all");
  await page.goto("/reports?tab=tax");
  await expect(page.getByRole("heading", { name: "Sales tax: Boston" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sales tax: Florida" })).toBeVisible();
  await page.context().close();
});
