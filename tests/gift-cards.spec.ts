// Gift cards at the register (later-round-1): sell a new $50 card for cash, pay part of a sale with it, and void that
// sale to put the money back on the card. The card's own page shows the number and balance.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts); the spec turns counter sales on in the database.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, shopOf, signIn, sql } from "./helpers";

const pn = `GC${RUN}`;

test.afterAll(disconnect);

test("sell a card, pay part of a sale with it, void restores it", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  await signIn(page, OWNER);

  // An item to buy with the card.
  await page.goto("/parts");
  await page.getByLabel("Part number", { exact: true }).fill(pn);
  await page.getByLabel("Description", { exact: true }).fill("Gift card test notion");
  await page.getByLabel("Price each ($, blank = cost + markup)").fill("30.00");
  await page.getByLabel("Quantity on hand").fill("10");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByText("10 on hand")).toBeVisible();

  // Sell a new $50 card, paid in cash.
  await page.goto("/register");
  await page.getByRole("button", { name: "Gift card", exact: true }).first().click();
  await page.getByLabel(/^Amount \(/).fill("50");
  await page.getByRole("button", { name: "Add to sale" }).click();
  const sale = page.getByRole("table", { name: "Sale" });
  await expect(sale).toContainText("Gift card");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale #\d+ done/ })).toBeVisible();
  const printHref = await page.getByRole("link", { name: /Print the gift card/ }).getAttribute("href");
  const cardId = /gift-cards\/([^/]+)\/print/.exec(printHref ?? "")![1];

  await page.goto(`/register/gift-cards/${cardId}`);
  const number = ((await page.getByTestId("card-number").textContent()) ?? "").trim();
  expect(number).toMatch(/^GC-/);
  await expect(page.getByTestId("card-balance")).toHaveText("$50.00");

  // Pay $20 of a $30 sale (plus any tax) with the card, the rest in cash.
  await page.goto("/register");
  await page.locator("#register-code").fill(pn);
  await page.locator("#register-code").press("Enter");
  await expect(sale).toContainText("Gift card test notion");
  await page.getByLabel(/^Gift card or store credit number/).fill(number);
  await page.getByLabel(/^Payment amount/).fill("20");
  await page.getByRole("button", { name: "Gift card", exact: true }).last().click();
  await expect(page.getByText(/Gift card ending/)).toBeVisible();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Sale #\d+ done/ })).toBeVisible();
  const receipt = await page.getByRole("link", { name: "Print receipt" }).getAttribute("href");

  await page.goto(`/register/gift-cards/${cardId}`);
  await expect(page.getByTestId("card-balance")).toHaveText("$30.00");

  // Void that sale: the $20 goes back on the card.
  await page.goto(receipt!);
  await page.getByLabel("Void this sale (rung up by mistake)").fill("spec");
  await page.getByRole("button", { name: "Void sale" }).click();
  await expect(page.getByText("Sale voided")).toBeVisible();
  await page.goto(`/register/gift-cards/${cardId}`);
  await expect(page.getByTestId("card-balance")).toHaveText("$50.00");
});
