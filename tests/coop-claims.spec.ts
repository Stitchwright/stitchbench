// Co-op and rebate claims (shop-features-round-2-design.md 9.2): add a co-op claim due soon (the dashboard reminds),
// send it, record what came in.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). Rows made here are removed at the end.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("add a co-op claim, see the reminder, send it and record the money", async ({ page }) => {
  const owner = await shopOf(OWNER);
  const maker = `Coopco${RUN}`;
  try {
    await signIn(page, OWNER);
    await page.goto("/paperwork/coop");
    await page.getByLabel("Maker").fill(maker);
    await page.getByLabel("What we spent ($)").fill("400");
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await page.getByLabel("Send it by").fill(soon);
    await page.getByRole("button", { name: "Add the claim" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`Claim #\\d+: ${maker}`) })).toBeVisible();
    await expect(page.getByText("claim $200.00 of $400.00 spent")).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("link", { name: new RegExp(`Send co-op claim #\\d+ to ${maker}`) })).toBeVisible();
    await page.getByRole("link", { name: new RegExp(`Send co-op claim #\\d+ to ${maker}`) }).click();

    await page.getByRole("button", { name: `I sent it to ${maker}` }).click();
    await expect(page.getByText("Sent, waiting")).toBeVisible();
    await page.getByLabel("Amount ($)").fill("200");
    await page.getByRole("button", { name: "Record what came in" }).click();
    await expect(page.getByText("$200.00 came in")).toBeVisible();
  } finally {
    await sql(`DELETE FROM "CoopClaim" WHERE "shopId" = $1 AND maker = $2`, [owner.shopId, maker]);
  }
});
