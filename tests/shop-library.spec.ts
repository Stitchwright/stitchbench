// The Windows program serves the shop's manual library (LIBRARY_DIR) to every device.
// Run against the program: SHOP_LIBRARY=1 npx playwright test shop-library
import { test, expect } from "@playwright/test";

test.skip(!process.env.SHOP_LIBRARY, "set SHOP_LIBRARY=1 to test the Windows program's manual library");

test("manuals and figures come from the shop PC", async ({ page }) => {
  // Sign-up closes once a company exists.
  expect((await page.request.get("/signup")).status()).toBe(404);

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(process.env.E2E_EMAIL ?? "e2e@stitchbench.test");
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Bench" })).toBeVisible();

  expect(await (await page.request.get("/api/library/status")).json()).toEqual({ enabled: true });
  const pdf = await page.request.get("/api/library/file?path=Sewing/Janome/ServiceManuals/Janome_MC6700P_ServiceManual_2017.pdf");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  // Nothing outside the library, and only PDFs.
  expect((await page.request.get("/api/library/file?path=../Windows/win.ini")).status()).toBe(400);
  expect((await page.request.get("/api/library/file?path=CLAUDE.md")).status()).toBe(400);

  // Industrial figures aren't cut ahead of time: the first view draws it from the shop PC's copy of the manual
  // (and saves it). Once saved it shows as a picture, and "Whole page" still draws from the shop PC.
  await page.goto("/models/Juki/DDL-8700");
  await page.getByRole("button", { name: "Show figure" }).first().click();
  const stored = page.locator('img[src^="/api/figures/"]').first();
  await page.waitForTimeout(1000);
  if (await stored.count()) {
    await expect.poll(() => stored.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await stored.screenshot({ path: "test-results/shop-library-stored.png" });
    await page.getByRole("button", { name: "Whole page" }).first().click();
  }
  const canvas = page.locator("canvas:not(.hidden)").first();
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.height), { timeout: 60_000 }).toBeGreaterThan(150);
  await expect(page.getByText(/Drawing page/)).toHaveCount(0, { timeout: 60_000 });
  await canvas.screenshot({ path: "test-results/shop-library-figure.png" });

  // "Open" on a manual opens it from the shop PC.
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: /^Open/ }).first().click();
  const tab = await popup;
  await tab.waitForLoadState();
  expect(tab.url()).toContain("/api/library/file?path=");
});
