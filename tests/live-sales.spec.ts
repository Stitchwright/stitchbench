// Live-sale claim list (shop-features-round-2-design.md 4.3): the owner sets up card payments, opens Register, Live sale,
// starts one, searches an item, adds it to today's show, claims it for a customer found by name and for a new buyer with
// a phone, sees what's left, takes a claim off, and ends the show with "Send pay links" (two taps); the buyers show
// "Pay link sent".
//   Runs on a TEST BUILD with the Stripe mock. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Ls ${RUN}`;
const owner = { email: `ls-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const slug = `ls-${RUN.toLowerCase()}`;
let shopId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Ls Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  await insert("Customer", { id: newId(), shopId, name: `Jane Live ${RUN}`, email: `jane-ls-${RUN.toLowerCase()}@customer.test`, notifyBy: "email" });
  await insert("Part", { id: newId(), shopId, partNumber: `LS-${RUN}`, description: `Charm pack ${RUN}`, priceCents: 1500, qtyOnHand: 3, numberKeys: [`LS${RUN}`], kind: "FABRIC" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("start a live sale, claim for two buyers, send the pay links", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/shop");
  await page.getByLabel(/^Address \(after \/shop\//).fill(slug);
  await page.getByLabel("Pickup at the shop").check();
  await page.getByLabel(/^Stripe secret key/).fill("sk_test_e2e1234567890");
  await page.getByLabel(/^Webhook signing secret/).fill("whsec_mock1234567890");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();

  await page.goto("/register");
  await page.getByRole("link", { name: "Live sale" }).click();
  await expect(page.getByText("No live sales yet.")).toBeVisible();
  await page.getByLabel("Name (optional)").fill(`Thursday Live ${RUN}`);
  await page.getByRole("button", { name: "Start the live sale" }).click();
  await expect(page.getByRole("heading", { name: `Thursday Live ${RUN}` })).toBeVisible();
  await expect(page.getByText(/No claims yet/)).toBeVisible();

  await page.getByLabel("Search an item").fill(`Charm pack ${RUN}`);
  await page.getByRole("button", { name: new RegExp(`Charm pack ${RUN}`) }).first().click();
  await page.getByRole("button", { name: "Add to today's show" }).click();
  await expect(page.getByText("Added to today's show")).toBeVisible();

  await page.getByLabel("Buyer's name").fill(`Jane Live`);
  await page.getByRole("button", { name: new RegExp(`Jane Live ${RUN}`) }).click();
  await page.getByLabel("How many").fill("2");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText("Claimed")).toBeVisible();
  await expect(page.getByText("1 left", { exact: true })).toBeVisible();

  await page.getByLabel("Buyer's name").fill(`Ann New ${RUN}`);
  await page.getByLabel(/New buyer: her mobile number or email/).fill(`ann-${RUN.toLowerCase()}@customer.test`);
  await page.getByLabel("How many").fill("1");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByText("All claimed")).toBeVisible();
  await page.getByRole("button", { name: "Take off" }).first().click();
  await expect(page.getByText("Taken off. The stock is free again.")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("All claimed")).toBeVisible();

  await page.getByRole("button", { name: "End the show and send pay links" }).click();
  await page.getByRole("button", { name: "Tap again to send 2 pay links" }).click();
  await expect(page.getByText(/Pay links sent|Copy the link/)).toBeVisible();
  await expect(page.getByText("Pay link sent").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Send it again" }).first()).toBeVisible();
});
