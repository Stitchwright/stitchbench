// The status link for a phone-answering service (shop-features-round-2-design.md 5.6): Settings → Customer questions →
// Make a key shows the key once; the link answers hours with it (and 401 without); Turn the status link off stops it.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, one, shopOf, signIn, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

let shopId = "";
let slug = "";

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  slug = (await one<{ s: string | null }>(`SELECT "bookingSlug" AS s FROM "Shop" WHERE id = $1`, [shopId]))?.s ?? "";
  if (!slug) {
    slug = `e2e-${RUN.toLowerCase()}`;
    await sql(`UPDATE "Shop" SET "bookingSlug" = $2 WHERE id = $1`, [shopId, slug]);
  }
});

test.afterAll(async () => {
  if (shopId) await sql(`UPDATE "Shop" SET "statusKeyHash" = NULL, "statusKeyAt" = NULL WHERE id = $1`, [shopId]);
  await disconnect();
});

test("make a key, read hours with it, then turn the link off", async ({ page, request }) => {
  await signIn(page, OWNER);
  await page.goto("/settings/customer-questions");
  await expect(page.getByLabel("Status link")).toHaveValue(new RegExp(`/api/public/v1/${slug}$`));
  await page.getByRole("button", { name: /Make a (new )?key/ }).click();
  const key = await page.getByLabel(/Your key/).inputValue();
  expect(key).toMatch(/^sbk_/);

  const without = await request.get(`/api/public/v1/${slug}/hours`);
  expect(without.status()).toBe(401);
  const withKey = await request.get(`/api/public/v1/${slug}/hours`, { headers: { authorization: `Bearer ${key}` } });
  expect(withKey.status()).toBe(200);
  expect((await withKey.json()).answer).toBeTruthy();
  const nothingElse = await request.get(`/api/public/v1/${slug}/customers`, { headers: { authorization: `Bearer ${key}` } });
  expect(nothingElse.status()).toBe(404);

  await page.reload();
  await page.getByRole("button", { name: "Turn the status link off" }).click();
  await expect(page.getByText("The status link is off.")).toBeVisible();
  const after = await request.get(`/api/public/v1/${slug}/hours`, { headers: { authorization: `Bearer ${key}` } });
  expect(after.status()).toBe(401);
});
