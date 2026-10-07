// Class seats and appointments at the register (scheduling-messaging-design.md 15.7 acceptance 3). Runs on a TEST BUILD.
// A retail company with Scheduling on; removed at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Rb ${RUN}`;
const owner = { email: `rb-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page;
let classId: string;
let enrollmentId: string;
let saleNumber: number;
const made: string[] = [];

function nextTuesday(): string {
  const d = new Date(Date.now() + 8 * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Rb Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true WHERE id = $1`, [shopId]);
  await setModule(admin, company, "Scheduling", true);
  // A class with one seat taken (Ann owes $45) and seats left.
  const day = nextTuesday();
  const first = new Date(`${day}T22:00:00Z`);
  const cls = await insert<{ id: string }>("ShopClass", { shopId, title: `Beginning Quilting ${RUN}`, seats: 6, feeCents: 4500, status: "OPEN", firstAt: first, lastAt: new Date(first.getTime() + 2 * 3_600_000), updatedAt: new Date() });
  classId = cls.id;
  await insert("ClassMeeting", { shopId, classId, startsAt: first, endsAt: new Date(first.getTime() + 2 * 3_600_000) });
  const ann = await insert<{ id: string }>("Customer", { shopId, name: `Ann Able ${RUN}`, phone: "+12125550141", notifyBy: "" });
  const e = await insert<{ id: string }>("Enrollment", { shopId, classId, customerId: ann.id, name: `Ann Able ${RUN}`, status: "ENROLLED", feeCents: 4500, taxable: false, updatedAt: new Date() });
  enrollmentId = e.id;
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("from the roster, Ring up opens the register with the class line; the URL goes back to /register; pay cash", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/classes/${classId}`);
  const roster = page.locator("section", { has: page.getByRole("heading", { name: /^Roster/ }) });
  await roster.locator("tr", { hasText: `Ann Able ${RUN}` }).getByRole("link", { name: "Ring up" }).click();
  await expect(page).toHaveURL(/\/register$/, { timeout: 20_000 });
  const sale = page.getByRole("table", { name: "Sale" });
  await expect(sale.getByText(new RegExp(`Class: Beginning Quilting ${RUN}`))).toBeVisible();
  await expect(sale.getByLabel(/^Qty for Class:/)).toBeDisabled();
  await expect(sale.getByLabel(/^Price for Class:/)).toBeDisabled();
  await expect(page.getByText(`Ann Able ${RUN}`).first()).toBeVisible(); // the sale took the booking's customer
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);
  const paid = await sql<{ paidCents: number; paidLineId: string }>(`SELECT "paidCents", "paidLineId" FROM "Enrollment" WHERE id = $1`, [enrollmentId]);
  expect(paid[0].paidCents).toBe(4500);
  expect(paid[0].paidLineId).toBeTruthy();
  saleNumber = (await sql<{ number: number }>(`SELECT s.number FROM "Sale" s JOIN "SaleLine" l ON l."saleId" = s.id WHERE l.id = $1`, [paid[0].paidLineId]))[0].number;

  await page.goto(`/classes/${classId}`);
  const link = roster.locator("tr", { hasText: `Ann Able ${RUN}` }).getByRole("link", { name: `Paid, sale #${saleNumber}` });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("heading", { name: `Sale #${saleNumber}` })).toBeVisible();
  await page.context().close();
});

test("the register's picker signs a new customer up and adds the line; return mode refunds it", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register");
  await page.getByRole("button", { name: "Classes & appointments" }).click();
  await expect(page.getByText("Sign up for a class")).toBeVisible();
  const row = page.locator("li", { hasText: `Beginning Quilting ${RUN}` }).filter({ hasText: "seats left" });
  await expect(row).toContainText("5 seats left");
  await row.getByRole("button", { name: /^Sign up/ }).click();
  // No customer on the sale: the picker asks for a name and phone.
  await expect(page.getByText("Who is signing up?")).toBeVisible();
  await row.getByLabel("Name").fill(`Walk In ${RUN}`);
  await row.getByLabel("Phone").fill("(212) 555-0177");
  await row.getByRole("button", { name: "Sign up", exact: true }).last().click(); // the form's submit, not the row's own button
  await expect(page.getByText(/Signed up: Class: Beginning Quilting/)).toBeVisible();
  const sale = page.getByRole("table", { name: "Sale" });
  await expect(sale.getByText(new RegExp(`Class: Beginning Quilting ${RUN}`))).toBeVisible();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);
  const rows = await sql<{ name: string; paidCents: number | null }>(`SELECT name, "paidCents" FROM "Enrollment" WHERE "classId" = $1 ORDER BY "createdAt"`, [classId]);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ name: `Walk In ${RUN}`, paidCents: 4500 });

  // Return mode: the paid seat is listed and refunded.
  await page.getByRole("button", { name: /Return an item/ }).click();
  await page.getByRole("button", { name: "Classes & appointments" }).click();
  await expect(page.getByText("Paid here and refundable")).toBeVisible();
  await page.locator("li", { hasText: `Walk In ${RUN}` }).getByRole("button", { name: "Refund $45.00" }).click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);
  const refunded = await sql<{ refundedCents: number | null }>(`SELECT "refundedCents" FROM "Enrollment" WHERE "classId" = $1 AND name = $2`, [classId, `Walk In ${RUN}`]);
  expect(refunded[0].refundedCents).toBe(4500);
  await page.context().close();
});

test("the sales report shows a Classes bucket", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register/sales");
  await expect(page.getByText("Classes", { exact: true }).first()).toBeVisible(); // the report bucket (the nav has a Classes item too)
  await expect(page.getByRole("link", { name: String(saleNumber), exact: true }).first()).toBeVisible(); // the report links the bare sale number
  await page.context().close();
});
