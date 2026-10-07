// Raise prices, the margin floor and back orders (shop-features-round-2-design.md 4.4): the owner raises a supplier's
// prices 10% (sees old and new, presses Raise them, Undo puts them back), sets a 40% margin floor in Settings, Selling,
// sees "under your margin floor" on Inventory and raises those to the floor; marks a sent order's line back ordered with
// its day and finds it on Coming in.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Rp ${RUN}`;
const owner = { email: `rp-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let p1: string;
let orderId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Rp Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  p1 = newId();
  await insert("Part", { id: p1, shopId, partNumber: `RP1-${RUN}`, description: "Aurifil 50wt spool", supplier: "Checker", priceCents: 1000, costCents: 500, numberKeys: [`RP1${RUN}`], kind: "THREAD" });
  await insert("Part", { id: newId(), shopId, partNumber: `RP2-${RUN}`, description: "Clover pins", supplier: "Brewer", priceCents: 800, costCents: 600, numberKeys: [`RP2${RUN}`], kind: "NOTION" });
  const sup = newId();
  await insert("FabricSupplier", { id: sup, shopId, name: "Checker" });
  orderId = newId();
  await insert("PurchaseOrder", { id: orderId, shopId, number: 1, supplierId: sup, supplierName: "Checker", status: "SENT", sentAt: new Date() });
  await insert("PurchaseOrderLine", { id: newId(), shopId, orderId, partId: p1, itemNumber: `RP1-${RUN}`, description: "Aurifil 50wt spool", unit: "EACH", qty: 6 });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("raise a supplier's prices, undo, margin floor, back order", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/parts");
  await page.getByRole("link", { name: "Raise prices" }).click();
  await expect(page.getByRole("heading", { name: "Raise prices" })).toBeVisible();
  await expect(page.getByText(/No prices raised here yet/)).toBeVisible();
  await page.getByLabel("Whose prices").selectOption({ label: "Checker" });
  await page.getByLabel("By how much (%)").fill("10");
  await page.getByRole("button", { name: "Show the new prices" }).click();
  await expect(page.getByText("$11.99")).toBeVisible();
  await page.getByRole("button", { name: "Raise them (1 item)" }).click();
  await expect(page.getByText(/Done: 1 price raised/)).toBeVisible();
  await expect.poll(async () => (await sql<{ priceCents: number }>(`SELECT "priceCents" FROM "Part" WHERE id = $1`, [p1]))[0].priceCents).toBe(1199);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/Undone: 1 price put back/)).toBeVisible();
  await expect.poll(async () => (await sql<{ priceCents: number }>(`SELECT "priceCents" FROM "Part" WHERE id = $1`, [p1]))[0].priceCents).toBe(1000);

  await page.goto("/settings/sales");
  await page.getByLabel("Tell me when an item's margin falls under (%)").fill("40");
  await page.getByRole("button", { name: "Save the margin floor" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.goto("/parts");
  await expect(page.getByText(/1 item is under your margin floor/)).toBeVisible();
  await page.getByRole("status").getByRole("link", { name: "Raise prices" }).click();
  await expect(page.getByText("$10.99")).toBeVisible(); // pins at $8.00 on a $6.00 cost: up to the 40% floor, $10.00, ends in .99
  await page.getByRole("button", { name: /^Raise them/ }).click();
  await expect(page.getByText(/Done: 1 price raised/)).toBeVisible();

  await page.goto(`/parts/orders/${orderId}`);
  await page.getByRole("button", { name: "Back ordered" }).click();
  await page.getByLabel("Expected (if they said)").fill("2026-11-20");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Back ordered, expected Nov 20, 2026")).toBeVisible();
  await page.goto("/parts/orders");
  await page.getByRole("link", { name: "Coming in" }).click();
  await expect(page.getByText("Back ordered, expected Nov 20, 2026")).toBeVisible();
});
