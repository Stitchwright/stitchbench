// Quilt appraisals (shop-features-round-2-design.md 9.8): start an appraisal for a new customer, issue it with the fee by
// card, and open the certificate.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts).
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("appraise a quilt and print its certificate", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "appraiserName" = 'Ruth Appraiser' WHERE id = $1`, [owner.shopId]);
  await signIn(page, OWNER);
  await page.goto("/longarm");
  await page.getByRole("link", { name: "Quilt appraisals" }).click();
  await page.getByLabel("Or a new customer: name").fill(`Quilla ${RUN}`);
  await page.getByLabel("Phone").fill("555-0150");
  await page.getByLabel("The quilt's name").fill(`Flower Garden ${RUN}`);
  await page.getByLabel("Width (inches)").fill("72");
  await page.getByLabel("Length (inches)").fill("90");
  await page.getByLabel("Value ($)").fill("1200");
  await page.getByRole("button", { name: "Start the appraisal" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Appraisal #\d+: Flower Garden ${RUN}`) })).toBeVisible();
  await page.getByLabel("Paid by").selectOption("CARD");
  await page.getByRole("button", { name: "Issue the certificate" }).click();
  await expect(page.getByRole("link", { name: "Print the certificate" })).toBeVisible();
  const href = await page.getByRole("link", { name: "Print the certificate" }).getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { name: "Quilt Appraisal Certificate" })).toBeVisible();
  await expect(page.getByText("Insurance replacement value: $1,200.00").or(page.getByText("Insurance replacement value: $1200.00"))).toBeVisible();
});
