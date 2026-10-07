// A module that ended (modules-design.md 13.2, modules-e2e acceptance 3). Company D gets a vac key that ended 20 days
// ago with 14 days' grace (dev.ts --grant); the admin turns vac on for D, D checks in vacuum ticket T1 and sells a unit,
// then the admin lets the keys decide. D's pages are read-only, T1 can still be finished, the unit can still be
// returned, the export still has T1. Company E's key ended 10 days ago: the "keeps working until" banner, and it can
// still check in a vacuum.
//   Runs on a TEST BUILD against the local database (DATABASE_URL in this process for dev.ts and the helpers).
import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";
import { clearModuleSwitch, setModule } from "./helpers/modules";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const DAY = 86_400_000;
const ymd = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY).toISOString().slice(0, 10);
const d = { name: `D ${RUN}`, owner: { email: `d-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD } };
const e = { name: `E ${RUN}`, owner: { email: `e-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD } };
const serial = `LT${RUN}`;
const unitSerial = `LU${RUN}`;
let admin: Page;
let dId: string;
let eId: string;
let t1Url: string;
const made: string[] = [];

async function createCompany(name: string, email: string) {
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(name);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill(`Owner of ${name}`);
  await admin.getByLabel("Owner's email (their login)").fill(email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  const id = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [name]))[0].id;
  made.push(id);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true WHERE id = $1`, [id]);
  return id;
}

/** A development key through the owner's CLI, as the design says: the License row is written straight to the database. */
function grant(shopId: string, from: string, until: string, grace: number) {
  execFileSync("npx", ["tsx", "scripts/license/dev.ts", "--grant", shopId, "--modules", "vac", "--from", from, "--until", until, "--grace", String(grace)], { stdio: "pipe", shell: process.platform === "win32" });
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  dId = await createCompany(d.name, d.owner.email);
  eId = await createCompany(e.name, e.owner.email);
  grant(dId, ymd(-385), ymd(-20), 14);
  grant(eId, ymd(-375), ymd(-10), 14);
});

test.afterAll(async () => {
  for (const id of made) {
    await sql(`DELETE FROM "Ticket" WHERE "shopId" = $1`, [id]);
    await sql(`DELETE FROM "StockUnit" WHERE "shopId" = $1`, [id]);
    await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  }
  await disconnect();
  await admin.context().close();
});

test("set-up: the admin turns vac on for D; D checks in T1 and sells a unit; then the keys decide", async ({ browser }) => {
  await setModule(admin, d.name, "Vac Shop", true);
  const page = await login(browser, d.owner);
  await page.goto("/tickets/new?kind=vacuum");
  await page.getByLabel("New customer name").fill(`D Customer ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("Hoover");
  await page.getByLabel("Model", { exact: true }).fill("UH70120");
  await page.getByLabel("Serial number", { exact: true }).fill(serial);
  await page.getByLabel("Bags or bagless").selectOption("Bagged");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Hoover UH70120/ })).toBeVisible();
  t1Url = page.url();
  await page.getByLabel("Suction as found").fill("50");
  await page.getByRole("button", { name: "Save readings" }).click();
  await expect(page.getByText("Readings saved")).toBeVisible();

  await page.goto("/units?kind=vacuum");
  await page.getByLabel("Brand", { exact: true }).fill("Miele");
  await page.getByLabel("Model", { exact: true }).fill("C3");
  await page.getByLabel("Bags or bagless").selectOption("Bagged");
  await page.getByLabel("Serial numbers, one per line (one vacuum each)").fill(unitSerial);
  await page.getByLabel("Price ($)").fill("499.00");
  await page.getByRole("button", { name: "Add to stock" }).click();
  await expect(page.getByRole("heading", { name: "Miele C3" })).toBeVisible();
  await page.goto("/register");
  await page.locator("#register-customer").fill("D Customer");
  await page.getByRole("button", { name: `D Customer ${RUN}` }).first().click();
  await page.getByRole("button", { name: "Machine for sale" }).click();
  await page.getByRole("button", { name: "Look up" }).click();
  await page.getByRole("button", { name: "Add $499.00" }).click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);
  await page.context().close();

  await clearModuleSwitch(admin, d.name, "Vac Shop");
});

test("D after the end: read-only units, no new vacuum check-in, T1 finishes, the unit returns, the export has T1", async ({ browser }) => {
  const page = await login(browser, d.owner);
  // Machines for sale is for every shop now: the list stays, but a vacuum can't be added (sewing machines still can).
  await page.goto("/units?kind=vacuum");
  await expect(page.getByLabel("Serial numbers, one per line (one vacuum each)")).toHaveCount(0);
  await expect(page.getByLabel("Serial numbers, one per line (one machine each)")).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(unitSerial) })).toHaveCount(0); // the Sold tab has it; In stock is empty
  await page.goto("/units?tab=sold");
  await expect(page.getByRole("row", { name: new RegExp(unitSerial) })).toContainText("Sold");

  await page.goto("/tickets/new?kind=vacuum");
  await expect(page.getByText(/ended on/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Check in a sewing machine instead" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create ticket" })).toHaveCount(0);

  // T1 came in before the end: a line, Ready, Collected, a payment; then it is closing-only.
  await page.goto(t1Url);
  await page.getByLabel("Hours", { exact: true }).fill("0.5");
  await page.getByRole("button", { name: "Add labor" }).click();
  await expect(page.getByText("Repair labor")).toBeVisible();
  await page.locator("#status").selectOption("READY_FOR_PICKUP");
  await expect(page.getByText("Status: Ready - customer called")).toBeVisible();
  await page.locator("#status").selectOption("COLLECTED");
  await expect(page.getByText("Status: Collected by customer")).toBeVisible();
  const payment = page.locator("form", { has: page.getByRole("button", { name: "Record payment" }) });
  await payment.getByLabel("Amount", { exact: true }).fill("10.00");
  await payment.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Payment recorded")).toBeVisible();
  await page.reload();
  await expect(page.getByText(/ended on/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add labor" })).toHaveCount(0);
  const options = await page.locator("#status option").allTextContents();
  expect(options.sort()).toEqual(["Abandoned", "Collected by customer", "Returned unrepaired"].sort());

  // "Return a machine" still refunds the unit (money already owed).
  await page.goto("/register");
  await page.getByRole("button", { name: /Return mode off/ }).click();
  await page.getByRole("button", { name: "Return a machine" }).click();
  await page.getByRole("button", { name: "Look up" }).click();
  await page.getByRole("button", { name: "Refund $499.00" }).click();
  await expect(page.getByRole("table", { name: "Sale" })).toContainText(`Return: Miele C3`);
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);
  const unit = await sql<{ status: string }>(`SELECT status FROM "StockUnit" WHERE "shopId" = $1`, [dId]);
  expect(unit[0].status).toBe("IN_STOCK");

  // The export still carries T1 with its readings.
  const csv = await (await page.request.get("/api/export/tickets")).text();
  expect(csv).toContain(serial);
  expect(csv).toMatch(/suction/);
  await page.context().close();
});

test("E in its grace days: the banner says it keeps working until, not on the printed invoice, and a vacuum can be checked in", async ({ browser }) => {
  const page = await login(browser, e.owner);
  await page.goto("/");
  await expect(page.getByText(/Vac Shop ended on .* It keeps working until/)).toBeVisible();
  await page.goto("/tickets/new?kind=vacuum");
  await page.getByLabel("New customer name").fill(`E Customer ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("Sebo");
  await page.getByLabel("Model", { exact: true }).fill("X4");
  await page.getByLabel("Bags or bagless").selectOption("Bagged");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Sebo X4/ })).toBeVisible();
  await page.getByRole("link", { name: "Invoice", exact: true }).first().click();
  // The banner is on the page but inside a no-print block, so the printed invoice doesn't carry it.
  await expect(page.locator(".no-print", { hasText: /keeps working until/ })).toHaveCount(1);
  await expect(page.locator(".receipt, .invoice, main section").filter({ hasText: /keeps working until/ })).toHaveCount(0);
  await page.context().close();
});
