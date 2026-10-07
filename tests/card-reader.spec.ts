// The card reader (shop-features-round-2-design.md 4.8), in test mode against the Stripe Terminal mock: pair the
// simulated reader, ring an item up, "Card reader", "Test: tap a card", and the sale finishes by itself.
// Needs the app under test started with STRIPE_API_BASE pointing at `node scripts/test-mail/stripe-terminal-mock.mjs`
// (port 3406) and the same STRIPE_API_BASE in this run's environment; skipped otherwise. Never real money.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). The reader is switched off at the end.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("pay on the simulated reader and the sale finishes", async ({ page }) => {
  test.skip(!process.env.STRIPE_API_BASE?.includes("3406"), "needs the Stripe Terminal mock (STRIPE_API_BASE on port 3406)");
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "taxRatePct" = 0 WHERE id = $1`, [owner.shopId]);
  await insert("Part", { shopId: owner.shopId, partNumber: `CR${RUN}`, numberKeys: [`CR${RUN}`], description: `Reader kit ${RUN}`, priceCents: 2500, qtyOnHand: 5 });
  try {
    await signIn(page, OWNER);
    await page.goto("/settings/card-reader");
    await page.getByLabel(/Stripe secret key/).fill("sk_test_e2ecardreader12345");
    await page.getByLabel("Use the card reader at the register").check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Test mode: no real money.")).toBeVisible();
    await page.getByLabel("The code on the reader").fill("simulated-wpe");
    await page.getByRole("button", { name: "Pair the reader" }).click();
    await expect(page.getByText("simulated_wisepos_e")).toBeVisible();

    await page.goto("/register");
    await page.locator("#register-code").fill(`CR${RUN}`);
    await page.locator("#register-code").press("Enter");
    await page.getByRole("button", { name: /Card reader \$25.00/ }).click();
    await expect(page.getByText("Tap, insert or swipe on the reader: $25.00")).toBeVisible();
    await page.getByRole("button", { name: "Test: tap a card" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Sale #\d+ done/ })).toBeVisible({ timeout: 15_000 });
  } finally {
    await sql(`UPDATE "Shop" SET "cardReaderOn" = false WHERE id = $1`, [owner.shopId]);
    await sql(`DELETE FROM "CardReader" WHERE "shopId" = $1`, [owner.shopId]);
  }
});
