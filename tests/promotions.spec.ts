// Promotions (tax-machine-sales-layaway-design.md section 2). Runs on a TEST BUILD. A throwaway counter company at 7%:
// a 20%-off sale on notions added in Settings → Selling and applied by the server at the register (the register sends no
// discount; the saved line carries it and the promotion); then "price includes the tax", allowed only behind its
// state-law warning, on machines for sale: a $1,000 machine rings up as $934.58 + $65.42 and the receipt says so. The
// promotions live only in this company. The company is removed at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, one, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Promo ${RUN}`;
const owner = { email: `promo-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const percentSale = `Notions week ${RUN}`;
const includedSale = `Tax on us ${RUN}`;
const notion = { pn: `PRN${RUN}`, description: `Spec seam ripper ${RUN}` };
const buyer = `Pat Promo ${RUN}`;
const brand = "Bernina";
const model = `Promo ${RUN}`;
const serial = `PR${RUN}`;
const unitText = `${brand} ${model} (New) S/N ${serial}`;
let shopId: string;
let admin: Page;
let page: Page;
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
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true, "taxRatePct" = 7 WHERE id = $1`, [id]);
  return id;
}

const toast = (p: Page, text: string | RegExp) => p.locator("[data-sonner-toast]").filter({ hasText: text }).first();
/** Settings → Selling's "Add a sale" form (each listed sale has its own form under Change). */
const addForm = (p: Page) => p.locator("form").filter({ has: p.locator("#pr-new-name") });

async function complete(p: Page) {
  await p.getByRole("button", { name: "Cash", exact: true }).click();
  await p.getByRole("button", { name: "Complete sale", exact: true }).click();
  const done = p.getByRole("status").filter({ hasText: /Sale #\d+ done/ });
  await expect(done).toBeVisible();
  const href = (await done.getByRole("link", { name: "Print receipt" }).getAttribute("href"))!;
  return { href, saleId: /\/register\/sales\/([^/?#]+)/.exec(href)![1] };
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  shopId = await createCompany(company, "retail", "Promo Owner", owner.email);
  await insert("Part", { shopId, partNumber: notion.pn, numberKeys: [notion.pn], description: notion.description, kind: "NOTION", priceCents: 2500, qtyOnHand: 10 });
  await insert("Customer", { shopId, name: buyer, phone: "5550133" });
  page = await login(browser, owner);
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await page?.context().close();
  await admin?.context().close();
});

test("a 20%-off sale on notions, applied by the server at the register", async () => {
  await page.goto("/settings/sales");
  await expect(page.getByText("No sales planned. Add one below.")).toBeVisible();
  const form = addForm(page);
  await form.locator("#pr-new-name").fill(percentSale);
  await expect(form.locator("#pr-new-effect")).toHaveValue("PERCENT");
  await form.locator("#pr-new-value").fill("20");
  await form.getByLabel("Notions", { exact: true }).check();
  await form.getByRole("button", { name: "Add sale", exact: true }).click();
  await expect(toast(page, "Sale added. The register applies it on those days.")).toBeVisible();
  const listed = page.locator("#sales").getByRole("listitem").filter({ hasText: percentSale });
  await expect(listed).toContainText("On today");
  await expect(listed).toContainText("20% off");
  await expect(listed).toContainText("Covers: notions");

  await page.goto("/register");
  await page.locator("#register-code").fill(notion.pn);
  await page.locator("#register-code").press("Enter");
  const row = page.getByRole("table", { name: "Sale" }).getByRole("row").filter({ hasText: notion.description });
  await expect(row.getByText(percentSale, { exact: true })).toBeVisible();
  // $25 less 20% = $20, plus 7% = $21.40.
  await expect(row).toContainText("$20.00");
  await expect(page.getByTestId("sale-total")).toHaveText("$21.40");
  const { href, saleId } = await complete(page);

  const line = await one<{ discountCents: number; promotionId: string | null }>(`SELECT "discountCents", "promotionId" FROM "SaleLine" WHERE "saleId" = $1`, [saleId]);
  const promo = await one<{ id: string }>(`SELECT id FROM "Promotion" WHERE "shopId" = $1 AND name = $2`, [shopId, percentSale]);
  expect(line).toEqual({ discountCents: 500, promotionId: promo!.id });
  expect((await one<{ totalCents: number }>(`SELECT "totalCents" FROM "Sale" WHERE id = $1`, [saleId]))?.totalCents).toBe(2140);

  await page.goto(href);
  const item = page.locator(".receipt li").filter({ hasText: notion.description });
  await expect(item).toContainText(percentSale);
  await expect(item).toContainText("less $5.00");
});

test("price includes the tax, behind its warning: a $1,000 machine at 7% is $934.58 + $65.42", async () => {
  await page.goto("/settings/sales");
  const form = addForm(page);
  // Not offered until the owner reads the warning and allows it.
  await expect(form.locator('#pr-new-effect option[value="TAX_INCLUDED"]')).toHaveCount(0);
  await page.getByText("More options: sales where the price includes the tax").click();
  await expect(page.getByText(/^Some states forbid advertising or saying that you pay or absorb the sales tax/)).toBeVisible();
  const allow = page.locator("form").filter({ has: page.getByLabel(/I have checked my state's rule/) });
  await allow.getByLabel(/I have checked my state's rule/).check();
  await allow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page, "Saved")).toBeVisible();
  await expect.poll(async () => (await one<{ taxIncludedOn: boolean }>(`SELECT "taxIncludedOn" FROM "Shop" WHERE id = $1`, [shopId]))?.taxIncludedOn).toBe(true);
  await page.reload();
  await expect(addForm(page).locator('#pr-new-effect option[value="TAX_INCLUDED"]')).toHaveCount(1);

  const f = addForm(page);
  await f.locator("#pr-new-name").fill(includedSale);
  await f.locator("#pr-new-effect").selectOption("TAX_INCLUDED");
  await f.getByLabel("Machines for sale", { exact: true }).check();
  await f.getByRole("button", { name: "Add sale", exact: true }).click();
  await expect(toast(page, "Sale added. The register applies it on those days.")).toBeVisible();
  await expect(page.locator("#sales").getByRole("listitem").filter({ hasText: includedSale })).toContainText("Price includes the sales tax");

  // The machine: $1,000 on the tag.
  await page.goto("/units");
  await page.locator("#ru-brand").fill(brand);
  await page.locator("#ru-model").fill(model);
  await page.locator("#ru-serials").fill(serial);
  await page.locator("#ru-price").fill("1000.00");
  await page.getByRole("button", { name: "Add to stock", exact: true }).click();
  // One machine added opens its page.
  await expect(page.getByRole("heading", { name: `${brand} ${model}`, exact: true })).toBeVisible();

  await page.goto("/register");
  await page.locator("#register-customer").fill(buyer);
  await page.getByRole("listitem").getByRole("button", { name: new RegExp(`^${buyer}`) }).click();
  await expect(page.getByRole("button", { name: "change", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Machine for sale", exact: true }).click();
  const sell = page.locator('[aria-label="Machine for sale"]');
  await sell.locator("#vu-q").fill(serial);
  await sell.getByRole("button", { name: "Look up", exact: true }).click();
  await sell.getByRole("list", { name: "Machines in stock" }).getByRole("button", { name: "Add $1000.00", exact: true }).click();
  const row = page.getByRole("table", { name: "Sale" }).getByRole("row").filter({ hasText: unitText });
  await expect(row.getByText(`${includedSale}: price includes tax`, { exact: true })).toBeVisible();
  await expect(page.getByText("$934.58", { exact: true })).toBeVisible();
  await expect(page.getByText("$65.42", { exact: true })).toBeVisible();
  await expect(page.getByTestId("sale-total")).toHaveText("$1000.00");
  const { href, saleId } = await complete(page);

  const s = await one<{ subtotalCents: number; taxCents: number; totalCents: number }>(`SELECT "subtotalCents", "taxCents", "totalCents" FROM "Sale" WHERE id = $1`, [saleId]);
  expect(s).toEqual({ subtotalCents: 93458, taxCents: 6542, totalCents: 100000 });
  const line = await one<{ unitPriceCents: number; taxNote: string | null }>(`SELECT "unitPriceCents", "taxNote" FROM "SaleLine" WHERE "saleId" = $1 AND "stockUnitId" IS NOT NULL`, [saleId]);
  expect(line).toEqual({ unitPriceCents: 93458, taxNote: "included" });

  await page.goto(href);
  const r = page.locator(".receipt");
  await expect(r).toContainText("Price includes $65.42 sales tax");
  await expect(r).toContainText(includedSale);
  await expect(r.locator("div").filter({ hasText: /^TOTAL/ }).last()).toContainText("$1000.00");
});
