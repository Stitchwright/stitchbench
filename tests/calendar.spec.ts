// The calendar and appointments end to end (scheduling-messaging-design.md 15.6 acceptance 3). Runs on a TEST BUILD.
// A retail+repair company with Scheduling on, and a repair-only company for the Dashboard card; both removed at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Cal ${RUN}`;
const owner = { email: `cal-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const repairCompany = `CalRepair ${RUN}`;
const repairOwner = { email: `calrep-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let repairShopId: string;
let admin: Page;
let apptId: string;
const made: string[] = [];

/** The next Tuesday at least a week out, yyyy-mm-dd. */
function nextTuesday(): string {
  const d = new Date(Date.now() + 8 * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = nextTuesday();

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
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York' WHERE id = $1`, [id]);
  await setModule(admin, name, "Scheduling", true);
  return id;
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  shopId = await createCompany(company, "both", "Cal Owner", owner.email);
  repairShopId = await createCompany(repairCompany, "repair", "Rep Owner", repairOwner.email);
  await insert("Customer", { shopId, name: `Rita Rents ${RUN}`, phone: "+12125550161", notifyBy: "sms" });
  await insert("Customer", { shopId, name: `Lee Learns ${RUN}`, phone: "+12125550162", notifyBy: "sms" });
  // A class meeting and a shift on the same day, for the Day view.
  const cls = await insert<{ id: string }>("ShopClass", { shopId, title: `Quilting ${RUN}`, seats: 8, feeCents: 4500, status: "OPEN", updatedAt: new Date() });
  await insert("ClassMeeting", { shopId, classId: cls.id, startsAt: new Date(`${DAY}T22:00:00Z`), endsAt: new Date(`${DAY}T23:59:00Z`) }); // 6:00-7:59 pm Eastern (EDT)
  await sql(`UPDATE "ShopClass" SET "firstAt" = $2, "lastAt" = $2 WHERE id = $1`, [cls.id, new Date(`${DAY}T22:00:00Z`)]);
  await insert("Shift", { shopId, name: "Sue Staff", startsAt: new Date(`${DAY}T13:00:00Z`), endsAt: new Date(`${DAY}T21:00:00Z`), role: "Counter", updatedAt: new Date() });
  // The repair-only company: one drop-off today so its Dashboard card has something to show.
  const type = await insert<{ id: string }>("AppointmentType", { shopId: repairShopId, name: "Machine drop-off", minutes: 15, capacity: 3 });
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 3_600_000);
  await insert("Appointment", { shopId: repairShopId, typeId: type.id, name: "Drop In", title: "Machine drop-off", startsAt: later, endsAt: new Date(later.getTime() + 15 * 60_000), updatedAt: new Date() });
});

test.afterAll(async () => {
  for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("an admin creates 'Longarm rental' (2 hours, $40, 1 at once, resource Longarm, Tue-Sat 10:00-17:00)", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/calendar/types");
  await page.getByLabel("Name").fill("Longarm rental");
  await page.getByLabel("How long (minutes)").fill("120");
  await page.getByLabel("Fee").fill("40.00");
  await page.getByLabel("How many at once").fill("1");
  await page.getByLabel("What it uses up (optional)").fill("Longarm");
  for (const d of ["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
    await page.getByLabel(d, { exact: true }).check();
    await page.getByLabel(`${d} from`).fill("10:00");
    await page.getByLabel(`${d} to`).fill("17:00");
  }
  await page.getByRole("button", { name: "Add this type" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.locator("tr", { hasText: "Longarm rental" })).toContainText("Tue-Sat 10:00-17:00");
  await expect(page.locator("tr", { hasText: "Longarm rental" })).toContainText("$40.00");
  await page.context().close();
});

test("book it from a free-time button; a second booking at the same time is refused", async ({ browser }) => {
  const typeId = (await sql<{ id: string }>(`SELECT id FROM "AppointmentType" WHERE "shopId" = $1 AND name = 'Longarm rental'`, [shopId]))[0].id;
  const page = await login(browser, owner);
  await page.goto(`/calendar/new?date=${DAY}`);
  await page.getByLabel("What are they booking?").selectOption(typeId);
  await expect(page).toHaveURL(/type=/);
  await expect(page.getByText("Bookable Tue-Sat 10:00-17:00")).toBeVisible();
  // The first day's first free time (10:00 am on the Tuesday).
  const free = page.locator("fieldset", { hasText: "Free times in the next 7 days" });
  await free.getByRole("button", { name: "10:00 am" }).first().click();
  await expect(page.getByLabel("Date")).toHaveValue(DAY);
  await expect(page.getByLabel("Starts")).toHaveValue("10:00");
  await page.getByPlaceholder("Search name or phone, or leave blank for a new customer").fill(`Rita Rents ${RUN}`);
  await page.getByRole("button", { name: new RegExp(`^Rita Rents ${RUN}`) }).first().click();
  await page.getByRole("button", { name: "Book it" }).click();
  await expect(page).toHaveURL(new RegExp(`/calendar\\?date=${DAY}`), { timeout: 20_000 });
  const row = await sql<{ id: string; resource: string; feeCents: number; status: string }>(`SELECT id, resource, "feeCents", status FROM "Appointment" WHERE "shopId" = $1`, [shopId]);
  expect(row).toHaveLength(1);
  apptId = row[0].id;
  expect(row[0]).toMatchObject({ resource: "Longarm", feeCents: 4000, status: "BOOKED" });

  // The same time again: refused with the message.
  await page.goto(`/calendar/new?date=${DAY}`);
  await page.getByLabel("What are they booking?").selectOption(typeId);
  await expect(page).toHaveURL(/type=/);
  await page.getByLabel("Date").fill(DAY);
  await page.getByLabel("Starts").fill("10:00");
  await page.getByPlaceholder("Search name or phone, or leave blank for a new customer").fill(`Lee Learns ${RUN}`);
  await page.getByRole("button", { name: new RegExp(`^Lee Learns ${RUN}`) }).first().click();
  await page.getByRole("button", { name: "Book it" }).click();
  await expect(page.getByText("Longarm is already booked then (1 of 1). Pick another time.")).toBeVisible();
  expect(await sql(`SELECT 1 FROM "Appointment" WHERE "shopId" = $1`, [shopId])).toHaveLength(1);
  await page.context().close();
});

test("the Day and Week views show it with the class meeting and the shift; mark it Done", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/calendar?view=day&date=${DAY}`);
  await expect(page.getByRole("link", { name: /10:00 am-12:00 pm Longarm rental/ })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`Quilting ${RUN}`) })).toBeVisible();
  await expect(page.getByText("Working today: Sue Staff")).toBeVisible();
  await page.goto(`/calendar?view=week&date=${DAY}`);
  await expect(page.getByRole("link", { name: /Longarm rental/ }).first()).toBeVisible();

  // Phone width: the week is one list per day, not seven columns.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const lists = page.locator(".xl\\:hidden");
  await expect(lists.getByRole("link", { name: /Longarm rental/ }).first()).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 1000 });

  await page.goto(`/calendar/appointments/${apptId}`);
  await expect(page.getByText("Owes $40.00")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ring up" })).toHaveAttribute("href", `/register?booking=appointment:${apptId}`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("That was a mistake: back to booked")).toBeVisible();
  expect((await sql<{ status: string }>(`SELECT status FROM "Appointment" WHERE id = $1`, [apptId]))[0].status).toBe("DONE");
  await page.context().close();
});

test("the register shows the one-line Today strip; a repair-only company sees /calendar and the Dashboard Today card", async ({ browser }) => {
  // Something today for the retail company's strip: a drop-off type and a booking in a few hours.
  const type = await insert<{ id: string }>("AppointmentType", { shopId, name: "Machine drop-off", minutes: 15, capacity: 3 });
  const later = new Date(Date.now() + 2 * 3_600_000);
  await insert("Appointment", { shopId, typeId: type.id, name: "Walk In", title: "Machine drop-off", startsAt: later, endsAt: new Date(later.getTime() + 15 * 60_000), updatedAt: new Date() });
  const page = await login(browser, owner);
  await page.goto("/register");
  const strip = page.locator("details", { hasText: "Today:" });
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("1 appointment");
  await strip.locator("summary").click();
  await expect(strip.getByRole("link", { name: /Machine drop-off/ })).toBeVisible();
  await page.context().close();

  const rep = await login(browser, repairOwner);
  await rep.goto("/calendar");
  await expect(rep.getByRole("link", { name: "Book" }).first()).toBeVisible();
  await expect(rep.getByRole("link", { name: /Machine drop-off/ })).toBeVisible();
  await rep.goto("/");
  const card = rep.locator("section", { has: rep.getByRole("heading", { name: "Today" }) });
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: /Machine drop-off/ })).toBeVisible();
  await rep.context().close();
});
