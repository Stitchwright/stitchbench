// Shipping labels through Shippo (shop-features-round-2-design.md 9.5), in test mode against the Shippo mock: turn labels
// on, get rates for a paid order to post, buy one (asked once), and print it.
// Needs the app under test started with SHIPPO_API_BASE pointing at `node scripts/test-mail/shippo-mock.mjs` (port
// 3405) and the same SHIPPO_API_BASE in this run's environment; skipped otherwise. Never a real label.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). Labels are switched off at the end.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("buy a label for an online order", async ({ page }) => {
  test.skip(!process.env.SHIPPO_API_BASE?.includes("3405"), "needs the Shippo mock (SHIPPO_API_BASE on port 3405)");
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  const n = (await sql<{ n: number }>(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM "WebOrder" WHERE "shopId" = $1`, [owner.shopId]))[0].n;
  const order = await insert<{ id: string }>("WebOrder", { shopId: owner.shopId, number: n, name: `Label ${RUN}`, address: `Label ${RUN}\n12 Elm St\nChicago, IL 60601`, fulfil: "ship", status: "PAID", subtotalCents: 1000, taxCents: 0, totalCents: 1000, tokenHash: `e2e-l-${RUN}`, paidAt: new Date() });
  try {
    await signIn(page, OWNER);
    await page.goto("/settings/shipping");
    await page.getByLabel(/Shippo API key/).fill("shippo_test_e2espec12345");
    await page.getByLabel("Buy labels from Online orders").check();
    await page.getByLabel("Name on the label").fill("E2E Shop");
    await page.getByLabel("Street").fill("5 Main St");
    await page.getByLabel("City").fill("Springfield");
    await page.getByLabel("State (two letters)").fill("IL");
    await page.getByLabel("ZIP").fill("62701");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Test mode: sample labels, no charge.")).toBeVisible();

    await page.goto("/register/online");
    const card = page.locator(`[data-order="${n}"]`);
    await card.getByRole("button", { name: "Get label rates" }).click();
    await card.getByRole("button", { name: "Buy $5.40" }).click();
    await card.getByRole("button", { name: "Tap again: buy for $5.40" }).click();
    await expect(card.getByRole("link", { name: "Print the label" })).toBeVisible();
    await expect(card.getByText(/Tracking: 9400/)).toBeVisible();
  } finally {
    await sql(`DELETE FROM "WebOrder" WHERE id = $1`, [order.id]);
    await sql(`UPDATE "Shop" SET "shippoOn" = false WHERE id = $1`, [owner.shopId]);
  }
});
