// Shipping labels through Pirate Ship (shop-features-round-2-design.md 9.5): a paid order to post shows "Export for
// Pirate Ship" on Online orders, and the file holds its address split for Pirate Ship.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). Rows made here are removed at the end.
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("export the orders to post for Pirate Ship", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  const n = (await sql<{ n: number }>(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM "WebOrder" WHERE "shopId" = $1`, [owner.shopId]))[0].n;
  const order = await insert<{ id: string }>("WebOrder", { shopId: owner.shopId, number: n, name: `Shipper ${RUN}`, address: "12 Elm St\nSpringfield, IL 62704", fulfil: "ship", status: "PAID", subtotalCents: 1000, taxCents: 0, totalCents: 1000, tokenHash: `e2e-${RUN}`, paidAt: new Date() });
  try {
    await signIn(page, OWNER);
    await page.goto("/register/online");
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export for Pirate Ship" }).click();
    const file = await readFile((await (await download).path())!, "utf8");
    expect(file).toContain("Name,Company,Address,Address Line 2,City,State,Zipcode");
    expect(file).toContain(`Shipper ${RUN},,12 Elm St,,Springfield,IL,62704,US`);
  } finally {
    await sql(`DELETE FROM "WebOrder" WHERE id = $1`, [order.id]);
  }
});
