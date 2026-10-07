// Marketing and web-store drafts (shop-features-round-2-design.md 5.2) against the test hub and its Anthropic stand-in
// (scripts/local-test/assistant-mock.mjs): "Draft it" fills an item's online text, a class's "About the class" (from the
// form as typed) and a new campaign's subject and message from what came in lately; "Draft a social post" gives words to
// copy. Nothing is saved until she saves. Without the Assistant the buttons aren't there.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";
import { assistantOff, assistantOn } from "./helpers/assistant";

test.describe.configure({ mode: "serial" });

let shopId = "";
let partId = "";

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await assistantOff(shopId);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  partId = (await insert<{ id: string }>("Part", { shopId, partNumber: `MKT-${RUN}`, numberKeys: [`MKT${RUN}`], description: `Spec Navy ${RUN}`, kind: "FABRIC", unit: "yd", qtyOnHand: 15, priceCents: 1200, brand: "Robert Kaufman", collection: "Kona Solids" })).id;
  await insert("StockMove", { shopId, partId, qty: 15, reason: "RECEIVED" });
});

test.afterAll(async () => {
  if (shopId) await assistantOff(shopId);
  await disconnect();
});

test("without the Assistant: no Draft it on an item", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto(`/parts/${partId}`);
  await expect(page.getByLabel("Text for customers (optional)")).toBeVisible();
  await expect(page.locator('[data-draft-fill="item"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draft a social post" })).toHaveCount(0);
});

test("an item's online text and a social post", async ({ page }) => {
  await assistantOn(shopId, ["marketing", "scheduling"]);
  await signIn(page, OWNER);
  await page.goto(`/parts/${partId}`);
  await page.locator('[data-draft-fill="item"]').getByRole("button", { name: "Draft it" }).click();
  await expect(page.getByLabel("Text for customers (optional)")).toHaveValue("A soft quilting cotton in a deep navy.", { timeout: 60_000 });
  await expect(page.locator('[data-draft-fill="item"]').getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("button", { name: "Save listing" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
  await page.getByRole("button", { name: "Draft a social post" }).click();
  await expect(page.getByLabel(/Your post/)).toHaveValue(/#quilting/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
});

test("a new class's About the class, from the form as typed", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/classes/new");
  await page.getByLabel("Class name").fill(`Binding basics ${RUN}`);
  await page.locator('[data-draft-fill="class"]').getByRole("button", { name: "Draft it" }).click();
  await expect(page.getByLabel("About the class")).toHaveValue("Learn to bind a quilt in one evening.", { timeout: 60_000 });
});

test("a new campaign: the new arrivals email lands in the subject and message", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/campaigns/new");
  await page.getByRole("button", { name: "Draft a new arrivals email" }).click();
  await expect(page.getByLabel("What the email says")).toHaveValue(/Fresh fabric just arrived/, { timeout: 60_000 });
  await expect(page.locator("#cp-subject")).toHaveValue("New fabric is in");
});
