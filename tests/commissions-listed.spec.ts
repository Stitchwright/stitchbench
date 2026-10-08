// Commissions and "listed elsewhere" (shop-features-round-2-design.md 9.7): a machine also listed on eBay can't be sold
// until "Take it down on eBay first: done" is ticked; the sale counts for the seller picked; Paperwork → Commissions.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). Rows made here are removed at the end.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, one, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("a listed machine waits for the take-down tick; commissions show it", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  const cust = await insert<{ id: string }>("Customer", { shopId: owner.shopId, name: `Lister ${RUN}`, phone: "555-0177" });
  const machine = await insert<{ id: string }>("Machine", { shopId: owner.shopId, brand: "Janome", model: `L${RUN}`, modelKey: `L${RUN}`, serial: `LS${RUN}` });
  const unit = await insert<{ id: string }>("StockUnit", { shopId: owner.shopId, machineId: machine.id, priceCents: 50000, updatedAt: new Date() });
  void cust;
  await signIn(page, OWNER);
  // The seller's "Machines sold" this month, before and after (other runs and specs sell machines too).
  const me = (await one<{ name: string }>(`SELECT name FROM "User" WHERE id = $1`, [owner.id]))!.name;
  const machinesSold = async () => {
    await page.goto("/paperwork/commissions");
    await expect(page.getByRole("heading", { name: "Commissions" })).toBeVisible();
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: me, exact: true }) });
    if (!(await row.count())) return 0;
    return Math.round(Number((await row.getByRole("cell").nth(1).innerText()).replace(/[$,]/g, "")) * 100);
  };
  const before = await machinesSold();
  await page.goto(`/units/${unit.id}`);
  await page.getByText("Listed on eBay, Etsy or Marketplace too?").click();
  const listed = page.locator("form", { has: page.getByRole("checkbox", { name: "eBay" }) });
  await listed.getByRole("checkbox", { name: "eBay" }).check();
  await listed.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("For sale on eBay too.")).toBeVisible();

  await page.goto("/register");
  await page.locator("#register-code").fill(`LS${RUN}`);
  await page.locator("#register-code").press("Enter");
  await page.locator("#register-customer").fill(`Lister ${RUN}`);
  await page.getByRole("button", { name: new RegExp(`Lister ${RUN}`) }).click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await expect(page.getByRole("button", { name: "Complete sale" })).toBeDisabled();
  await page.getByLabel(/Take it down on eBay first: done/).check();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale #\d+ done/ })).toBeVisible();

  expect(await machinesSold()).toBe(before + 50_000);
});
