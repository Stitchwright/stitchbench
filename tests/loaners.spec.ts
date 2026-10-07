// Loaner machines (shop-features-round-2-design.md 1.7): a machine for sale is set as a loaner on its page; on a repair
// ticket "Lend a machine" lends it (due day filled in, no deposit); the ticket shows "Loaner out"; the Loaners page lists
// it with the loan slip; "Did the loaner come back?" marks it back.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Ln ${RUN}`;
const owner = { email: `ln-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let unitId: string;
let ticketId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Ln Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  const customerId = newId();
  await insert("Customer", { id: customerId, shopId, name: `Jane Borrower ${RUN}` });
  const loanerMachine = newId();
  await insert("Machine", { id: loanerMachine, shopId, brand: "Brother", model: "CS6000i", modelKey: "CS6000I", serial: `LN-${RUN}` });
  unitId = newId();
  await insert("StockUnit", { id: unitId, shopId, machineId: loanerMachine, priceCents: 19900, updatedAt: new Date() });
  const hers = newId();
  await insert("Machine", { id: hers, shopId, customerId, brand: "Janome", model: "HD3000", modelKey: "HD3000" });
  ticketId = newId();
  await insert("Ticket", { id: ticketId, shopId, number: 1, customerId, machineId: hers, updatedAt: new Date() });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("a machine becomes a loaner, is lent on a ticket and comes back", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/units/${unitId}`);
  await page.getByLabel("Use it as").selectOption("LOANER");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();

  await page.goto(`/tickets/${ticketId}`);
  await page.getByText("Lend a machine").click();
  await expect(page.getByLabel("Loaner (only those in the shop)")).toBeVisible();
  await page.getByRole("button", { name: "Lend it" }).click();
  await expect(page.getByText("Lent.")).toBeVisible();
  await expect(page.getByText("loan slip")).toBeVisible();

  await page.goto(`/tickets/${ticketId}`);
  await expect(page.getByText(/Loaner out: Brother CS6000i/)).toBeVisible();
  await page.getByText("Did the loaner come back?").click();
  await page.getByRole("button", { name: "It's back" }).click();
  await expect(page.getByText("Back. Thank you!")).toBeVisible();
  const open = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "UnitLoan" WHERE "shopId" = $1 AND "backAt" IS NULL`, [shopId]);
  expect(open[0].n).toBe(0);
  await page.context().close();
});
