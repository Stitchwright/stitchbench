// Wish lists (shop-features-round-2-design.md 9.9): start a list on a customer's page, add an item from stock, ring it up
// at the register from "Gift lists", and see it ticked off.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts).
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("a wish list bought from at the register", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  const cust = await insert<{ id: string }>("Customer", { shopId: owner.shopId, name: `Wendy Wish${RUN}`, phone: "555-0142" });
  await insert("Part", { shopId: owner.shopId, partNumber: `WL${RUN}`, numberKeys: [`WL${RUN}`], description: `Wish foot ${RUN}`, priceCents: 2500, qtyOnHand: 4 });
  await signIn(page, OWNER);
  await page.goto(`/customers/${cust.id}`);
  await page.getByText("Start a wish list or gift registry she can share with family").click();
  await page.getByLabel("Name of the list").fill(`Birthday ${RUN}`);
  await page.getByRole("button", { name: "Start the list" }).click();
  await expect(page.getByRole("heading", { name: `Birthday ${RUN}` })).toBeVisible();
  await page.getByLabel("Part").fill(`WL${RUN}`);
  await page.getByRole("button", { name: "Add to the list" }).click();
  await expect(page.getByText("0 of 1 bought")).toBeVisible();

  await page.goto("/register");
  await page.getByRole("button", { name: "Gift lists" }).click();
  await page.getByLabel("Whose list? Her name").fill(`Wish${RUN}`);
  await page.getByRole("button", { name: "Find" }).click();
  await page.locator('[aria-label="Gift lists"]').getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(page.getByText(`gift: Birthday ${RUN}`)).toBeVisible();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale #\d+ done/ })).toBeVisible();

  await page.goto(`/customers/${cust.id}`);
  await page.getByRole("link", { name: `Birthday ${RUN}` }).click();
  await expect(page.getByText("All bought")).toBeVisible();
});
