// Screen-by-screen demo of StitchBench, saved as PNGs (+ a video) in DEMO_DIR.
// Runs against the throwaway E2E shop only:  DEMO_DIR=C:\path npx playwright test walkthrough
// DEMO_PHOTO: an image to upload as a "wiring & connectors" photo. The Companies screen needs the E2E login in PLATFORM_ADMIN_EMAILS.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const dir = process.env.DEMO_DIR;
const owner = { email: process.env.E2E_EMAIL ?? "e2e@stitchbench.test", password: process.env.E2E_PASSWORD ?? "e2e-password-1" };
const tech = { name: "Sam (demo tech)", email: "sam.demo@stitchbench.test", password: "demo-tech-pass1" };
const caption = "CN5 main motor plug: red wire to pin 1, latch faces the hook";
const shareTitle = "CN5 motor plug works loose and the machine stops with E7";

test.skip(!dir, "set DEMO_DIR to record the walkthrough");
test.use({ video: { mode: "on", size: { width: 1400, height: 1000 } }, launchOptions: { slowMo: 200 } });

let n = 0;
async function shot(page: Page, name: string, fullPage = false) {
  if (fullPage) {
    // walk down the page so lazy pictures and manual figures load
    const h = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < h; y += 700) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForLoadState("networkidle");
  }
  n += 1;
  await page.screenshot({ path: path.join(dir!, `${String(n).padStart(2, "0")}-${name}.png`), fullPage });
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();
}

test("walkthrough", async ({ page }) => {
  await page.goto("/login");
  await shot(page, "login");

  await signIn(page, owner);
  await shot(page, "bench");

  // Company settings: employees and their logins
  await page.goto("/settings");
  const people = page.getByRole("heading", { name: "People" });
  if (!(await page.getByText(tech.email).count())) {
    await page.locator("#u-name").fill(tech.name);
    await page.locator("#u-email").fill(tech.email);
    await page.locator("#u-pw").fill(tech.password);
    await page.locator("#u-role").selectOption("TECH");
    await page.getByRole("button", { name: "Add person" }).click();
    await expect(page.getByText(tech.email)).toBeVisible();
  }
  await people.scrollIntoViewIfNeeded();
  await shot(page, "people");

  await page.goto("/machines");
  await shot(page, "machines");

  // Machine page: a wiring photo with a caption, then share it with every shop
  await page.getByRole("link", { name: /Janome MC6700P/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const machineUrl = page.url();
  if (process.env.DEMO_PHOTO && !(await page.getByText(caption).count())) {
    await page.locator('[id^="photo-kind-"]').selectOption("WIRING");
    await page.locator('[id^="photo-caption-"]').fill(caption);
    await page.locator('input[type="file"][id^="photo-"]').setInputFiles(process.env.DEMO_PHOTO);
    await expect(page.getByText(caption).first()).toBeVisible();
  }
  await page.getByRole("heading", { name: "Photos" }).scrollIntoViewIfNeeded();
  await shot(page, "machine-photos");

  if (!(await page.getByText(shareTitle).count())) {
    await page.locator("summary", { hasText: "Share with other techs" }).click();
    await page.locator("#share-kind").selectOption("GOTCHA");
    await page.locator("#share-title").fill(shareTitle);
    await page
      .locator("#share-body")
      .fill("E7 at random. The CN5 plug on the main board backs out a millimetre. Reseat it and add a dab of hot glue on the latch side. Photo shows pin 1 (red).");
    await page.locator("summary", { hasText: "Share with other techs" }).scrollIntoViewIfNeeded();
    await shot(page, "share-form");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(page.getByText(shareTitle).first()).toBeVisible();
  }
  await shot(page, "machine-page", true);

  await page.goto("/models/Janome/MC6700P");
  await shot(page, "model-janome-mc6700p", true);

  await page.goto("/models/Juki/DDL-8700");
  await shot(page, "model-juki-ddl8700", true);

  await page.goto("/specs?tab=settings&q=MC6700P");
  await shot(page, "specs-timing", true);

  await page.goto("/tickets");
  await shot(page, "tickets");
  await page.locator("table tbody a").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await shot(page, "ticket", true);

  await page.goto("/invoices?show=all");
  await shot(page, "invoices");
  await page.locator("table tbody a").first().click();
  await shot(page, "invoice", true);

  await page.goto("/price-list");
  await shot(page, "price-list", true);

  await page.goto("/settings");
  await page.getByRole("heading", { name: "Service menu and price list" }).scrollIntoViewIfNeeded();
  await shot(page, "price-list-editing");

  await page.goto("/shared");
  await shot(page, "shared");

  await page.goto("/companies");
  if (await page.getByRole("heading", { name: "Companies" }).count()) await shot(page, "companies", true);

  await page.goto("/sales");
  await shot(page, "sales");

  // The employee signs in with their own login
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/login/);
  await signIn(page, tech);
  await shot(page, "tech-bench");
  await page.goto(machineUrl);
  await shot(page, "tech-machine");
  await page.goto("/settings");
  await shot(page, "tech-settings");
});
