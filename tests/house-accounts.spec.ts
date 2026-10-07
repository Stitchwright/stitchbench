// House charge accounts (shop-features-round-2-design.md 9.4): the owner turns them on, opens an account on a customer's
// page, rings a sale up "On account", takes a payment, and prints the statement.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). The switch is put back off at the end.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("a sale on account, a payment, the statement", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "houseAccountsOn" = false WHERE id = $1`, [owner.shopId]);
  const cust = await insert<{ id: string }>("Customer", { shopId: owner.shopId, name: `Hill School ${RUN}`, phone: "555-0160" });
  await insert("Part", { shopId: owner.shopId, partNumber: `HA${RUN}`, numberKeys: [`HA${RUN}`], description: `Needles ${RUN}`, priceCents: 1500, qtyOnHand: 9 });
  try {
    await signIn(page, OWNER);
    await page.goto("/paperwork/accounts");
    await page.getByRole("button", { name: "Turn on house accounts" }).click();
    await page.goto(`/customers/${cust.id}`);
    await page.getByText("Let her buy now and pay from a monthly statement").click();
    await page.getByLabel("Limit ($, blank for none)").fill("500");
    await page.getByRole("button", { name: "Open a house account" }).click();
    await expect(page.getByText(/Owes \$0.00/)).toBeVisible();

    await page.goto("/register");
    await page.locator("#register-code").fill(`HA${RUN}`);
    await page.locator("#register-code").press("Enter");
    await page.locator("#register-customer").fill(`Hill School ${RUN}`);
    await page.getByRole("button", { name: new RegExp(`Hill School ${RUN}`) }).click();
    await page.getByRole("button", { name: "On account", exact: true }).click();
    await page.getByRole("button", { name: "Complete sale" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Sale #\d+ done/ })).toBeVisible();

    await page.goto(`/customers/${cust.id}`);
    await page.getByRole("link", { name: "Open the account" }).click();
    await page.getByLabel("By").selectOption("CASH");
    await page.getByLabel("Amount ($)").fill("5");
    await page.getByRole("button", { name: "Take the payment" }).click();
    await expect(page.getByText("Paid by cash")).toBeVisible();
    await page.goto("/paperwork/accounts");
    await expect(page.getByRole("link", { name: `Hill School ${RUN}` })).toBeVisible();
  } finally {
    await sql(`UPDATE "Shop" SET "houseAccountsOn" = false WHERE id = $1`, [owner.shopId]);
  }
});
