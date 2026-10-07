// Pay links sent by staff (shop-features-round-2-design.md 1.3): the owner sets up card payments, opens Pay links from
// a customer's page, types a balance, sends it (two taps), copies the link; a signed-out browser opens it, presses Pay,
// pays on the Stripe mock's page and lands on "Paid. Thank you!"; the link shows paid and the sale is in the books.
//   Runs on a TEST BUILD with the Stripe mock (STRIPE_API_BASE on the server, STRIPE_MOCK_PORT here).
//   Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const STRIPE_MOCK = `http://127.0.0.1:${process.env.STRIPE_MOCK_PORT ?? "3403"}`;
const company = `Pl ${RUN}`;
const owner = { email: `pl-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const slug = `pl-${RUN.toLowerCase()}`;
let shopId: string;
let customerId: string;
let admin: Page;
let link: string;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Pl Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "taxRatePct" = 5 WHERE id = $1`, [shopId]);
  customerId = newId();
  await insert("Customer", { id: customerId, shopId, name: `Jane Paylink ${RUN}`, email: `jane-${RUN.toLowerCase()}@customer.test`, notifyBy: "email" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("without card payments the page says what to set up; with them the owner sends a link", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register/pay-links");
  await expect(page.getByText(/Pay links need card payments set up/)).toBeVisible();
  await expect(page.getByText("No pay links yet.")).toBeVisible();

  await page.goto("/settings/shop");
  await page.getByLabel(/^Address \(after \/shop\//).fill(slug);
  await page.getByLabel("Pickup at the shop").check();
  await page.getByLabel(/^Stripe secret key/).fill("sk_test_e2e1234567890");
  await page.getByLabel(/^Webhook signing secret/).fill("whsec_mock1234567890");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();

  await page.goto(`/customers/${customerId}`);
  await page.getByRole("link", { name: "Send a pay link" }).click();
  await expect(page.getByRole("heading", { name: "Send a pay link" })).toBeVisible();
  await expect(page.getByText(`Jane Paylink ${RUN}`)).toBeVisible();
  await page.getByLabel("What it is").fill("Balance on the Tula Pink kit");
  await page.getByLabel("Amount").fill("34.95");
  await page.getByText("More choices").click();
  await page.getByLabel(/Don't send it/).check();
  await page.getByRole("button", { name: "Send the pay link" }).click();
  await page.getByRole("button", { name: "Tap again to send $34.95" }).click();
  await expect(page.getByText(/Pay link #\d+ made\. Copy the link/)).toBeVisible();
  await expect(page.getByText("Waiting for her to pay")).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy the link" }).click();
  link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/\/shop\/o\/[A-Za-z0-9_-]{43}$/);
  await page.context().close();
});

test("the customer, signed out, pays it", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(new URL(link).pathname);
  await expect(page.getByRole("heading", { name: /\$34\.95 to pay/ })).toBeVisible();
  await page.getByRole("button", { name: "Pay $34.95" }).click();
  await expect(page).toHaveURL(new RegExp(`^${STRIPE_MOCK.replace(/\./g, "\\.")}/pay/cs_`), { timeout: 20_000 });
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await expect(page).toHaveURL(/\/shop\/o\/[A-Za-z0-9_-]{43}\?paid=1$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Paid. Thank you!" })).toBeVisible();
  const order = await sql<{ status: string; source: string; saleId: string | null }>(`SELECT status, source, "saleId" FROM "WebOrder" WHERE "shopId" = $1`, [shopId]);
  expect(order[0]).toMatchObject({ status: "DONE", source: "staff" });
  expect(order[0].saleId).not.toBeNull();
  await ctx.close();

  const staff = await login(browser, owner);
  await staff.goto("/register/pay-links");
  await expect(staff.getByText("Paid", { exact: true })).toBeVisible();
  await staff.context().close();
});
