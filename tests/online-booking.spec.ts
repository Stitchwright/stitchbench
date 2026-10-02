// Online booking end to end (online-and-parts-design.md section 2): the owner switches it on in Settings and offers
// a type; a signed-out browser books a time and sees the confirmation page; the booking shows on the calendar as
// online; the customer cancels from the manage link.
//   Runs on a TEST BUILD with the SMTP sink (PUBLIC_URL on the server, so the confirmation carries a link).
//   Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearSink, eventually, sendNow, sinkMessages } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const company = `Ob ${RUN}`;
const owner = { email: `ob-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const slug = `ob-${RUN.toLowerCase()}`;
const customer = { name: `Olivia Online ${RUN}`, email: `olivia-${RUN.toLowerCase()}@customer.test` };
let shopId: string;
let admin: Page;
let manageUrl: string;
const made: string[] = [];

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Ob Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true, phone = '(212) 555-0100' WHERE id = $1`, [shopId]);
  await setModule(admin, company, "Scheduling", true);
  await setModule(admin, company, "Marketing", true);
  await clearSink();
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("the owner sets up email, a type, and switches online booking on", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/messages");
  await page.getByLabel("Send email", { exact: true }).check();
  await page.getByLabel("Provider").selectOption("other");
  await page.getByLabel("Mail server").fill("127.0.0.1");
  await page.getByLabel("Port").fill(SINK_SMTP);
  await page.getByLabel("Security").selectOption("none");
  await page.getByLabel("User name").fill("sink-user");
  await page.getByLabel("Password").fill("sink-secret-pass-77");
  await page.getByLabel("From address").fill(owner.email);
  await page.getByRole("button", { name: "Save email settings" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();

  await page.goto("/calendar/types");
  await page.getByLabel("Name").fill("Machine fitting");
  await page.getByLabel("How long (minutes)").fill("60");
  await page.getByLabel("Fee").fill("25.00");
  await page.getByRole("button", { name: "Add this type" }).click();
  await expect(page.getByText("Machine fitting").first()).toBeVisible();

  await page.goto("/settings/booking");
  await page.getByLabel("Address (after /book/)").fill(slug);
  await page.getByLabel("Online booking is on").check();
  await page.getByLabel("Earliest booking (hours from now)").fill("1");
  await page.getByLabel("Machine fitting").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`/book/${slug}$`) })).toBeVisible();
  await page.context().close();
});

test("a customer, signed out, books a time and gets the confirmation page and email", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/book/${slug}`);
  await expect(page.getByRole("heading", { name: "Book a time" })).toBeVisible();
  await page.getByRole("link", { name: /Machine fitting/ }).click();
  await expect(page.getByRole("heading", { name: "Machine fitting" })).toBeVisible();
  // The first offered time (tomorrow or later: the lead time is an hour, the type's hours 9-18).
  const times = page.getByRole("link", { name: /\d{1,2}:\d{2} (am|pm)/ });
  await expect(times.first()).toBeVisible();
  await times.first().click();
  await page.getByLabel("Your name").fill(customer.name);
  await page.getByLabel("Mobile number").fill("(212) 555-0199");
  await page.getByLabel("Email").fill(customer.email);
  await page.getByRole("radio", { name: "Email" }).check();
  await page.getByLabel(/Anything we should know/).fill("First visit");
  await page.waitForTimeout(5_500); // the bot check: forms sent within five seconds are dropped
  await page.getByRole("button", { name: "Book it" }).click();
  await expect(page).toHaveURL(/\/book\/m\/[A-Za-z0-9_-]{43}\?new=1$/, { timeout: 20_000 });
  manageUrl = page.url().split("?")[0];
  await expect(page.getByText("You're booked. Thank you!")).toBeVisible();
  await expect(page.getByText("Machine fitting")).toBeVisible();
  await expect(page.getByText("$25.00, paid at the counter")).toBeVisible();
  const row = await sql<{ source: string; status: string; name: string }>(`SELECT source, status, name FROM "Appointment" WHERE "shopId" = $1`, [shopId]);
  expect(row).toHaveLength(1);
  expect(row[0]).toMatchObject({ source: "online", status: "BOOKED", name: customer.name });
  await ctx.close();

  const staff = await login(browser, owner);
  await sendNow(staff);
  const mail = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(customer.email)));
  expect(mail.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=")).toMatch(/book\/m\//);
  await staff.context().close();
});

test("the booking shows on the calendar as online; the customer cancels it from the link", async ({ browser }) => {
  const staff = await login(browser, owner);
  const apptId = (await sql<{ id: string; startsAt: Date }>(`SELECT id, "startsAt" FROM "Appointment" WHERE "shopId" = $1`, [shopId]))[0];
  await staff.goto(`/calendar/appointments/${apptId.id}`);
  await expect(staff.getByText("Online, by the customer")).toBeVisible();
  await expect(staff.getByText(customer.name).first()).toBeVisible();
  await staff.context().close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(manageUrl);
  await expect(page.getByText("Booked", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Cancel it" }).click();
  await page.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(page).toHaveURL(/done=cancelled/);
  await expect(page.getByText(/Cancelled\. Sorry/)).toBeVisible();
  const after = await sql<{ status: string }>(`SELECT status FROM "Appointment" WHERE id = $1`, [apptId.id]);
  expect(after[0].status).toBe("CANCELLED");
  await ctx.close();
});
