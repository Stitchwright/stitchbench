// The counter register: a return paid back in cash, and a handheld scan that lands in a line's Qty field.
// E2E_EMAIL / E2E_PASSWORD must be an owner of a throwaway shop (it turns on counter sales and creates records).
import { test, expect } from "@playwright/test";

const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const pn = `REG${Date.now().toString().slice(-6)}`;

test("cash refund, and a scan while a Qty field has focus", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // Counter sales on, and an item to sell.
  await page.goto("/settings#company");
  const company = page.locator("#company");
  await company.locator('input[name="sellsRetail"]').check();
  await company.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.goto("/parts");
  await page.getByLabel("Part number", { exact: true }).fill(pn);
  await page.getByLabel("Description", { exact: true }).fill("Spool of thread (test)");
  await page.getByLabel("Cost each ($)").fill("2.00");
  await page.getByLabel("Price each ($, blank = cost + markup)").fill("4.99");
  await page.getByLabel("Quantity on hand").fill("10");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByText("10 on hand")).toBeVisible();

  // A return paid back in cash from the drawer.
  await page.goto("/register");
  const sale = page.getByRole("table", { name: "Sale" });
  await page.getByRole("button", { name: /Return mode/ }).click();
  await page.locator("#register-code").fill(pn);
  await page.locator("#register-code").press("Enter");
  await expect(sale).toContainText("Spool of thread (test)");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);

  // Type a quantity like a person, then scan the same item like a handheld scanner (fast keys, then Enter): the scan
  // rings up one more instead of landing in the Qty field.
  await page.locator("#register-code").fill(pn);
  await page.locator("#register-code").press("Enter");
  const qty = page.getByLabel("Qty for Spool of thread (test)");
  await qty.click();
  await qty.press("Control+A");
  await page.keyboard.type("2", { delay: 150 });
  await page.waitForTimeout(300);
  await page.keyboard.type(pn, { delay: 5 });
  await page.keyboard.press("Enter");
  await expect(qty).toHaveValue("3");
  await expect(page.locator("#register-code")).toBeFocused();
});
