// Special orders and pre-orders (shop-features-round-2-design.md 1.2): Settings → Selling's special order deposit; the
// register's Special order button takes one for a customer with a $10 cash deposit; the Special orders page lists it
// ("Order it"); the item arrives (received by hand on its page) and it is here; at the register the customer's
// "Special order waiting" line adds it with what she paid coming off; the sale completes; the order is picked up. A
// second order is cancelled into store credit and the cancel undone. An item marked coming soon shows "take a
// pre-order" in the register's search.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `So ${RUN}`;
const owner = { email: `so-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const customerName = `Jane Special ${RUN}`;
let shopId: string;
let partId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("So Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "taxRatePct" = 0 WHERE id = $1`, [shopId]);
  partId = newId();
  await insert("Part", { id: partId, shopId, partNumber: `TP-${RUN}`, description: "Tula Pink charm pack", qtyOnHand: 0, priceCents: 3000, altNumbers: [], numberKeys: [`TP${RUN}`.toUpperCase()], kind: "FABRIC", supplier: "FreeSpirit" });
  await insert("Customer", { id: newId(), shopId, name: customerName, phone: "+12125550142", notifyBy: "none" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

async function pickCustomer(page: Page) {
  await page.locator("#register-customer").fill(customerName.slice(0, 12));
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
}

test("settings: a $10 deposit by default", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/sales");
  await page.getByLabel("A set amount").check();
  await page.getByLabel("Deposit amount").fill("10");
  await page.getByRole("button", { name: "Save special order settings" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.context().close();
});

test("the register takes a special order with a cash deposit; it's ordered and arrives", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register");
  await pickCustomer(page);
  await page.getByRole("button", { name: "Special order" }).click();
  await page.getByLabel("Find the item (number or words)").fill("charm pack");
  await page.getByRole("button", { name: /Tula Pink charm pack/ }).click();
  await page.getByLabel("How many").fill("2");
  await expect(page.getByText("deposit $10.00, $50.00 when it arrives")).toBeVisible();
  await page.getByRole("radio", { name: "Cash" }).click();
  await page.getByRole("button", { name: "Take the order" }).click();
  await expect(page.getByText(/Special order 1001 taken, deposit \$10\.00/)).toBeVisible();

  await page.goto("/special-orders");
  await expect(page.getByText("1 not ordered yet.")).toBeVisible();
  await page.getByRole("link", { name: "Special order 1001" }).click();
  await expect(page.getByText("Not ordered yet", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Print the slip" }).click();
  await expect(page.getByText("Deposit $10.00, balance $50.00 when it arrives.")).toBeVisible();
  await expect(page.getByText("If you cancel, the deposit comes back as store credit.")).toBeVisible();

  // It came in: received by hand on the item's page.
  await page.goto(`/parts/${partId}`);
  await page.getByLabel(/^Quantity/).first().fill("2");
  await page.getByRole("button", { name: /^Receive/ }).first().click();
  await expect(page.getByText(/Special order marked here and held/)).toBeVisible();
  const so = await sql<{ status: string; heldQty: number }>(`SELECT status, "heldQty" FROM "SpecialOrder" WHERE "shopId" = $1`, [shopId]);
  expect(so[0]).toMatchObject({ status: "HERE", heldQty: 2 });
  await page.goto("/special-orders?tab=here");
  await expect(page.getByText("Call these")).toBeVisible();
  await page.context().close();
});

test("picked up at the register: one tap adds it, the deposit comes off", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register");
  await pickCustomer(page);
  await expect(page.getByText("Special order waiting")).toBeVisible();
  await page.getByRole("button", { name: "Add it" }).click();
  await expect(page.getByText("Special order 1001: paid before")).toBeVisible();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /^Complete sale/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale #\d+ done/ })).toBeVisible();
  const so = await sql<{ status: string }>(`SELECT status FROM "SpecialOrder" WHERE "shopId" = $1 AND number = 1001`, [shopId]);
  expect(so[0].status).toBe("DONE");
  await page.context().close();
});

test("cancelled into store credit, then undone; coming soon shows in the register's search", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register");
  await pickCustomer(page);
  await page.getByRole("button", { name: "Special order" }).click();
  await page.getByLabel("Or say what she wants").fill("Kaffe Fassett book");
  await page.getByLabel("Price each").fill("29.95");
  await page.getByRole("button", { name: "Take the order" }).click();
  await expect(page.getByText(/Special order 1002 taken/)).toBeVisible();
  const id = (await sql<{ id: string }>(`SELECT id FROM "SpecialOrder" WHERE "shopId" = $1 AND number = 1002`, [shopId]))[0].id;
  await page.goto(`/special-orders/${id}`);
  await page.getByText("Cancel this order").click();
  await page.getByRole("button", { name: "Cancel the order" }).click();
  await expect(page.getByText(/Cancelled\. \$10\.00 given back\./)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Open again, as it was.")).toBeVisible();

  await page.goto(`/parts/${partId}`);
  await page.getByText("Coming soon and deposits").click();
  const soon = page.locator("form", { has: page.getByLabel("Coming soon: expected on") });
  await soon.getByLabel("Coming soon: expected on").fill("2030-11-01");
  await soon.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.goto("/register");
  await page.getByLabel("Scan a barcode or search").fill("charm pack");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/Coming soon \(Nov 1\): take a pre-order/)).toBeVisible();
  await page.context().close();
});
