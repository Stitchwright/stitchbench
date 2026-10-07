// Build this quilt from our stock (shop-features-round-2-design.md 5.3) against the test hub and its Anthropic stand-in
// (scripts/local-test/assistant-mock.mjs, which picks the first fabric offered): in the quilt planner, her focus fabric
// chosen, "Suggest coordinates" fills the empty part with a fabric from the shelf and its reason; "Thread to match" offers
// the navy thread on the shelf, and a ticked thread joins the pull list. Without the Assistant the button isn't there.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";
import { assistantOff, assistantOn } from "./helpers/assistant";

test.describe.configure({ mode: "serial" });

let shopId = "";
let patternId = "";
const focus = `Spec Navy ${RUN}`;
const cream = `Spec Cream ${RUN}`;
const collection = `Spec Collection ${RUN}`;

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await assistantOff(shopId);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  patternId = (await insert<{ id: string }>("Part", { shopId, partNumber: `QS-${RUN}`, numberKeys: [`QS${RUN}`], description: `Spec Pattern ${RUN}`, kind: "PATTERN", qtyOnHand: 1, priceCents: 1000 })).id;
  await insert("PatternNeed", { shopId, patternPartId: patternId, size: "Throw", role: "Focus", yards: 1, sortOrder: 0 });
  await insert("PatternNeed", { shopId, patternPartId: patternId, size: "Throw", role: "Background", yards: 2, sortOrder: 1 });
  await insert("Part", { shopId, partNumber: `QSN-${RUN}`, numberKeys: [`QSN${RUN}`], description: focus, kind: "FABRIC", unit: "yd", qtyOnHand: 5, priceCents: 1200, colorTags: ["navy"], collection, colorHex: "#1b2a4a" });
  await insert("Part", { shopId, partNumber: `QSC-${RUN}`, numberKeys: [`QSC${RUN}`], description: cream, kind: "FABRIC", unit: "yd", qtyOnHand: 30, priceCents: 1000, colorTags: ["cream"], collection });
  await insert("Part", { shopId, partNumber: `QST-${RUN}`, numberKeys: [`QST${RUN}`], description: `Isacord Navy ${RUN}`, kind: "THREAD", itemType: "thread", brand: "Isacord", colorNumber: "3644", colorName: "Navy", colorHex: "#1c2b4c", qtyOnHand: 4, priceCents: 899 });
});

test.afterAll(async () => {
  if (shopId) await assistantOff(shopId);
  await disconnect();
});

test("without the Assistant: no Suggest coordinates", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto(`/fabric/quilt?pattern=${patternId}`);
  await expect(page.getByLabel("Yards needed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Suggest coordinates" })).toHaveCount(0);
});

test("suggest coordinates from the shelf, then thread to match", async ({ page }) => {
  await assistantOn(shopId);
  await signIn(page, OWNER);
  await page.goto(`/fabric/quilt?pattern=${patternId}`);
  await page.getByLabel("Focus (1 yd)").selectOption({ label: `${focus} (QSN-${RUN}) · 5 yd · $12.00/yd` });
  await page.getByRole("button", { name: "Suggest coordinates" }).click();
  await expect(page.getByLabel("Background (2 yd)").locator("option:checked")).toHaveText(new RegExp(cream), { timeout: 60_000 });
  await expect(page.getByText("Suggested: Calm and creamy beside the focus")).toBeVisible();
  const list = page.getByRole("table", { name: "Pull list" });
  await expect(list).toContainText(cream);

  await page.getByRole("button", { name: "Thread to match" }).click();
  await page.getByLabel(/Isacord 3644 Navy/).check();
  await expect(list).toContainText("Thread");
  await expect(list).toContainText("Isacord 3644 Navy");
});
