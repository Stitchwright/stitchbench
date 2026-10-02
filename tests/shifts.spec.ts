// Staff shifts end to end (scheduling-messaging-design.md 15.8 acceptance 3). Runs on a TEST BUILD. A company with
// Scheduling on, an owner and a tech; removed at the end.
import bcrypt from "bcryptjs";
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Shf ${RUN}`;
const owner = { email: `shf-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const tech = { email: `shf-tech-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page;
const made: string[] = [];

/** Next week's Sunday and its Tuesday and Saturday, yyyy-mm-dd (UTC dates: the shop is Eastern, the days are the same). */
function nextWeek(): { sunday: string; tuesday: string; saturday: string; after: string } {
  const d = new Date(Date.now() + 7 * 86_400_000);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  const ymd = (x: Date) => x.toISOString().slice(0, 10);
  const plus = (n: number) => new Date(d.getTime() + n * 86_400_000);
  return { sunday: ymd(d), tuesday: ymd(plus(2)), saturday: ymd(plus(6)), after: ymd(plus(7)) };
}
const W = nextWeek();

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Shf Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York' WHERE id = $1`, [shopId]);
  await setModule(admin, company, "Scheduling", true);
  await insert("User", { shopId, email: tech.email, name: "Shf Tech", role: "TECH", passwordHash: await bcrypt.hash(PASSWORD, 10) });
});

test.afterAll(async () => {
  for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("an admin adds shifts for a user and for 'Ann (Saturdays)'; the totals show", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/shifts?week=${W.sunday}`);
  await expect(page.getByRole("heading", { name: /^Staff: week of/ })).toBeVisible();
  const add = page.locator(".card", { hasText: "Add a shift" });
  await add.getByLabel("Who").selectOption({ label: "Shf Tech" });
  await add.getByLabel("Date").fill(W.tuesday);
  await add.getByLabel("From").fill("09:00");
  await add.getByLabel("To").fill("13:00");
  await add.getByLabel("Role").fill("Counter");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.reload();
  await add.getByLabel("Who").selectOption({ label: "Someone else" });
  await add.getByLabel("Name").fill("Ann (Saturdays)");
  await add.getByLabel("Date").fill(W.saturday);
  await add.getByLabel("From").fill("10:00");
  await add.getByLabel("To").fill("16:30");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.reload();
  const grid = page.getByRole("table", { name: "Shifts" });
  await expect(grid.locator("tr", { hasText: "Shf Tech" })).toContainText("4h");
  await expect(grid.locator("tr", { hasText: "Ann (Saturdays)" })).toContainText("6h 30m");
  await expect(grid.locator("tr", { hasText: "Shf Tech" })).toContainText(/9 am-1 pm Counter/);
  // The same person twice at once is refused.
  await add.getByLabel("Who").selectOption({ label: "Shf Tech" });
  await add.getByLabel("Date").fill(W.tuesday);
  await add.getByLabel("From").fill("12:00");
  await add.getByLabel("To").fill("17:00");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText(/Shf Tech already works .* then\./)).toBeVisible();
  await page.context().close();
});

test("copy to next week; the print view lists them; the Calendar's Staff tab opens /shifts", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/shifts?week=${W.after}`);
  await page.getByRole("button", { name: "Copy last week" }).click();
  await expect(page).toHaveURL(new RegExp(`/shifts\\?week=${W.after}`), { timeout: 20_000 });
  const rows = await sql<{ name: string }>(`SELECT name FROM "Shift" WHERE "shopId" = $1 ORDER BY "startsAt"`, [shopId]);
  expect(rows).toHaveLength(4);
  await expect(page.getByRole("table", { name: "Shifts" }).locator("tr", { hasText: "Ann (Saturdays)" })).toBeVisible();

  await page.goto(`/shifts/print?week=${W.sunday}`);
  await expect(page.getByText(/who's working/)).toBeVisible();
  await expect(page.getByText("Ann (Saturdays)")).toBeVisible();
  await expect(page.getByText("Shf Tech")).toBeVisible();
  await expect(page.getByRole("button", { name: "Print or save PDF" })).toBeVisible();

  await page.goto(`/calendar?date=${W.tuesday}`);
  await page.getByRole("link", { name: "Staff", exact: true }).click();
  await expect(page).toHaveURL(/\/shifts\?date=/);
  await expect(page.getByRole("heading", { name: /^Staff: week of/ })).toBeVisible();
  await page.context().close();
});

test("a tech sees the grid read-only, their own row highlighted", async ({ browser }) => {
  const t = await login(browser, tech);
  await t.goto(`/shifts?week=${W.sunday}`);
  await expect(t.getByRole("table", { name: "Shifts" })).toBeVisible();
  await expect(t.getByText("Add a shift")).toHaveCount(0);
  await expect(t.getByRole("button", { name: "Copy last week" })).toHaveCount(0);
  await expect(t.getByRole("table", { name: "Shifts" }).locator("tr.font-semibold", { hasText: "Shf Tech" })).toBeVisible();
  await t.context().close();
});
