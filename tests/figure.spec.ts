// Manual figures are drawn from the tech's own PDF. The real folder picker can't be scripted, so this uses
// the pick-a-folder fallback (what Firefox/Safari get) with MANUAL_DIR, a folder holding the manual.
// Needs an E2E shop that already has a machine of MANUAL_BRAND + MANUAL_MODEL (the smoke test makes one).
import { test, expect } from "@playwright/test";

const dir = process.env.MANUAL_DIR!;
const label = `${process.env.MANUAL_BRAND ?? "Janome"} ${process.env.MANUAL_MODEL ?? "MC6700P"}`;

test.skip(!process.env.MANUAL_DIR, "set MANUAL_DIR to a folder holding the manual (MANUAL_BRAND and MANUAL_MODEL if it isn't a Janome MC6700P)");

test("draws a timing figure from the tech's own manual", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(process.env.E2E_EMAIL!);
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Bench" })).toBeVisible();

  // Picked files live in memory for the visit, so move around with in-app links from here on.
  await page.getByRole("link", { name: "My manuals" }).click();
  await page.locator("#pick-folder").setInputFiles(dir);
  await expect(page.getByText(/PDFs indexed/)).toBeVisible();

  await page.getByRole("link", { name: "Machines" }).click();
  await page.getByRole("link", { name: label }).first().click();
  await expect(page.getByRole("heading", { name: /Timing and adjustments/ })).toBeVisible();
  await page.getByRole("button", { name: "Show figure" }).first().click();
  await expect(page.getByRole("button", { name: "Hide figure" }).first()).toBeVisible({ timeout: 60_000 });
  page.on("console", (m) => m.type() === "error" && console.log("[browser error]", m.text()));
  const stored = page.locator('img[src^="/api/figures/"]').first();
  if (await stored.count()) {
    // Figure already saved online: it must load, and "Whole page" still draws from the tech's own PDF.
    await expect.poll(() => stored.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Whole page" }).first().click();
  }
  const canvas = page.locator("canvas:not(.hidden)").first();
  // the page is drawn once the canvas takes the crop's size (a fresh canvas is 300x150)
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.height), { timeout: 60_000 }).toBeGreaterThan(150);
  await expect(page.getByText(/Drawing page/)).toHaveCount(0);
  await canvas.screenshot({ path: "test-results/figure-canvas.png" });
  await page.screenshot({ path: "test-results/figure-page.png" });
});
