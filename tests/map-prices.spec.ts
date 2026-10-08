// Minimum advertised prices (shop-features-round-2-design.md 9.3): an item priced under its maker's minimum shows the
// minimum and "Add to cart to see our price" in the online shop, and the warning on its own page.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). Rows made here are removed at the end.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, one, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("set a minimum advertised price and see it online", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  const part = await insert<{ id: string }>("Part", { shopId: owner.shopId, partNumber: `MAP${RUN}`, numberKeys: [`MAP${RUN}`], description: `MAP foot ${RUN}`, kind: "ACCESSORY", priceCents: 3999, qtyOnHand: 3, online: true });
  try {
    await signIn(page, OWNER);
    await page.goto(`/parts/${part.id}`);
    const mapBox = page.locator("form", { has: page.getByLabel("The maker's minimum advertised price ($)") });
    await mapBox.getByLabel("The maker's minimum advertised price ($)").fill("49.99");
    await mapBox.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Below the minimum")).toBeVisible();

    const shop = await one<{ bookingSlug: string | null; shopOn: boolean }>(`SELECT "bookingSlug", "shopOn" FROM "Shop" WHERE id = $1`, [owner.shopId]);
    test.skip(!shop?.bookingSlug || !shop.shopOn, "the E2E shop's online shop isn't switched on");
    await page.goto(`/shop/${shop!.bookingSlug}/i/${part.id}`);
    await expect(page.getByText("$49.99")).toBeVisible();
    await expect(page.getByText("Add to cart to see our price")).toBeVisible();
    await expect(page.getByText("$39.99")).toHaveCount(0);
  } finally {
    await sql(`DELETE FROM "Part" WHERE id = $1`, [part.id]);
  }
});
