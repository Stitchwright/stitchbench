// Customer answers on the booking page (shop-features-round-2-design.md 5.6): off until Settings → Customer questions
// turns it on; then, signed out, the public page's Questions? answers Hours and Is my machine ready? (ticket number and
// the last four digits of the phone, from the shop's records), a typed question with the Assistant (the test hub's
// stand-in sorts it), and Leave a question, which shows on the staff's Customer questions list (Answered, Undo).
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, one, shopOf, signIn, sql } from "./helpers";
import { assistantOff, assistantOn } from "./helpers/assistant";

test.describe.configure({ mode: "serial" });

let shopId = "";
let slug = "";
let ticketNo = 0;
const question = `Do you sell Featherweight bobbins? ${RUN}`;

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await assistantOff(shopId);
  slug = (await one<{ s: string | null }>(`SELECT "bookingSlug" AS s FROM "Shop" WHERE id = $1`, [shopId]))?.s ?? "";
  if (!slug) {
    slug = `e2e-${RUN.toLowerCase()}`;
    await sql(`UPDATE "Shop" SET "bookingSlug" = $2 WHERE id = $1`, [shopId, slug]);
  }
  const cust = await insert<{ id: string }>("Customer", { shopId, name: `Quinn Question ${RUN}`, phone: "312-867-5309" });
  const machine = await insert<{ id: string }>("Machine", { shopId, brand: "Janome", model: `CQ${RUN}`, modelKey: `CQ${RUN}`, kind: "sewing", equipment: "SEWING" });
  ticketNo = (await one<{ n: number }>(`SELECT COALESCE(MAX(number), 0)::int AS n FROM "Ticket" WHERE "shopId" = $1`, [shopId]))!.n + 1;
  await insert("Ticket", { shopId, number: ticketNo, machineId: machine.id, customerId: cust.id, status: "READY_FOR_PICKUP", updatedAt: new Date() });
});

test.afterAll(async () => {
  if (shopId) await assistantOff(shopId);
  await disconnect();
});

test("off by default: the public page has no Questions", async ({ page }) => {
  await page.goto(`/book/${slug}`);
  await expect(page.getByRole("heading", { name: "Questions?" })).toHaveCount(0);
});

test("the owner turns it on with the opening hours", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/settings/customer-questions");
  await page.getByLabel(/Answer customers' questions on your booking page/).check();
  await page.getByLabel("Monday", { exact: true }).check();
  await page.getByLabel("Monday opens").fill("09:30");
  await page.getByLabel("Monday closes").fill("17:00");
  await page.getByLabel("A line under the hours (optional)").fill("Closed on holidays.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
});

test("signed out: Hours, Is my machine ready?, and a question for a person", async ({ page }) => {
  await page.goto(`/book/${slug}`);
  await expect(page.getByRole("heading", { name: "Questions?" })).toBeVisible();
  await page.getByRole("button", { name: "Hours" }).click();
  await expect(page.locator("[data-qa-answer]")).toContainText("Monday, 9:30 am to 5 pm");
  await expect(page.locator("[data-qa-answer]")).toContainText("Closed on holidays.");
  await page.getByRole("button", { name: "Is my machine ready?" }).click();
  await page.getByLabel("Ticket number").fill(String(ticketNo));
  await page.getByLabel("Last 4 digits of your phone").fill("0000");
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.locator("[data-qa-answer]")).toContainText("couldn't find a ticket");
  await page.getByLabel("Last 4 digits of your phone").fill("5309");
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.locator("[data-qa-answer]")).toContainText(`(ticket #${ticketNo}) is ready for pickup.`);
  await page.getByRole("button", { name: "Leave a question for the shop" }).click();
  await page.getByLabel("Your question").fill(question);
  await page.getByLabel("Your name").fill("Quinn");
  await page.getByLabel("Phone or email").fill("quinn@example.com");
  await page.getByRole("button", { name: "Send it to the shop" }).click();
  await expect(page.locator("[data-qa-answer]")).toContainText("We'll get back to you");
});

test("staff: the question is on the list; Answered, then Undo", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/customer-questions");
  const row = page.getByRole("listitem").filter({ hasText: question });
  await expect(row).toContainText("quinn@example.com");
  await row.getByRole("button", { name: "Answered" }).click();
  await expect(page.getByLabel("Questions waiting").getByText(question)).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByLabel("Questions waiting").getByText(question)).toBeVisible();
});

test("with the Assistant: a typed question is sorted and answered from the records", async ({ page }) => {
  await assistantOn(shopId);
  await sql(`UPDATE "AssistantSettings" SET "customerOn" = true WHERE "shopId" = $1`, [shopId]);
  await page.goto(`/book/${slug}`);
  await page.getByLabel("Or type your question").fill("When are you open on Monday?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator("[data-qa-answer]")).toContainText("Monday, 9:30 am to 5 pm", { timeout: 60_000 });
});
