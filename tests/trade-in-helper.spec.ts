// The trade-in helper (shop-features-round-2-design.md 5.4) on the register's trade-in step, against the test hub and its
// Anthropic stand-in (scripts/local-test/assistant-mock.mjs): "What is it worth?" shows the shop's own past sales of used
// units of the model and the rule (less 30%), and "Use" puts the number in the credit; with the Assistant, condition
// photos and "Draft a condition note" fill the staff-only note, which goes with the trade-in.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, PNG, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";
import { assistantOff, assistantOn } from "./helpers/assistant";

test.describe.configure({ mode: "serial" });

let shopId = "";
const model = `TI${RUN.slice(-5)}`;
const customerName = `Tina Trade ${RUN}`;

async function openTrade(page: Page) {
  await page.goto("/register");
  await page.locator("#register-customer").fill(customerName.slice(0, 12));
  await page.getByRole("button", { name: customerName }).first().click();
  await page.getByRole("button", { name: "Trade-in" }).click();
  const trade = page.getByLabel("Trade-in", { exact: true });
  await trade.getByLabel("What kind").selectOption("sewing").catch(() => {});
  await trade.getByLabel("Brand").fill("Janome");
  await trade.getByLabel("Model").fill(model);
  return trade;
}

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await assistantOff(shopId);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  await insert("Customer", { shopId, name: customerName });
  // Two used units of the model sold here: $600 after 20 days and $700 after 40.
  for (const [cents, days, n] of [
    [60_000, 20, 1],
    [70_000, 40, 2],
  ] as const) {
    const m = await insert<{ id: string }>("Machine", { shopId, brand: "Janome", model, modelKey: model.toUpperCase(), serial: `${model}-${n}`, kind: "sewing", equipment: "SEWING" });
    const created = new Date(Date.now() - (days + 5) * 86_400_000);
    await insert("StockUnit", { shopId, machineId: m.id, status: "SOLD", condition: "USED", createdAt: created, soldAt: new Date(created.getTime() + days * 86_400_000), soldNetCents: cents, updatedAt: new Date() });
  }
});

test.afterAll(async () => {
  if (shopId) await assistantOff(shopId);
  await disconnect();
});

test("What is it worth? The shop's own sales and the rule; Use puts it in the credit", async ({ page }) => {
  await signIn(page, OWNER);
  const trade = await openTrade(page);
  await expect(trade.getByRole("button", { name: "Draft a condition note" })).toHaveCount(0);
  await trade.getByRole("button", { name: "What is it worth?" }).click();
  await expect(trade.locator("[data-trade-in-value]")).toContainText(`2 used Janome ${model} sold here: about $650.00`);
  await expect(trade.locator("[data-trade-in-value]")).toContainText("start at $455.00");
  await trade.getByRole("button", { name: "Use $455.00" }).click();
  await expect(trade.getByLabel("Credit ($)")).toHaveValue("455.00");
});

test("with the Assistant: condition photos draft the staff-only note", async ({ page }) => {
  await assistantOn(shopId);
  await signIn(page, OWNER);
  const trade = await openTrade(page);
  await trade.getByLabel(/Condition photos/).setInputFiles([
    { name: "a.png", mimeType: "image/png", buffer: PNG },
    { name: "b.png", mimeType: "image/png", buffer: PNG },
  ]);
  await trade.getByRole("button", { name: "Draft a condition note" }).click();
  await expect(trade.getByLabel(/Condition note/)).toHaveValue("Light scratches on the bed, bobbin cover missing.", { timeout: 60_000 });
});
