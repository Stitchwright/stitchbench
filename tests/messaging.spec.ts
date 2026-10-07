// Email and texts, end to end (scheduling-messaging-design.md 15.1 acceptance 7). Runs on a TEST BUILD with the SMTP sink
// and the Twilio mock running (scripts/test-mail), the server started with SMTP_ALLOW_HOSTS=127.0.0.1:<sink smtp port>
// and TWILIO_API_BASE=http://127.0.0.1:<mock port>, MESSAGE_WORKER_SECONDS=5, and E2E_EMAIL in PLATFORM_ADMIN_EMAILS.
// It makes its own company (Marketing switched on from Companies) and removes it at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearMockSent, clearSink, eventually, mockInbound, mockSent, sendNow, sinkMessages } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const SHOP_NUMBER = "+12125550100"; // the shop's Twilio number on the mock
const company = `M ${RUN}`;
const owner = { email: `m-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page; // the e2e owner, platform admin, on Companies
const made: string[] = [];

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("M Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  // Texts only go out 9:00-20:00 shop time: give the company a zone where it is mid-day right now, so the spec passes
  // whatever the hour here.
  const zone = ["America/New_York", "America/Los_Angeles", "Pacific/Honolulu", "Pacific/Auckland", "Asia/Tokyo", "Asia/Kolkata", "Europe/Berlin", "Atlantic/Azores"].find((tz) => {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
    return h >= 10 && h <= 18;
  })!;
  await sql(`UPDATE "Shop" SET "timeZone" = $1 WHERE id = $2`, [zone, shopId]);
  await setModule(admin, company, "Marketing", true);
  await clearSink();
  await clearMockSent();
});

test.afterAll(async () => {
  for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("an admin sets up email and texts; secrets never reach the page; tests go only to own addresses", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/messages");
  await expect(page.getByRole("heading", { name: "Email and text messages" })).toBeVisible();

  // Email through the sink (a private, plain server: allowed on this test server by SMTP_ALLOW_HOSTS).
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
  expect(await page.content()).not.toContain("sink-secret-pass-77");
  await expect(page.getByText(/Working|Saved .*Leave blank/).first()).toBeVisible();

  // The time zone must be confirmed before texts go on.
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  // Texts through the mock.
  await page.getByLabel("Send texts", { exact: true }).check();
  await page.getByLabel("Account SID").fill("AC" + "0123456789abcdef".repeat(2));
  await page.getByLabel(/Auth Token|secret/i).first().fill("secret");
  await page.getByLabel("Twilio number").fill(SHOP_NUMBER);
  await page.getByRole("button", { name: "Save text settings" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.reload();
  expect(await page.content()).not.toContain('"secret"');

  // Try it: the select offers only the admin's own addresses.
  const toSelect = page.getByLabel("Send a test email to");
  const options = await toSelect.locator("option").allTextContents();
  expect(options.join(" ")).toContain(owner.email);
  expect(options.some((o) => /stranger/.test(o))).toBe(false);
  await page.getByRole("button", { name: "Send a test email" }).click();
  await expect(page.getByText(/Sent to/).first()).toBeVisible();
  const mails = await eventually(async () => {
    const m = await sinkMessages();
    return m.some((x) => x.to.includes(owner.email)) ? m : null;
  });
  expect(mails.some((m) => m.raw.includes("test"))).toBe(true);

  // A test number has to be proved with a code texted to it.
  await page.getByLabel("Mobile number to add").fill("(212) 555-0177");
  await page.getByRole("button", { name: "Text me a code" }).click();
  const codeText = await eventually(async () => (await mockSent()).find((m) => m.to === "+12125550177" && /code is \d{6}/.test(m.body)));
  const code = /(\d{6})/.exec(codeText.body)![1];
  await page.getByLabel("Code from the text").fill(code);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("(212) 555-0177")).toBeVisible();
  await page.context().close();
});

test("a tech sees the settings read-only", async ({ browser }) => {
  const o = await login(browser, owner);
  await o.goto("/settings");
  await o.locator("#u-name").fill("M Tech");
  await o.locator("#u-email").fill(`m-tech-${RUN.toLowerCase()}@stitchbench.test`);
  await o.locator("#u-pw").fill(PASSWORD);
  await o.getByRole("button", { name: "Add person" }).click();
  await expect(o.getByText(/Account created/)).toBeVisible();
  await o.context().close();
  const t = await login(browser, { email: `m-tech-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD });
  await t.goto("/settings/messages");
  await expect(t.getByRole("heading", { name: "Email and text messages" })).toBeVisible();
  await expect(t.getByRole("button", { name: "Save email settings" })).toHaveCount(0);
  await t.context().close();
});

test("how to tell them, consent on the tablet, opt-outs and a STOP reply", async ({ browser }) => {
  const page = await login(browser, owner);
  // A customer with "Text".
  await page.goto("/customers");
  await page.getByLabel("Name", { exact: true }).fill(`Mary Consent ${RUN}`);
  await page.getByLabel("Phone", { exact: true }).fill("(212) 555-0188");
  await page.getByLabel(/How should we tell them/).selectOption("sms");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Mary Consent ${RUN}` })).toBeVisible();
  const customerId = page.url().split("/").pop()!;
  await expect(page.getByText(/Told by Text/)).toBeVisible();

  // The tablet page: no nav, no search; signing records consent and queues the confirmation text.
  await page.goto(`/consent/${customerId}`);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.locator("#q")).toHaveCount(0);
  await page.getByLabel("I agree").check();
  await page.getByLabel("Type your name to sign").fill("Mary Consent");
  await page.getByRole("button", { name: "Sign" }).click();
  await expect(page.getByText(/Thank you/)).toBeVisible();
  await page.goto("/messages/opt-outs");
  await expect(page.getByText("Agreed to marketing texts").first()).toBeVisible();
  await sendNow(page);
  await eventually(async () => (await mockSent()).find((m) => m.to === "+12125550188" && /signed up for texts/i.test(m.body)));

  // An opt-out recorded by staff shows on the customer.
  await page.goto(`/customers/${customerId}`);
  await page.locator("details", { hasText: "Marketing texts" }).locator("summary").first().click();
  await page.getByRole("button", { name: "Record an opt-out" }).click();
  await expect(page.getByText(/Opted out/).first()).toBeVisible();

  // A STOP from another number: read by the worker, listed under Replies and Opt-outs.
  await mockInbound("+12125550199", "STOP");
  // Replies are read at most every 5 minutes: let this run read again now.
  await sql(`UPDATE "MessagingSettings" SET "inboundAt" = NULL WHERE "shopId" = $1`, [shopId]);
  await sendNow(page);
  await page.goto("/messages/replies");
  await expect(page.getByText("+12125550199").or(page.getByText("(212) 555-0199")).first()).toBeVisible();
  await page.goto("/messages/opt-outs");
  await expect(page.getByText("(212) 555-0199").or(page.getByText("+12125550199")).first()).toBeVisible();
  await page.context().close();
});

test("check-in asks how to tell a new customer while email is ready", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/tickets/new");
  await page.getByLabel("new customer's name").fill(`Needs Asking ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("Janome");
  await page.getByLabel("Model", { exact: true }).fill("MC6700P");
  // The question is required in the browser (the server refuses too: "Ask how they'd like to be told").
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page).toHaveURL(/\/tickets\/new/);
  const emailChoice = page.getByRole("radio", { name: "Email", exact: true });
  await expect(emailChoice).toHaveAttribute("required", "");
  await emailChoice.check();
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Janome MC6700P/ })).toBeVisible();
  await page.context().close();
});

test("with Marketing switched off the Messages item is locked, campaigns are refused, and the setup stays (it is in the base)", async ({ browser }) => {
  await setModule(admin, company, "Marketing", false);
  const page = await login(browser, owner);
  await page.goto("/messages");
  const item = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Messages/ });
  await expect(item).toBeVisible();
  await expect(item.getByLabel("Read only")).toBeVisible();
  await page.goto("/campaigns/new");
  await expect(page.getByText(/switched off/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Save/ })).toHaveCount(0);
  // Ready notices and estimate links are in the base (pricing-review-2026-10.md, 7 Oct 2026): the rules stay editable.
  await page.goto("/settings/messages/rules");
  await expect(page.getByRole("button", { name: "Save rules" })).toBeVisible();
  await page.context().close();
});
