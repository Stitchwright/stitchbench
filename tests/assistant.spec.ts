// The Assistant add-on (ai-assistant-scope.md), against the test hub with its Anthropic stand-in:
//   scripts/local-test/assistant-mock.mjs on :3404, and the test hub on :3200 started with
//   ANTHROPIC_API_BASE=http://127.0.0.1:3404 ANTHROPIC_API_KEY=sk-ant-spec (otherwise as start_hub.bat).
// With the module off the buttons are hidden; then the module is switched on (a development key through the owner's CLI,
// and the hub told to give this company the Assistant free, its admin comp): draft a "work done" note and use it, read a
// plate photo at check-in, and ask the manuals a question and get a cited answer. The e2e shop's key is taken away again.
// E2E_EMAIL / E2E_PASSWORD, HUB_URL, HUB_ADMIN_TOKEN as for the other hub specs; DATABASE_URL from .env.
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { OWNER, PNG, RUN, disconnect, insert, one, shopOf, signIn, sql } from "./helpers";

const HUB = process.env.HUB_URL ?? "http://localhost:3200";
const ADMIN = process.env.HUB_ADMIN_TOKEN ?? "local-test-admin-token-123";
const ymd = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  if (shopId) await sql(`DELETE FROM "License" WHERE "shopId" = $1`, [shopId]);
  await disconnect();
});

let shopId = "";
let ticketId = "";
const brand = "SpecBrand";
const model = `SP${RUN.slice(-4)}`;
const key = model.toUpperCase();

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await sql(`DELETE FROM "License" WHERE "shopId" = $1`, [shopId]);
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  const machine = await insert<{ id: string }>("Machine", { shopId, brand, model, modelKey: key });
  const n = (await one<{ n: number }>(`SELECT COALESCE(MAX(number), 0)::int AS n FROM "Ticket" WHERE "shopId" = $1`, [shopId]))!.n + 1;
  ticketId = (await insert<{ id: string }>("Ticket", { shopId, number: n, machineId: machine.id, problem: "Skips stitches", updatedAt: new Date() })).id;
  // A manual for the model, already read into the search index (two pages), as "Index these manuals" leaves it.
  const docId = `spec${RUN}`.toLowerCase();
  await sql(`DELETE FROM "LibraryDoc" WHERE id = $1`, [docId]);
  await insert("LibraryDoc", { id: docId, path: `Sewing\\${brand}\\Spec ${model} Service Manual.pdf`, category: "Sewing", brand, file: `Spec ${model} Service Manual.pdf`, docType: "ServiceManual", modelKeys: [key] });
  await sql(`INSERT INTO "ManualIndexDoc" ("shopId", "docId", "totalPages", "donePages", "blankPages", status, "updatedAt") VALUES ($1, $2, 2, 2, 0, 'done', now())`, [shopId, docId]);
  await insert("ManualPage", { shopId, docId, page: 1, text: "Hook timing procedure. Loosen the timing screw and set the hook to the needle." });
  await insert("ManualPage", { shopId, docId, page: 2, text: "Bobbin case cleaning and oiling points." });
});

test("module off: the Assistant's buttons are hidden", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto(`/tickets/${ticketId}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(model);
  await expect(page.getByRole("button", { name: "Draft it" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draft again" })).toHaveCount(0);
  await expect(page.getByLabel(`Ask the ${brand} ${model} manuals`)).toHaveCount(0);
  await expect(page.getByText("Ask the manuals")).toHaveCount(0);
  await page.goto("/settings/assistant");
  await expect(page.getByText(/isn't turned on|is off for this company/).first()).toBeVisible();
});

test("module on: draft a work-done note, read a plate photo, ask the manuals", async ({ page }) => {
  // The Assistant for this company: a development key (module on) and the hub's comp (the call is allowed without paying).
  execFileSync("npx", ["tsx", "scripts/license/dev.ts", "--grant", shopId, "--modules", "assistant", "--from", ymd(-2), "--until", ymd(60), "--grace", "14"], { stdio: "pipe", shell: process.platform === "win32" });
  const installId = (await one<{ installId: string }>(`SELECT "installId" FROM "HubState" WHERE id = 1`))?.installId;
  expect(installId, "this install must be joined to the test hub").toBeTruthy();
  const comp = await fetch(`${HUB}/v1/admin/assistant/comp`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ installId, shopRef: shopId, until: ymd(60) }) });
  expect(comp.ok, "the hub's comp").toBe(true);

  await signIn(page, OWNER);

  // Draft the invoice's Work done and use it.
  await page.goto(`/tickets/${ticketId}`);
  const box = page.locator('[data-assistant-draft="work_done"]');
  await box.getByRole("button", { name: "Draft it" }).click();
  await expect(box.locator("[data-assistant-text]")).toContainText("We replaced the bobbin case", { timeout: 60_000 });
  await box.getByRole("button", { name: "Use this" }).click();
  await expect(page.locator("#workDone")).toHaveValue(/We replaced the bobbin case/);

  // Ask the manuals: the answer cites the page.
  const ask = page.getByLabel(`Ask the ${brand} ${model} manuals`);
  await ask.fill(`Where is the hook timing procedure for the ${model}?`);
  await ask.locator("xpath=ancestor::form").getByRole("button", { name: "Ask" }).click();
  const answer = page.locator("[data-ask-manuals-answer]");
  await expect(answer).toContainText("Loosen the timing screw", { timeout: 60_000 });
  await expect(answer.locator("[data-manual-cite]").first()).toContainText("p. 1");
  await expect(answer.getByRole("link", { name: /Service Manual/ })).toBeVisible();

  // Read a plate photo at check-in: the fields fill in, the form still has to be saved.
  await page.goto("/tickets/new");
  await page.getByLabel("Photo of the rating plate").setInputFiles({ name: "plate.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Read it" }).click();
  await expect(page.getByLabel("Brand", { exact: true })).toHaveValue("Janome", { timeout: 60_000 });
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("MC6700P");
  await expect(page.getByLabel("Serial number", { exact: true })).toHaveValue("SPEC123456");
});

test("module on, but the draft switch off: the draft buttons go", async ({ page }) => {
  await sql(`INSERT INTO "AssistantSettings" ("shopId", "draftOn", "updatedAt") VALUES ($1, false, now()) ON CONFLICT ("shopId") DO UPDATE SET "draftOn" = false`, [shopId]);
  try {
    await signIn(page, OWNER);
    await page.goto(`/tickets/${ticketId}`);
    await expect(page.getByLabel(`Ask the ${brand} ${model} manuals`)).toBeVisible();
    await expect(page.locator('[data-assistant-draft="work_done"]')).toHaveCount(0);
  } finally {
    await sql(`DELETE FROM "AssistantSettings" WHERE "shopId" = $1`, [shopId]);
  }
});
