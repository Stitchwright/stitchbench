// Scheduling and Marketing together, end to end (scheduling-messaging-design.md 15.10, e2e-docs acceptance 1). A
// company that is both repair and retail with both modules on: a class sign-up (its confirmation in the sink), an
// appointment, reminders queued for tomorrow's items, a ticket set ready (email in the sink), an estimate approved by
// link; then both modules switched off: locks in the nav, read-only pages with the notice, "Sign up" refused, a message
// queued just before the switch held (not in the sink 15 s later), the roster still prints, the classes CSV still
// downloads, the unsubscribe link still works; switched back on, the held message goes out.
//   Runs on a TEST BUILD with the SMTP sink and the Twilio mock (MESSAGE_WORKER_SECONDS=5, READY_NOTICE_DELAY_SECONDS=1,
//   PUBLIC_URL on the server and in this process). The partner-run step needs a hub and lives in partner-runs.spec.ts.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearSink, eventually, sendNow, sinkMessages } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const DAY = 86_400_000;
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const PUBLIC = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const company = `Sched ${RUN}`;
const owner = { email: `sched-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
const student = { name: `Sue Student ${RUN}`, email: `sue-${RUN.toLowerCase()}@customer.test` };
let shopId: string;
let admin: Page;
let classId: string;
let heldTicketId: string;
const made: string[] = [];

/** A ticket for a new customer with an email, in the given status. Returns its id. */
async function newTicket(page: Page, name: string, email: string, status?: string) {
  await page.goto("/tickets/new");
  await page.getByLabel("New customer name").fill(name);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Brand", { exact: true }).fill("Janome");
  await page.getByLabel("Model", { exact: true }).fill("MC6700P");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Janome MC6700P/ })).toBeVisible();
  if (status) {
    await page.getByLabel("Status", { exact: true }).selectOption({ label: status });
    await expect(page.getByText(`Status: ${status}`)).toBeVisible();
  }
  return page.url().split("/").pop()!;
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Sched Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true WHERE id = $1`, [shopId]);
  await setModule(admin, company, "Scheduling", true);
  await setModule(admin, company, "Marketing", true);
  await clearSink();
});

test.afterAll(async () => {
  for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("email is set up and the time zone confirmed", async ({ browser }) => {
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
  await page.context().close();
});

test("a class tomorrow with a sign-up: the confirmation reaches the sink; an appointment tomorrow; reminders queue", async ({ browser }) => {
  const page = await login(browser, owner);
  await insert("Customer", { shopId, name: student.name, email: student.email, notifyBy: "email" });
  await page.goto("/classes/new");
  await page.getByLabel("Class name").fill(`Serger Basics ${RUN}`);
  await page.getByLabel("Teacher").fill("Jo Quilter");
  await page.getByLabel("Fee").fill("30.00");
  await page.getByLabel("Seats").fill("4");
  await page.getByLabel("First meeting").fill(tomorrow);
  await page.getByLabel("Starts").fill("18:00");
  await page.getByLabel("Ends").fill("20:00");
  await page.getByRole("button", { name: "Create the class" }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`Serger Basics ${RUN}`) })).toBeVisible();
  classId = page.url().split("/").pop()!;
  await page.getByLabel("Customer", { exact: true }).fill(student.name.slice(0, 11));
  await page.getByRole("button", { name: student.name }).first().click();
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByText(/Signed up/).first()).toBeVisible();
  await sendNow(page);
  const confirmation = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(student.email)));
  expect(confirmation.raw).toMatch(/Serger Basics/);

  await page.goto("/calendar/types");
  await page.getByLabel("Name").fill("Machine fitting");
  await page.getByLabel("How long (minutes)").fill("30");
  await page.getByRole("button", { name: "Add this type" }).click();
  await expect(page.getByText("Machine fitting").first()).toBeVisible();
  await page.goto(`/calendar/new?date=${tomorrow}`);
  await page.getByLabel("What are they booking?").selectOption({ label: "Machine fitting" });
  await page.getByLabel("Customer", { exact: true }).fill(student.name.slice(0, 11));
  await page.getByRole("button", { name: student.name }).first().click();
  await page.getByLabel("Date").fill(tomorrow);
  await page.getByLabel("Starts").fill("10:00");
  await page.getByRole("button", { name: "Book it" }).click();
  await expect(page.getByText(/Booked/).first()).toBeVisible();

  // The scheduler (the worker's run) queues tomorrow's reminders.
  await sendNow(page);
  const reminders = await eventually(async () => {
    const rows = await sql<{ refType: string }>(`SELECT "refType" FROM "OutMessage" WHERE "shopId" = $1 AND kind = 'reminder'`, [shopId]);
    return rows.length >= 2 ? rows : null;
  }, 60_000, 3_000);
  expect(reminders.map((r) => r.refType).sort()).toEqual(expect.arrayContaining(["appointment", "meeting"]));
  await page.context().close();
});

test("a ready ticket emails the customer; an estimate is approved by link", async ({ browser }) => {
  const page = await login(browser, owner);
  const readyEmail = `ready-${RUN.toLowerCase()}@customer.test`;
  const ticketId = await newTicket(page, `Rita Ready ${RUN}`, readyEmail, "Ready - customer called");
  await sendNow(page);
  const mail = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(readyEmail)));
  expect(mail.raw).toMatch(/Subject: Your Janome MC6700P is ready/);
  void ticketId;

  test.skip(!PUBLIC, "the estimate link needs PUBLIC_URL on the server and in this process");
  const linkEmail = `linda-${RUN.toLowerCase()}@customer.test`;
  const waitingId = await newTicket(page, `Linda Approver ${RUN}`, linkEmail, "Waiting on customer OK");
  await page.getByLabel("Hours", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Add labor" }).click();
  await expect(page.getByText("Repair labor")).toBeVisible();
  await page.getByRole("button", { name: "Send the estimate", exact: true }).click();
  await expect(page.getByText("Queued. It goes out in a moment.")).toBeVisible();
  await sendNow(page);
  const est = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(linkEmail)));
  const raw = est.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const url = /(https?:\/\/[^\s"<>]+\/e\/[A-Za-z0-9_-]{43})/.exec(raw)?.[1];
  expect(url, "the email carries the /e/ link").toBeTruthy();
  const ctx = await browser.newContext();
  const link = await ctx.newPage();
  await link.goto(url!.slice(PUBLIC.length));
  await link.getByRole("link", { name: /^Approve/ }).click();
  await link.getByRole("button", { name: /^Approve/ }).click();
  await expect(link.getByText(/Thank you/)).toBeVisible();
  await ctx.close();
  const after = await sql<{ status: string; estimateAnswer: string | null }>(`SELECT status, "estimateAnswer" FROM "Ticket" WHERE id = $1`, [waitingId]);
  expect(after[0].status).toBe("ON_BENCH");
  expect(after[0].estimateAnswer).toBe("APPROVED");
  await page.context().close();
});

test("both modules switched off: locks, read-only pages, a held message, the roster and CSV still work, the unsubscribe link works", async ({ browser }) => {
  const page = await login(browser, owner);
  // A ready notice queued right before the switch: it is held, not lost.
  const heldEmail = `held-${RUN.toLowerCase()}@customer.test`;
  heldTicketId = await newTicket(page, `Hal Held ${RUN}`, heldEmail, "Ready - customer called");
  await setModule(admin, company, "Scheduling", false);
  await setModule(admin, company, "Marketing", false);

  await page.goto("/classes");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const item of [/Calendar/, /Classes/, /Messages/]) await expect(nav.getByRole("link", { name: item }).getByLabel("Read only")).toBeVisible();
  await expect(page.getByText(/switched off/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "New class" })).toHaveCount(0);
  await page.goto(`/classes/${classId}`);
  await expect(page.getByRole("button", { name: "Sign up", exact: true })).toHaveCount(0);

  // Held: still queued, and not in the sink 15 s later (the worker runs every 5 s on the test server).
  await page.waitForTimeout(15_000);
  const held = await sql<{ status: string }>(`SELECT status FROM "OutMessage" WHERE "ticketId" = $1`, [heldTicketId]);
  expect(held[0]?.status).toBe("QUEUED");
  expect((await sinkMessages()).some((m) => m.to.includes(heldEmail))).toBe(false);
  await page.goto("/messages");
  await expect(page.getByText(/Waiting|held/i).first()).toBeVisible();

  // Records still print and export.
  await page.goto(`/classes/${classId}/roster`);
  await expect(page.getByRole("button", { name: "Print or save PDF" })).toBeVisible();
  await expect(page.getByText(student.name)).toBeVisible();
  const csv = await page.request.get("/api/export/classes");
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain(`Serger Basics ${RUN}`);

  // The one-click unsubscribe keeps working for a marketing email sent before the switch.
  const token = newId().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 22).padEnd(22, "x");
  const c = await sql<{ id: string; email: string }>(`SELECT id, email FROM "Customer" WHERE "shopId" = $1 AND name = $2`, [shopId, student.name]);
  await insert("OutMessage", { shopId, channel: "email", purpose: "marketing", kind: "campaign", customerId: c[0].id, address: c[0].email, body: "x", status: "SENT", optOutToken: token, sendAfter: new Date().toISOString() });
  const u = await page.request.get(`/u/${token}`);
  expect(u.status()).toBe(200);
  await eventually(async () => (await sql(`SELECT 1 FROM "Suppression" WHERE "shopId" = $1 AND address = $2`, [shopId, c[0].email])).length > 0 || null);
  await page.context().close();
});

test("switched back on, the held message goes out", async ({ browser }) => {
  await setModule(admin, company, "Marketing", true);
  await setModule(admin, company, "Scheduling", true);
  const page = await login(browser, owner);
  await sendNow(page);
  const heldEmail = `held-${RUN.toLowerCase()}@customer.test`;
  const mail = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(heldEmail)));
  expect(mail.raw).toMatch(/is ready/);
  const row = await sql<{ status: string }>(`SELECT status FROM "OutMessage" WHERE "ticketId" = $1`, [heldTicketId]);
  expect(row[0].status).toBe("SENT");
  await page.context().close();
});
