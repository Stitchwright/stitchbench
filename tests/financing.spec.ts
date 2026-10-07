// Financing (tax-machine-sales-layaway-design.md section 5). Runs on a TEST BUILD. A throwaway counter company: a lender
// added in Settings → Selling, a sale paid with a Financing payment (lender and approval number) at the register, the
// receipt's financing line, and the lender's receivable in Reports → Financing, marked paid ("Lender paid") and back
// ("Not paid after all"). The company is removed at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, one, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Finance ${RUN}`;
const owner = { email: `finance-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const lender = `Spec Lending ${RUN}`;
const approval = `APR${RUN}`;
const item = { pn: `FIN${RUN}`, description: `Spec cabinet ${RUN}` };
let shopId: string;
let admin: Page;
let page: Page;
let saleId: string;
let saleNo: number;
const made: string[] = [];

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
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true, "taxRatePct" = 6 WHERE id = $1`, [id]);
  return id;
}

const toast = (p: Page, text: string | RegExp) => p.locator("[data-sonner-toast]").filter({ hasText: text }).first();

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  shopId = await createCompany(company, "retail", "Fin Owner", owner.email);
  await insert("Part", { shopId, partNumber: item.pn, numberKeys: [item.pn], description: item.description, kind: "ACCESSORY", priceCents: 30000, qtyOnHand: 3 });
  page = await login(browser, owner);
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await page?.context().close();
  await admin?.context().close();
});

test("no lender yet: no Financing button; add one in Settings → Selling", async () => {
  await page.goto("/register");
  await page.locator("#register-code").fill(item.pn);
  await page.locator("#register-code").press("Enter");
  await expect(page.getByRole("table", { name: "Sale" })).toContainText(item.description);
  await expect(page.getByRole("button", { name: "Financing", exact: true })).toHaveCount(0);

  await page.goto("/settings/sales");
  await expect(page.getByText("None yet. Add a lender to take financed payments.")).toBeVisible();
  await page.locator("#ln-new-name").fill(lender);
  await page.locator("#ln-new-url").fill("https://example.com/apply");
  await page.getByRole("button", { name: "Add lender", exact: true }).click();
  await expect(toast(page, "Lender added")).toBeVisible();
  await expect(page.getByText(lender, { exact: true })).toBeVisible();
  const l = await one<{ active: boolean; applyUrl: string | null }>(`SELECT active, "applyUrl" FROM "Lender" WHERE "shopId" = $1 AND name = $2`, [shopId, lender]);
  expect(l).toEqual({ active: true, applyUrl: "https://example.com/apply" });
});

test("a Financing payment at the register with the lender and approval number", async () => {
  await page.goto("/register");
  await page.locator("#register-code").fill(item.pn);
  await page.locator("#register-code").press("Enter");
  await expect(page.getByRole("table", { name: "Sale" })).toContainText(item.description);
  // $300 at 6%: $318.00.
  await expect(page.getByTestId("sale-total")).toHaveText("$318.00");

  await page.getByRole("button", { name: "Financing", exact: true }).click();
  const fin = page.locator('[aria-label="Financing"]');
  await expect(fin).toBeVisible();
  // The only lender is picked already. The approval number is required.
  await expect(fin.locator("#fin-lender")).toHaveValue(/.+/);
  await fin.getByRole("button", { name: "Add $318.00", exact: true }).click();
  await expect(toast(page, `Type ${lender}'s approval number.`)).toBeVisible();
  await fin.locator("#fin-approval").fill(approval);
  await fin.getByRole("button", { name: "Add $318.00", exact: true }).click();
  await expect(fin).toHaveCount(0);

  await page.getByRole("button", { name: "Complete sale", exact: true }).click();
  const done = page.getByRole("status").filter({ hasText: /Sale #\d+ done/ });
  await expect(done).toBeVisible();
  saleNo = Number(/Sale #(\d+) done/.exec((await done.textContent()) ?? "")![1]);
  const href = (await done.getByRole("link", { name: "Print receipt" }).getAttribute("href"))!;
  saleId = /\/register\/sales\/([^/?#]+)/.exec(href)![1];

  const f = await one<{ amountCents: number; approval: string | null; paidAt: Date | null }>(`SELECT "amountCents", approval, "paidAt" FROM "FinancedSale" WHERE "shopId" = $1 AND "saleId" = $2`, [shopId, saleId]);
  expect(f).toEqual({ amountCents: 31800, approval, paidAt: null });

  await page.goto(href);
  await expect(page.locator(".receipt")).toContainText(`Financing by ${lender}, approval ${approval}`);
});

test("Reports → Financing: the lender owes it until marked paid", async () => {
  await page.goto("/reports?tab=financing");
  const byLender = page.locator("section").filter({ has: page.getByRole("heading", { name: "By lender", exact: true }) });
  await expect(byLender.getByRole("row").filter({ hasText: lender })).toContainText("$318.00");

  const unpaid = page.locator("section").filter({ has: page.getByRole("heading", { name: "Not paid by the lender yet (1)", exact: true }) });
  const row = unpaid.getByRole("row").filter({ hasText: `#${saleNo}` });
  await expect(row).toContainText(lender);
  await expect(row).toContainText(approval);
  await expect(row).toContainText("$318.00");
  await row.getByRole("button", { name: "Lender paid", exact: true }).click();
  await expect(toast(page, "Marked paid")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Not paid by the lender yet (0)", exact: true })).toBeVisible();
  await expect(page.getByText("Every financed sale has been paid.")).toBeVisible();
  const paid = page.locator("section").filter({ has: page.getByRole("heading", { name: "Paid in this range", exact: true }) });
  await expect(paid.getByRole("row").filter({ hasText: `#${saleNo}` }).getByRole("button", { name: "Not paid after all", exact: true })).toBeVisible();
  expect((await one<{ paidAt: Date | null }>(`SELECT "paidAt" FROM "FinancedSale" WHERE "shopId" = $1 AND "saleId" = $2`, [shopId, saleId]))?.paidAt).toBeTruthy();
});
