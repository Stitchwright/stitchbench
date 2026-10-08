// Google and Facebook feeds (shop-features-round-2-design.md 4.1, 4.2): the owner turns the online shop on, scans a
// barcode into an item, opens Settings, Online shop, "Show your stock on Google and Facebook", switches the feeds on with
// a store code, sees the counts, the links and what's left out ("No barcode"); a signed-out request reads the Google
// file; "Switch the feeds off" (two taps) stops it.
//   Runs on a TEST BUILD with PUBLIC_URL set. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Fd ${RUN}`;
const owner = { email: `fd-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const slug = `fd-${RUN.toLowerCase()}`;
let shopId: string;
let partId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Fd Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  partId = newId();
  await insert("Part", { id: partId, shopId, partNumber: `FD-${RUN}`, description: "Clover seam ripper", priceCents: 899, qtyOnHand: 3, online: true, numberKeys: [`FD${RUN}`], kind: "ACCESSORY" });
  await insert("Part", { id: newId(), shopId, partNumber: `FDN-${RUN}`, description: "Thimble, no barcode", priceCents: 499, qtyOnHand: 3, online: true, numberKeys: [`FDN${RUN}`], kind: "ACCESSORY" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("the owner scans a barcode, switches the feeds on and reads the links; switched off they stop", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/shop");
  await page.getByLabel(/^Address \(after \/shop\//).fill(slug);
  await page.getByLabel("The online shop is on").check();
  await page.getByLabel("Pickup at the shop").check();
  await page.getByLabel(/^Stripe secret key/).fill("sk_test_e2e1234567890");
  await page.getByLabel(/^Webhook signing secret/).fill("whsec_mock1234567890");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();

  // The barcode on the item's page; a wrong one is explained.
  await page.goto(`/parts/${partId}`);
  const itemForm = page.locator("form", { has: page.getByLabel("Barcode (UPC or EAN, for Google and Facebook)") });
  await page.getByLabel("Barcode (UPC or EAN, for Google and Facebook)").fill("012345678901");
  await itemForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/last digit doesn't add up/)).toBeVisible();
  await page.getByLabel("Barcode (UPC or EAN, for Google and Facebook)").fill("0 12345 67890 5");
  await itemForm.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await sql<{ gtin: string }>(`SELECT gtin FROM "Part" WHERE id = $1`, [partId]))[0].gtin).toBe("012345678905");

  await page.goto("/settings/shop");
  await page.getByRole("link", { name: "Show your stock on Google and Facebook" }).click();
  await expect(page.getByRole("heading", { name: "Google and Facebook" })).toBeVisible();
  await page.getByLabel(/^Store code from your Google Business Profile/).fill("MAIN");
  await page.getByRole("button", { name: "Show my stock on Google and Facebook" }).click();
  await expect(page.getByText("Switched on. Your links are below.")).toBeVisible();
  await expect(page.getByText("Google: products")).toBeVisible();
  await expect(page.getByText(/Google asks for at least 50 items/)).toBeVisible();
  await expect(page.getByText("No barcode", { exact: true })).toBeVisible();
  await expect(page.getByText("No photo (Facebook needs one)")).toBeVisible();

  const url = (await page.locator("code").first().textContent())!.trim();
  expect(url).toContain(`/shop/${slug}/feeds/`);
  const anon = await browser.newContext();
  const r = await anon.request.get(url);
  expect(r.status()).toBe(200);
  expect(await r.text()).toContain("<g:gtin>012345678905</g:gtin>");

  await page.getByText("More choices").click();
  await page.getByRole("button", { name: "Switch the feeds off" }).click();
  await page.getByRole("button", { name: "Tap again to switch the feeds off" }).click();
  await expect(page.getByText(/Switched off/)).toBeVisible();
  expect((await anon.request.get(url)).status()).toBe(404);
  await anon.close();
});
