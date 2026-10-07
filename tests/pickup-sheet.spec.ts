// The pickup sheet (shop-features-round-2-design.md 5.5) against the test hub and its Anthropic stand-in
// (scripts/local-test/assistant-mock.mjs): Settings → Care tips (the starters with one tap, remove with Undo), then on a
// ready ticket "Draft the pickup sheet" fills What we did and ticks tips from the shop's own list; saved, it prints with
// the invoice. Fabric insight's "At a glance" gets "Say it in words".
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, one, shopOf, signIn, sql } from "./helpers";
import { assistantOff, assistantOn } from "./helpers/assistant";

test.describe.configure({ mode: "serial" });

let shopId = "";
let ticketId = "";

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await assistantOff(shopId);
  await sql(`DELETE FROM "CareTip" WHERE "shopId" = $1 AND kind = 'sewing'`, [shopId]);
  const machine = await insert<{ id: string }>("Machine", { shopId, brand: "Janome", model: `PK${RUN}`, modelKey: `PK${RUN}`, kind: "sewing", equipment: "SEWING" });
  const n = (await one<{ n: number }>(`SELECT COALESCE(MAX(number), 0)::int AS n FROM "Ticket" WHERE "shopId" = $1`, [shopId]))!.n + 1;
  ticketId = (await insert<{ id: string }>("Ticket", { shopId, number: n, machineId: machine.id, status: "READY_FOR_PICKUP", workDone: "retimed hook, clean and oil", updatedAt: new Date() })).id;
});

test.afterAll(async () => {
  if (shopId) await assistantOff(shopId);
  await disconnect();
});

test("Settings → Care tips: the starters, and remove with Undo", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/settings/care-tips");
  const sewing = page.locator("section").filter({ has: page.getByRole("heading", { name: "For a sewing machine" }) });
  await sewing.getByRole("button", { name: "Add the starter tips" }).click();
  const list = page.getByLabel("Care tips for a sewing machine");
  await expect(list).toContainText("Change the needle every 8 hours of sewing");
  await list.getByRole("listitem").first().getByRole("button", { name: "Remove" }).click();
  await expect(list).not.toContainText("Change the needle every 8 hours of sewing");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(list).toContainText("Change the needle every 8 hours of sewing");
});

test("a ready ticket: draft the pickup sheet, save it, and it prints with the invoice", async ({ page }) => {
  await assistantOn(shopId);
  await signIn(page, OWNER);
  await page.goto(`/tickets/${ticketId}`);
  await page.getByRole("button", { name: "Draft the pickup sheet" }).click();
  await expect(page.getByLabel(/What we did/)).toHaveValue("We cleaned, oiled and retimed your machine.", { timeout: 60_000 });
  await expect(page.getByLabel("Change the needle every 8 hours of sewing, or when you start a new project.")).toBeChecked();
  await page.getByRole("button", { name: "Save the pickup sheet" }).click();
  await expect(page.getByText("Saved: it prints with the invoice")).toBeVisible();
  await page.goto(`/tickets/${ticketId}/invoice`);
  await expect(page.getByText("What we did")).toBeVisible();
  await expect(page.getByText("We cleaned, oiled and retimed your machine.")).toBeVisible();
  await expect(page.getByText("Caring for your sewing machine")).toBeVisible();
  await expect(page.getByText("Change the needle every 8 hours of sewing, or when you start a new project.")).toBeVisible();
});

test("fabric insight: Say it in words, when there are cards", async ({ page }) => {
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  await signIn(page, OWNER);
  await page.goto("/fabric?tab=sells");
  const glance = page.locator("[data-insight-words]");
  test.skip((await glance.count()) === 0, "the e2e shop has no fabric sales to make cards from");
  await glance.getByRole("button", { name: "Say it in words" }).click();
  await expect(glance).toContainText("In words: card c1.", { timeout: 60_000 });
});
