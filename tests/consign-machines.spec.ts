// Customers' machines on consignment (shop-features-round-2-design.md 9.6): make a machine for sale a customer's, sell it
// at the register, and pay her from Paperwork → Consigned machines.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). Rows made here are removed at the end.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("consign a machine, sell it, pay her", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  await insert("Customer", { shopId: owner.shopId, name: `Connie ${RUN}`, phone: "555-0199" });
  const machine = await insert<{ id: string }>("Machine", { shopId: owner.shopId, brand: "Bernina", model: `C${RUN}`, modelKey: `C${RUN}`, serial: `S${RUN}` });
  const unit = await insert<{ id: string }>("StockUnit", { shopId: owner.shopId, machineId: machine.id, condition: "USED", priceCents: 40000, updatedAt: new Date() });
  try {
    await signIn(page, OWNER);
    await page.goto(`/units/${unit.id}`);
    await page.getByLabel("Existing customer").fill(`Connie ${RUN}`);
    await page.getByRole("button", { name: new RegExp(`Connie ${RUN}`) }).click();
    await page.getByLabel("The shop keeps (%)").fill("25");
    await page.getByRole("button", { name: "Save" }).first().click();
    await expect(page.getByText(/she gets \$300.00 if it sells at \$400.00/)).toBeVisible();

    await page.goto("/register");
    await page.locator("#register-code").fill(`S${RUN}`);
    await page.locator("#register-code").press("Enter");
    await page.locator("#register-customer").fill(`Connie ${RUN}`);
    await page.getByRole("button", { name: new RegExp(`Connie ${RUN}`) }).click();
    await page.getByRole("button", { name: "Cash", exact: true }).click();
    await page.getByRole("button", { name: "Complete sale" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Sale #\d+ done/ })).toBeVisible();

    await page.goto("/paperwork/consign");
    await page.getByLabel("Pay her by").first().selectOption("CASH");
    await page.getByRole("button", { name: "Pay her $300.00" }).click();
    await expect(page.getByText("Paid by cash")).toBeVisible();
  } finally {
    await sql(`DELETE FROM "ConsignPayout" WHERE "unitId" = $1`, [unit.id]);
  }
});
