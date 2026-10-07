// Sales tax holidays (tax-machine-sales-layaway-design.md section 1). Runs on a TEST BUILD. A throwaway counter company
// at 6.25%: Settings → Selling's Massachusetts preset, saved with dates around today; the register shows the banner,
// "Tax holiday" on a covered line, a line over the $2,500 limit taxed, and "Charge tax anyway" on one line; the receipt
// marks the holiday line and names the holiday; Reports → Sales tax lists the holiday sales. The holiday lives only in
// this company, so no other spec rings up on a holiday. The company is removed at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, one, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Holiday ${RUN}`;
const owner = { email: `holiday-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const HOLIDAY = "Massachusetts sales tax holiday";
const cheap = { pn: `THA${RUN}`, description: `Spec scissors ${RUN}` }; // $40 notion: covered
const dear = { pn: `THB${RUN}`, description: `Spec quilting frame ${RUN}` }; // $2,600 accessory: over the limit, taxed
const anyway = { pn: `THC${RUN}`, description: `Spec pins ${RUN}` }; // $20 notion: covered, but the cashier charges the tax
let shopId: string;
let admin: Page;
let page: Page;
let saleId: string;
const made: string[] = [];

const ymdIn = (tz: string, d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (ymd: string, n: number) => new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)) + n)).toISOString().slice(0, 10);

async function createCompany(name: string, kind: string, ownerName: string, email: string): Promise<string> {
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(name);
  await admin.getByLabel("Kind of shop").selectOption(kind);
  await admin.getByLabel("Owner's name").fill(ownerName);
  await admin.getByLabel("Owner's email (their login)").fill(email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  const id = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [name]))[0].id;
  made.push(id);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true, "taxRatePct" = 6.25 WHERE id = $1`, [id]);
  return id;
}

const toast = (p: Page, text: string | RegExp) => p.locator("[data-sonner-toast]").filter({ hasText: text }).first();

async function scan(p: Page, code: string, description: string) {
  await p.locator("#register-code").fill(code);
  await p.locator("#register-code").press("Enter");
  await expect(p.getByRole("table", { name: "Sale" })).toContainText(description);
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  shopId = await createCompany(company, "retail", "Hol Owner", owner.email);
  await insert("Part", { shopId, partNumber: cheap.pn, numberKeys: [cheap.pn], description: cheap.description, kind: "NOTION", priceCents: 4000, qtyOnHand: 10 });
  await insert("Part", { shopId, partNumber: dear.pn, numberKeys: [dear.pn], description: dear.description, kind: "ACCESSORY", priceCents: 260000, qtyOnHand: 2 });
  await insert("Part", { shopId, partNumber: anyway.pn, numberKeys: [anyway.pn], description: anyway.description, kind: "NOTION", priceCents: 2000, qtyOnHand: 10 });
  page = await login(browser, owner);
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await page?.context().close();
  await admin?.context().close();
});

test("Settings → Selling: add the Massachusetts preset with dates covering today", async () => {
  const today = ymdIn("America/New_York");
  await page.goto("/settings/sales");
  await expect(page.getByText("None set up. If your state has a tax-free weekend, add it here.")).toBeVisible();
  await page.getByRole("link", { name: "Massachusetts", exact: true }).click();
  await expect(page).toHaveURL(/preset=MA/);
  await expect(page.locator("#th-new-name")).toHaveValue(HOLIDAY);
  await expect(page.locator("#th-new-max")).toHaveValue("2500.00");
  await expect(page.getByText(/Check this year's dates before you save\./)).toBeVisible();
  // The preset's kinds: the goods ticked, classes left out.
  const form = page.locator("form").filter({ has: page.locator("#th-new-name") });
  await expect(form.getByLabel("Notions", { exact: true })).toBeChecked();
  await expect(form.getByLabel("Accessories", { exact: true })).toBeChecked();
  await expect(form.getByLabel("Classes", { exact: true })).not.toBeChecked();
  await page.locator("#th-new-first").fill(addDays(today, -1));
  await page.locator("#th-new-last").fill(addDays(today, 1));
  await form.getByRole("button", { name: "Add tax holiday", exact: true }).click();
  await expect(toast(page, "Tax holiday added. The register applies it on those days.")).toBeVisible();
  const item = page.getByRole("listitem").filter({ hasText: HOLIDAY }).filter({ hasText: "On today" });
  await expect(item).toBeVisible();
  await expect(item).toContainText("up to $2500.00 each");
  const h = await one<{ preset: string | null; maxUnitCents: number | null }>(`SELECT preset, "maxUnitCents" FROM "TaxHoliday" WHERE "shopId" = $1`, [shopId]);
  expect(h).toEqual({ preset: "MA", maxUnitCents: 250000 });
});

test("the register on the holiday: banner, a covered line, a line over the limit, Charge tax anyway", async () => {
  await page.goto("/register");
  const banner = page.getByRole("status").filter({ hasText: "Tax holiday today" });
  await expect(banner).toContainText(HOLIDAY);
  await expect(banner).toContainText("$2500.00 or less each");

  await scan(page, cheap.pn, cheap.description);
  await scan(page, dear.pn, dear.description);
  await scan(page, anyway.pn, anyway.description);
  const sale = page.getByRole("table", { name: "Sale" });
  const rowOf = (d: string) => sale.getByRole("row").filter({ hasText: d });
  await expect(rowOf(cheap.description).getByText("Tax holiday", { exact: true })).toBeVisible();
  await expect(rowOf(dear.description).getByText("Tax holiday", { exact: true })).toHaveCount(0);
  await rowOf(anyway.description).getByRole("button", { name: "Charge tax anyway", exact: true }).click();
  await expect(rowOf(anyway.description).getByText("tax charged", { exact: true })).toBeVisible();
  await expect(rowOf(anyway.description).getByRole("button", { name: "Undo", exact: true })).toBeVisible();

  // Tax on $2,600 + $20 only: 6.25% of $2,620 = $163.75; total $40 + $2,620 + $163.75.
  await expect(page.getByText("Tax (6.25%)", { exact: true })).toBeVisible();
  await expect(page.getByText("$163.75", { exact: true })).toBeVisible();
  await expect(page.getByTestId("sale-total")).toHaveText("$2823.75");

  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale", exact: true }).click();
  const done = page.getByRole("status").filter({ hasText: /Sale #\d+ done/ });
  await expect(done).toBeVisible();
  const href = (await done.getByRole("link", { name: "Print receipt" }).getAttribute("href"))!;
  saleId = /\/register\/sales\/([^/?#]+)/.exec(href)![1];

  const lines = await sql<{ description: string; taxable: boolean; taxNote: string | null }>(`SELECT description, taxable, "taxNote" FROM "SaleLine" WHERE "saleId" = $1`, [saleId]);
  const by = new Map(lines.map((l) => [l.description, l]));
  expect(by.get(cheap.description)?.taxable).toBe(false);
  expect(by.get(cheap.description)?.taxNote).toMatch(/^holiday:/);
  expect(by.get(dear.description)?.taxable).toBe(true);
  expect(by.get(anyway.description)?.taxable).toBe(true);
  const s = await one<{ taxCents: number; totalCents: number }>(`SELECT "taxCents", "totalCents" FROM "Sale" WHERE id = $1`, [saleId]);
  expect(s).toEqual({ taxCents: 16375, totalCents: 282375 });
});

test("the receipt marks the holiday line and names the holiday", async () => {
  await page.goto(`/register/sales/${saleId}`);
  const r = page.locator(".receipt");
  await expect(r.locator("li").filter({ hasText: cheap.description })).toContainText("(tax holiday)");
  await expect(r.locator("li").filter({ hasText: dear.description })).not.toContainText("(tax holiday)");
  await expect(r).toContainText(`No sales tax on the items marked: ${HOLIDAY}.`);
});

test("Reports → Sales tax lists the holiday sales", async () => {
  await page.goto("/reports?tab=tax");
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Sold tax free on a sales tax holiday" }) });
  await expect(section).toBeVisible();
  const item = section.getByRole("listitem").filter({ hasText: HOLIDAY });
  await expect(item).toContainText("$40.00");
});
