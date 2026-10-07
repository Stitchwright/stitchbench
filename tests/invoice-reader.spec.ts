// A photo of the packing slip fills in receiving (shop-features-round-2-design.md 1.10): with the Assistant on and its
// Stock helpers switch, a sent order's page offers "Receive from a photo of the packing slip"; a picture is chosen and
// read (the test hub answers with two lines); "On the order" is ticked with "Cost up"; "Receive these" receives it.
//   Runs on a TEST BUILD with the stand-in hub answering /v1/assistant (as tests/assistant.spec.ts sets it up) and the
//   Assistant module granted. Written against the code: expect label slips.
import path from "node:path";
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Ir ${RUN}`;
const owner = { email: `ir-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let orderId: string;

test.beforeAll(async ({ browser }) => {
  const admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Ir Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await admin.context().close();
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  const partId = newId();
  await insert("Part", { id: partId, shopId, partNumber: "ISA-0015", description: "Isacord white", qtyOnHand: 0, priceCents: 900, costCents: 410, altNumbers: [], numberKeys: ["ISA0015"], kind: "THREAD", supplier: "Notions Marketing" });
  const supplierId = newId();
  await insert("FabricSupplier", { id: supplierId, shopId, name: "Notions Marketing" });
  orderId = newId();
  await insert("PurchaseOrder", { id: orderId, shopId, number: 1, supplierId, supplierName: "Notions Marketing", status: "SENT", sentAt: new Date() });
  await insert("PurchaseOrderLine", { id: newId(), shopId, orderId, partId, itemNumber: "ISA-0015", description: "Isacord white", unit: "EACH", qty: 10, costCents: 410 });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
});

test("receive from a photo of the packing slip", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/parts/orders/${orderId}`);
  await page.getByText("Receive from a photo of the packing slip").click();
  await page.locator("input[type=file][accept='image/*']").setInputFiles(path.join(__dirname, "..", "desktop", "icon.png") /* any picture: the stand-in hub answers the same */);
  await page.getByRole("button", { name: "Read it" }).click();
  await expect(page.getByRole("heading", { name: "On the order" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Cost up/)).toBeVisible();
  await page.getByRole("button", { name: "Receive these" }).click();
  await expect(page.getByText(/Received .* on 1 line of order #1/)).toBeVisible();
  await page.context().close();
});
