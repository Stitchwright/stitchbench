// Birthdays and per-yard breaks (shop-features-round-2-design.md 1.6): Settings → Prices and members sets 15% off one
// sale and a "10 yards: 10% off" break; a customer's birthday this month is added on her page; at the register her line
// "Happy birthday month: 15% off today" with Use it labels the fabric "Birthday 15%"; a 12-yard line without her shows
// "10+ yd price"; the birthdays page lists her.
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Bd ${RUN}`;
const owner = { email: `bd-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const customerName = `Jane Birthday ${RUN}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
let shopId: string;
let customerId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Bd Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true, "taxRatePct" = 0, "timeZone" = 'America/New_York' WHERE id = $1`, [shopId]);
  customerId = newId();
  await insert("Customer", { id: customerId, shopId, name: customerName });
  await insert("Part", { id: newId(), shopId, partNumber: `KONA-${RUN}`, description: "Kona cotton", qtyOnHand: 40, priceCents: 1000, unit: "yd", altNumbers: [], numberKeys: [`KONA${RUN}`.toUpperCase()], kind: "FABRIC" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("settings: 15% birthday offer and a 10-yard break; her birthday on her page", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/prices");
  await page.getByLabel("Birthday percent off").fill("15");
  await page.locator("input[name=kind][value=pct]").check();
  await page.getByRole("button", { name: "Save the birthday offer" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.getByText("Add a yard break").click();
  await page.getByLabel("From how many yards").fill("10");
  await page.locator("details", { hasText: "Add a yard break" }).getByLabel("Percent off", { exact: true }).fill("10");
  await page.getByRole("button", { name: "Add the break" }).click();
  await expect(page.getByText("10 yards or more of one item: 10% off")).toBeVisible();

  await page.goto(`/customers/${customerId}`);
  await page.getByText(/Add her birthday/).click();
  const month = new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "numeric" });
  const birthday = page.locator("form", { has: page.getByLabel("Month") });
  await birthday.getByLabel("Month").selectOption(month);
  await birthday.getByLabel("Day", { exact: true }).fill("12");
  await birthday.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(`${MONTHS[Number(month) - 1]} 12`)).toBeVisible();
  await page.context().close();
});

test("the register: Use it gives 15% labelled; 12 yards get the 10+ yd price; the birthdays page lists her", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register");
  await page.getByLabel("Customer (optional)").fill(customerName.slice(0, 10));
  await page.getByRole("button", { name: new RegExp(customerName) }).click();
  await expect(page.getByText("Happy birthday month")).toBeVisible();
  await page.getByRole("button", { name: "Use it" }).click();
  await page.getByLabel("Scan a barcode or search").fill(`KONA-${RUN}`);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("button", { name: /Birthday 15%: take it off this line/ })).toBeVisible();
  await page.getByLabel(/^Qty for Kona cotton/).fill("12");
  await expect(page.getByRole("button", { name: /Birthday 15%/ })).toBeVisible();
  await page.getByRole("button", { name: "Take it off", exact: true }).click();
  await expect(page.getByRole("button", { name: /10\+ yd price/ })).toBeVisible();
  await page.goto("/customers/birthdays");
  await expect(page.getByRole("link", { name: customerName })).toBeVisible();
  await page.context().close();
});
