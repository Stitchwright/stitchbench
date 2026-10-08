// Thread match from a photo (shop-features-round-2-design.md 9.10). Without the Assistant (the E2E shop has none unless
// assistant.spec gave it a key) the register shows no "Match
// from a photo". The full flow (a photo in, threads to pull out) needs the hub to accept the photo feature
// `thread_photo` (stitchhub src/assistant.mjs PHOTO_FEATURES) and the Anthropic stand-in answering its colors
// (scripts/local-test/assistant-mock.mjs).
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts).
import { test, expect } from "@playwright/test";
import { OWNER, PNG, disconnect, shopOf, signIn, sql } from "./helpers";
import { assistantOff, assistantOn } from "./helpers/assistant";

test.afterAll(disconnect);

test("without the Assistant the register has no photo match", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [owner.shopId]);
  await signIn(page, OWNER);
  await page.goto("/register");
  await expect(page.getByRole("button", { name: "Find a color" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Match from a photo" })).toHaveCount(0);
});

test("a photo of her thread gives threads to pull", async ({ page }) => {
  const owner = await shopOf(OWNER);
  await assistantOn(owner.shopId);
  try {
    await signIn(page, OWNER);
    await page.goto("/register");
    await page.getByLabel("Photo of her thread or fabric").setInputFiles({ name: "thread.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByText("Pull these and check them against the swatch card")).toBeVisible();
    await expect(page.getByLabel("Threads to pull")).toContainText("navy");
  } finally {
    await assistantOff(owner.shopId);
  }
});
