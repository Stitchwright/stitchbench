// Clubs and longarm (fabric-smarts F6/F7): start a club, add a member who pays at pickup, mark the month paid and see
// the money in "taken today"; take a quilt in for longarm quilting priced by the square inch, work it through to ready,
// and collect it (billed as a register sale).
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop; the spec turns counter sales on in the database.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

/** "$12.34 taken today" on the Bench page, in cents. */
async function takenToday(page: Page) {
  await page.goto("/");
  const text = (await page.getByText(/taken today/).first().textContent()) ?? "";
  const m = /\$([\d,]+\.\d\d) taken today/.exec(text);
  if (!m) throw new Error(`no "taken today" in: ${text}`);
  return Math.round(Number(m[1].replace(/,/g, "")) * 100);
}

async function customerNamed(shopId: string, name: string) {
  await insert("Customer", { shopId, name, phone: "5550100", updatedAt: new Date() }).catch(async () => insert("Customer", { shopId, name, phone: "5550100" }));
}

test("start a club, mark a pay-at-pickup month paid and see it in taken today", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  const member = `Clubber ${RUN}`;
  await customerNamed(owner.shopId, member);
  await signIn(page, OWNER);

  await page.goto("/fabric?tab=clubs");
  const club = `Fat Quarter Club ${RUN}`;
  await page.getByLabel("Club name").fill(club);
  await page.getByLabel("Monthly price ($)").fill("40");
  await page.getByRole("button", { name: "Start the club" }).click();
  await expect(page).toHaveURL(/\/fabric\/clubs\//);
  await expect(page.getByRole("heading", { level: 1, name: club })).toBeVisible();

  // Add the member, paying at pickup.
  await page.getByLabel("Existing customer").fill(member);
  await page.getByRole("button", { name: new RegExp(member) }).click();
  await page.getByLabel("Pays").selectOption("PAY_AT_PICKUP");
  await page.getByRole("button", { name: "Add the member" }).click();
  const row = page.getByRole("list", { name: "Pick list" }).getByRole("listitem").filter({ hasText: member });
  await expect(row).toBeVisible();
  await expect(row).toContainText("pay at pickup");

  const clubUrl = page.url();
  const before = await takenToday(page);
  await page.goto(clubUrl);
  const row2 = page.getByRole("list", { name: "Pick list" }).getByRole("listitem").filter({ hasText: member });
  await row2.getByLabel("Paid by").selectOption("CASH");
  await row2.getByRole("button", { name: "Mark paid" }).click();
  await expect(row2.locator(".pill", { hasText: "paid" }).first()).toBeVisible();
  expect(await takenToday(page)).toBe(before + 4000);
});

test("a longarm order priced by the square inch, collected at the register", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  const who = `Quilter ${RUN}`;
  await customerNamed(owner.shopId, who);
  await signIn(page, OWNER);

  await page.goto("/longarm");
  await page.getByLabel("Existing customer").fill(who);
  await page.getByRole("button", { name: new RegExp(who) }).click();
  await page.getByLabel("Width (inches)").fill("60");
  await page.getByLabel("Length (inches)").fill("80");
  await page.getByLabel("Cents per square inch").fill("2.5");
  await page.getByLabel("Pattern (optional)").fill("Baptist fan");
  await page.getByRole("button", { name: "Take it in" }).click();
  await expect(page).toHaveURL(/\/longarm\/[a-z0-9]+$/);
  // 60 x 80 = 4,800 square inches at 2.5 cents = $120.00
  await expect(page.getByText("$120.00").first()).toBeVisible();

  await page.getByRole("button", { name: /^Now on the frame/i }).click();
  await page.getByRole("button", { name: /^Now ready/i }).click();
  const orderUrl = page.url();
  const before = await takenToday(page);
  await page.goto(orderUrl);
  await page.getByLabel("Paid by").selectOption("CASH");
  await page.getByRole("button", { name: /^Collect and take payment/ }).click();
  const sale = page.getByRole("link", { name: /^Sale|#\d+/ }).first();
  await expect(sale).toBeVisible();
  await expect(page.getByText(/Collected/i).first()).toBeVisible();
  expect(await takenToday(page)).toBeGreaterThanOrEqual(before + 12000);
});
