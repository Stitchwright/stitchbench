// Classes end to end (scheduling-messaging-design.md 15.5 acceptance 3). Runs on a TEST BUILD with the SMTP sink and
// the Twilio mock, like messaging.spec.ts. A retail company with both modules on; it is removed at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearMockSent, clearSink, eventually, mockSent, sendNow } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const SHOP_NUMBER = "+12125550100";
const company = `Cls ${RUN}`;
const owner = { email: `cls-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page;
let classId: string;
let waitingCustomerId: string;
const made: string[] = [];

/** The next Tuesday at least a week out, yyyy-mm-dd (so the class is in the future and the roster is printable). */
function nextTuesday(): string {
  const d = new Date(Date.now() + 8 * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const hourIn = (tz: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Cls Owner");
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
  await clearMockSent();
  // Three customers who want texts; the third has given written consent (notices don't need it, but it doesn't hurt).
  await insert("Customer", { shopId, name: `Ann Able ${RUN}`, phone: "+12125550181", notifyBy: "sms" });
  await insert("Customer", { shopId, name: `Bob Baker ${RUN}`, phone: "+12125550182", notifyBy: "sms" });
  const w = await insert<{ id: string }>("Customer", { shopId, name: `Wendy Waits ${RUN}`, phone: "+12125550183", notifyBy: "sms" });
  waitingCustomerId = w.id;
});

test.afterAll(async () => {
  // E2E_KEEP=1 leaves the company behind to look at after a failure.
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("email and texts are set up for the company", async ({ browser }) => {
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
  await page.getByLabel("Send texts", { exact: true }).check();
  await page.getByLabel("Account SID").fill("AC" + "0123456789abcdef".repeat(2));
  await page.getByLabel(/Auth Token|secret/i).first().fill("secret");
  await page.getByLabel("Twilio number").fill(SHOP_NUMBER);
  await page.getByRole("button", { name: "Save text settings" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.context().close();
});

test("a class with 4 weekly meetings and 2 seats; 3 sign-ups, the third waits", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/classes");
  await page.getByRole("link", { name: "New class" }).click();
  await page.getByLabel("Class name").fill(`Beginning Quilting ${RUN}`);
  await page.getByLabel("Teacher").fill("Jo Quilter");
  await page.getByLabel("Fee").fill("45.00");
  await page.getByLabel("Seats").fill("2");
  await page.getByLabel("Keep a waiting list when it's full").check();
  await page.getByLabel("What to bring").fill("Rotary cutter and a mat");
  await page.getByLabel("Date").fill(nextTuesday());
  await page.getByLabel("Starts").fill("18:00");
  await page.getByLabel("Ends").fill("20:00");
  await page.getByLabel("How often").selectOption("weekly");
  await page.getByLabel("How many times").fill("4");
  await page.getByRole("button", { name: "Create the class" }).click();
  await expect(page).toHaveURL(/\/classes\/(?!new$)[a-z0-9]+$/, { timeout: 20_000 });
  classId = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { name: "Meetings (4)" })).toBeVisible();
  await expect(page.getByText("0 of 2 seats")).toBeVisible();

  // Three sign-ups from the class page: the picker finds each customer by name.
  for (const [name, i] of [["Ann Able", 1], ["Bob Baker", 2], ["Wendy Waits", 3]] as const) {
    await page.getByPlaceholder("Search name or phone, or leave blank for a new customer").fill(`${name} ${RUN}`);
    await page.getByRole("button", { name: new RegExp(`^${name} ${RUN}`) }).first().click();
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await page.reload();
    if (i < 3) await expect(page.getByText(`${i} of 2 seats`)).toBeVisible();
    else await expect(page.getByText("2 of 2 seats (1 waiting)")).toBeVisible();
  }
  const rows = await sql<{ status: string; feeCents: number }>(`SELECT status, "feeCents" FROM "Enrollment" WHERE "classId" = $1 ORDER BY "createdAt"`, [classId]);
  expect(rows.map((r) => r.status)).toEqual(["ENROLLED", "ENROLLED", "WAITLIST"]);
  expect(rows.every((r) => r.feeCents === 4500)).toBe(true);
  await page.context().close();
});

test("cancel one, move the waiting person up with a text, set a price for one person", async ({ browser }) => {
  const h = hourIn("America/New_York");
  const page = await login(browser, owner);
  await page.goto(`/classes/${classId}`);
  const roster = page.locator("section", { has: page.getByRole("heading", { name: /^Roster/ }) });
  await roster.locator("tr", { hasText: `Bob Baker ${RUN}` }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("1 of 2 seats (1 waiting)")).toBeVisible();

  await clearMockSent();
  const waiting = page.locator("section", { has: page.getByRole("heading", { name: /^Waiting list/ }) });
  await expect(waiting.getByText(`Wendy Waits ${RUN}`)).toBeVisible();
  await expect(waiting.getByLabel("Tell them")).toBeChecked();
  await waiting.getByRole("button", { name: "Move up" }).click();
  await expect(page.getByText("Moved up")).toBeVisible();
  await page.reload();
  await expect(page.getByText("2 of 2 seats")).toBeVisible();
  // Her newest class notice (the waiting-list text came earlier).
  const note = await sql<{ status: string; body: string; channel: string }>(`SELECT status, body, channel FROM "OutMessage" WHERE "shopId" = $1 AND kind = 'class_notice' AND "customerId" = $2 ORDER BY "createdAt" DESC LIMIT 1`, [shopId, waitingCustomerId]);
  expect(note).toHaveLength(1);
  expect(note[0].channel).toBe("sms");
  expect(note[0].body).toMatch(/Good news: a seat opened up for you in Beginning Quilting/);
  if (h >= 9 && h < 20) {
    await sendNow(page);
    const sent = await eventually(async () => (await mockSent()).find((m) => m.to === "+12125550183"));
    expect(sent.body).toMatch(/Good news: a seat opened up/);
  }

  await page.goto(`/classes/${classId}`);
  const ann = roster.locator("tr", { hasText: `Ann Able ${RUN}` });
  await ann.getByLabel(`Price for Ann Able ${RUN}`).fill("30");
  await ann.getByRole("button", { name: "Price for this person" }).click();
  await expect(page.getByText("Price saved")).toBeVisible();
  await page.reload();
  await expect(roster.locator("tr", { hasText: `Ann Able ${RUN}` })).toContainText("Owes $30.00");
  await expect(roster.locator("tr", { hasText: `Ann Able ${RUN}` }).getByRole("link", { name: "Ring up" })).toHaveAttribute("href", /\/register\?booking=enrollment:/);
  await page.context().close();
});

test("the roster prints 2 names and 4 attendance boxes; the month print lists it; the customer page shows Ring up", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto(`/classes/${classId}/roster`);
  await expect(page.getByRole("heading", { name: "Roster" })).toBeVisible();
  await expect(page.getByText(`Ann Able ${RUN}`)).toBeVisible();
  await expect(page.getByText(`Wendy Waits ${RUN}`)).toBeVisible();
  await expect(page.getByText(`Bob Baker ${RUN}`)).toHaveCount(0);
  await expect(page.getByLabel("attendance box")).toHaveCount(8); // 2 people x 4 meetings
  await expect(page.getByRole("button", { name: "Print or save PDF" })).toBeVisible();

  const month = nextTuesday().slice(0, 7);
  await page.goto(`/classes/print?month=${month}`);
  await expect(page.getByText(`Beginning Quilting ${RUN}`).first()).toBeVisible();
  await expect(page.getByText(/Jo Quilter .* \$45\.00 .* Full/).first()).toBeVisible();

  await page.goto(`/customers/${waitingCustomerId}`);
  const classes = page.locator("section", { has: page.getByRole("heading", { name: "Classes" }) });
  await expect(classes.getByRole("link", { name: `Beginning Quilting ${RUN}` })).toBeVisible();
  await expect(classes.getByText("Owes $45.00")).toBeVisible();
  await expect(classes.getByRole("link", { name: "Ring up" })).toBeVisible();
  await page.context().close();
});
