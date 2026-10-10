// "Bigger text" (Settings → Text size): Larger grows the root font size on other pages and after a reload, a print page
// stays at its designed size, Normal restores. Every role can reach it (the tech too).
//   E2E_BASE_URL=http://localhost:3300 npx playwright test tests/text-size.spec.ts --workers 1
import { test, expect, type Page } from "@playwright/test";
import { OWNER, TECH, disconnect, signIn, sql } from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await sql(`UPDATE "User" SET "textSize" = NULL WHERE email = ANY($1)`, [[OWNER.email, TECH.email]]);
  await disconnect();
});

const rootPx = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

async function choose(page: Page, size: "normal" | "large" | "larger", px: number) {
  await page.goto("/settings");
  await page.getByTestId(`text-size-${size}`).click();
  await expect(page.getByTestId(`text-size-${size}`)).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => rootPx(page)).toBe(px);
}

test("owner: Larger grows every page, survives reload, print stays normal, Normal restores", async ({ page }) => {
  await signIn(page, OWNER);
  await choose(page, "larger", 20.8);
  await page.goto("/customers");
  expect(await rootPx(page)).toBe(20.8);
  await page.reload();
  expect(await rootPx(page)).toBe(20.8);
  await page.goto("/classes/print");
  await expect.poll(() => rootPx(page)).toBe(16);
  await page.goto("/settings");
  expect(await rootPx(page)).toBe(20.8);
  await choose(page, "normal", 16);
  await page.goto("/customers");
  expect(await rootPx(page)).toBe(16);
});

test("tech can choose it too, and the sign-in page remembers it on this device", async ({ page }) => {
  await signIn(page, TECH);
  await choose(page, "large", 18.4);
  await page.context().clearCookies({ name: /session|authjs/ });
  await page.goto("/login");
  expect(await rootPx(page)).toBe(18.4);
});
