// Inventory: barcode labels, the scanner station (look up, receive, count, use on a ticket) and most-used parts.
// The community most-used list needs a test StitchHub: HUB_URL + HUB_JOIN_KEY (skipped otherwise).
import { test, expect } from "@playwright/test";

const run = Date.now().toString(36).toUpperCase();
const pn = `INV-${run}`;
const alt = `ALT-${run}`;
test.setTimeout(240_000);

test("labels, scanner and most-used parts", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(process.env.E2E_EMAIL ?? "e2e@stitchbench.test");
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Bench" })).toBeVisible();

  // A supply with another number it's sold under.
  await page.goto("/parts");
  await page.locator("#partNumber").fill(pn);
  await page.locator("#description").fill("Test bobbins, class 15");
  await page.locator("#kind").selectOption("SUPPLY");
  await page.locator("#altNumbers").fill(alt);
  await page.locator("#location").fill("A1");
  await page.locator("#price").fill("3.00");
  await page.locator("#qtyOnHand").fill("2");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(pn) })).toBeVisible();
  const partId = page.url().split("/").pop()!;

  // Labels: a barcode of the part number on a sheet and on a thermal label.
  await page.goto(`/labels?id=${partId}&format=sheet&price=1`);
  await expect(page.locator(".label svg").first()).toBeVisible();
  await expect(page.locator(".label .pn").first()).toHaveText(pn);
  await expect(page.locator(".label").first()).toContainText("$3.00");
  await page.goto(`/labels?id=${partId}&format=thermal&copies=2`);
  await expect(page.locator(".label")).toHaveCount(2);
  await page.screenshot({ path: "test-results/labels-thermal.png" });

  // Scanner: the box takes keyboard-wedge input (type + Enter), like a USB scanner.
  await page.goto("/parts/scan");
  const box = page.locator("#scan-code");
  await box.fill(pn);
  await box.press("Enter");
  await expect(page.getByText(`${pn}: 2 on hand, bin A1`)).toBeVisible();
  await page.getByRole("tab", { name: "Receive" }).click();
  await page.locator("#scan-qty").fill("3");
  await box.fill(alt); // its other number finds it too
  await box.press("Enter");
  await expect(page.getByText(`+3 received: ${pn} (now 5)`)).toBeVisible();
  await page.getByRole("tab", { name: "Count shelf" }).click();
  for (let i = 0; i < 4; i++) {
    await box.fill(pn);
    await box.press("Enter");
    await expect(page.getByText(`counted ${i + 1}`)).toBeVisible();
    await page.waitForTimeout(1600); // the same code twice within 1.5 s counts once (camera debounce)
  }
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByText("Saved 1 count")).toBeVisible();
  await page.getByRole("tab", { name: "Use on ticket" }).click();
  await page.locator("#scan-qty").fill("1");
  await box.fill(pn);
  await box.press("Enter");
  await expect(page.getByText(new RegExp(`1 × ${pn} added to ticket #\\d+ \\(3 left\\)`))).toBeVisible();
  await box.fill(`NOPE-${run}`);
  await box.press("Enter");
  await expect(page.getByText(`NOPE-${run} isn't in your parts.`)).toBeVisible();
  await expect(page.getByRole("link", { name: "add as a new part" })).toHaveAttribute("href", `/parts?new=NOPE-${run}#add`);
  await page.screenshot({ path: "test-results/scan-station.png", fullPage: true });

  // Most used in this shop.
  await page.goto("/parts/most-used");
  const row = page.locator("tr", { has: page.getByRole("link", { name: pn }) });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(1)).toHaveText("1");

  // Most used across the community (after this shop reports its counts to the hub).
  if (process.env.HUB_URL) {
    await page.goto("/settings");
    await expect(page.getByText(/Connected to/)).toBeVisible();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Synced with the hub")).toBeVisible({ timeout: 180_000 });
    await page.goto("/parts/most-used?view=community");
    await expect(page.getByText(pn)).toBeVisible();
    await page.screenshot({ path: "test-results/most-used-community.png", fullPage: true });
  }
});
