// Ask your shop (shop-features-round-2-design.md 5.1) against the test hub and its Anthropic stand-in
// (scripts/local-test/assistant-mock.mjs): without the Assistant the box isn't on Reports; with it, a question picks the
// best sellers report, the answer is worded from its numbers, the table shows underneath with Open this report, and a
// question no report covers lists what it can answer. A tech never sees Reports.
import { test, expect } from "@playwright/test";
import { OWNER, TECH, RUN, disconnect, insert, one, shopOf, signIn, sql } from "./helpers";
import { assistantOff, assistantOn } from "./helpers/assistant";

test.describe.configure({ mode: "serial" });

let shopId = "";
const fabric = `Spec Navy ${RUN}`;

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await assistantOff(shopId);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  const part = await insert<{ id: string }>("Part", { shopId, partNumber: `SPN-${RUN}`, description: fabric, kind: "FABRIC", unit: "yd", qtyOnHand: 10, priceCents: 1200, collection: "Kona Solids", numberKeys: [`SPN${RUN}`] });
  // The shop's own counter hands the number out, so the register's next sale doesn't collide with this one.
  const n = (await one<{ n: number }>(`UPDATE "Shop" SET "nextSaleNumber" = "nextSaleNumber" + 1 WHERE id = $1 RETURNING ("nextSaleNumber" - 1)::int AS n`, [shopId]))!.n;
  const sale = await insert<{ id: string }>("Sale", { shopId, number: n, subtotalCents: 360000, taxCents: 0, totalCents: 360000, taxRatePct: 0, tenders: JSON.stringify([{ method: "CASH", amountCents: 360000 }]) });
  await insert("SaleLine", { saleId: sale.id, partId: part.id, description: fabric, qty: 300, unit: "yd", unitPriceCents: 1200, kind: "FABRIC" });
});

test.afterAll(async () => {
  if (shopId) await assistantOff(shopId);
  await disconnect();
});

test("without the Assistant: no Ask box on Reports", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask your shop" })).toHaveCount(0);
});

test("ask a question: the program's report, worded, with Open this report", async ({ page }) => {
  await assistantOn(shopId);
  await signIn(page, OWNER);
  await page.goto("/reports");
  await page.getByRole("textbox", { name: "Ask your shop" }).fill("Which Kona sold best since spring?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = page.locator("[data-ask-answer]");
  await expect(answer).toContainText("The best seller was", { timeout: 60_000 });
  await expect(answer.getByRole("cell", { name: new RegExp(fabric) })).toBeVisible();
  // Its own row (an earlier run's fabric can be on the list too); money() has no thousands commas.
  await expect(answer.getByRole("row", { name: new RegExp(fabric) }).getByRole("cell", { name: "$3600.00" })).toBeVisible();
  await expect(answer.getByRole("link", { name: "Open this report" })).toHaveAttribute("href", "/fabric?tab=sells");

  await page.getByRole("textbox", { name: "Ask your shop" }).fill("How many unicorns came in?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(answer).toContainText("I can't answer that from your reports yet", { timeout: 60_000 });
  await expect(answer).toContainText("Best sellers");
});

test("the switch off in Settings → Assistant: the box goes", async ({ page }) => {
  await sql(`INSERT INTO "AssistantSettings" ("shopId", "askOn", "updatedAt") VALUES ($1, false, now()) ON CONFLICT ("shopId") DO UPDATE SET "askOn" = false`, [shopId]);
  await signIn(page, OWNER);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask your shop" })).toHaveCount(0);
  await sql(`DELETE FROM "AssistantSettings" WHERE "shopId" = $1`, [shopId]);
});

test("a tech has no Reports", async ({ page }) => {
  await signIn(page, TECH);
  const r = await page.goto("/reports");
  expect(r?.status()).toBe(404);
});
