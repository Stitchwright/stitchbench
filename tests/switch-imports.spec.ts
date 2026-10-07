// Help switching (shop-features-round-2-design.md 4.7): the owner opens Settings, "Switching from another system", picks
// From Square and Items, sees the export steps, opens a Square item export, sees what will come in (new and already
// here), presses Bring them in; then a customer export is recognised by its columns and brought in.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Sw ${RUN}`;
const owner = { email: `sw-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page;

const ITEMS = ["Token,Item Name,Variation Name,SKU,GTIN,Price,Default Unit Cost,Current Quantity Main", `T1,Aurifil ${RUN},Regular,SW-${RUN},,13.95,7.50,6`].join("\n");
const CUSTOMERS = ["First Name,Last Name,Email Address,Phone Number,Square Customer ID,Transaction Count,Total Spend", `Jane,Switch ${RUN},jane-sw-${RUN.toLowerCase()}@customer.test,555-410-2000,SQ1,4,$120.00`].join("\n");

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Sw Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("items and customers from Square", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings");
  await page.getByRole("link", { name: "Bring them in" }).click();
  await expect(page.getByRole("heading", { name: "Switching from another system" })).toBeVisible();
  await expect(page.getByText(/Choose Actions, Export library/)).toBeVisible();
  await page.getByLabel("The exported file").setInputFiles({ name: "square-items.csv", mimeType: "text/csv", buffer: Buffer.from(ITEMS) });
  await expect(page.getByText("Opened square-items.csv.")).toBeVisible();
  await page.getByRole("button", { name: "See what will come in" }).click();
  await expect(page.getByText(/1 items from Square/)).toBeVisible();
  await page.getByRole("button", { name: "Bring them in (1)" }).click();
  await expect(page.getByText(/From Square: 1 item added/).first()).toBeVisible();

  await page.getByLabel("The exported file").setInputFiles({ name: "square-customers.csv", mimeType: "text/csv", buffer: Buffer.from(CUSTOMERS) });
  await expect(page.getByText(/This looks like customers from Square/)).toBeVisible();
  await page.getByRole("button", { name: "See what will come in" }).click();
  await page.getByRole("button", { name: "Bring them in (1)" }).click();
  await expect(page.getByText(/1 customer added/).first()).toBeVisible();
  await page.goto("/customers");
  await expect(page.getByText(`Jane Switch ${RUN}`)).toBeVisible();
});
