// Campaigns end to end (scheduling-messaging-design.md 15.4 acceptance 4). Runs on a TEST BUILD with the SMTP sink and
// the Twilio mock running and PUBLIC_URL set on the server (the hosted rules), as messaging.spec.ts does. It makes its
// own company (Marketing switched on from Companies) and removes it at the end.
import bcrypt from "bcryptjs";
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearMockSent, clearSink, eventually, mockSent, sendNow, sinkMessages } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const SHOP_NUMBER = "+12125550100";
const POSTAL = "12 Elm St, Springfield, IL 62701";
const company = `Cmp ${RUN}`;
const owner = { email: `cmp-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const tech = { email: `cmp-tech-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const lower = RUN.toLowerCase();
const emails = { ann: `ann-${lower}@customer.test`, bob: `bob-${lower}@customer.test`, gone: `gone-${lower}@customer.test` };
let shopId: string;
let admin: Page;
let emailCampaignId: string;
const made: string[] = [];

/** The hour now in a zone (0-23). */
const hourIn = (tz: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));

async function newCampaign(page: Page, o: { name: string; channel: "email" | "sms"; subject?: string; body: string }): Promise<string> {
  await page.goto("/campaigns/new");
  await page.getByLabel("Name (for your own list)").fill(o.name);
  await page.getByRole("radio", { name: o.channel === "email" ? "Email" : "Text", exact: true }).check();
  if (o.channel === "email") await page.getByLabel("Subject").fill(o.subject ?? "Hello");
  await page.getByLabel(o.channel === "email" ? "What the email says" : "What the text says").fill(o.body);
  await page.getByRole("button", { name: "Save draft" }).click();
  // Not /campaigns/new itself: the id appears once the save has redirected.
  await expect(page).toHaveURL(/\/campaigns\/(?!new$)[a-z0-9]+$/, { timeout: 20_000 });
  return page.url().split("/").pop()!;
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Cmp Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  // Marketing texts go only 9:00-20:00 in the shop's zone AND the number's zone (212 = Eastern): the shop is Eastern.
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', address = $2 WHERE id = $1`, [shopId, POSTAL]);
  await setModule(admin, company, "Marketing", true);
  await clearSink();
  await clearMockSent();
  // Three retail customers: two with email, one unsubscribed; a tech of the company for the read-only check.
  await insert("Customer", { shopId, name: `Ann Able ${RUN}`, email: emails.ann, notifyBy: "email" });
  await insert("Customer", { shopId, name: `Bob Baker ${RUN}`, email: emails.bob, notifyBy: "email" });
  await insert("Customer", { shopId, name: `Gone Gale ${RUN}`, email: emails.gone, notifyBy: "email" });
  await sql(`INSERT INTO "Suppression" ("shopId", channel, address, scope, source) VALUES ($1, 'email', $2, 'marketing', 'staff')`, [shopId, emails.gone]);
  await insert("User", { shopId, email: tech.email, name: "Cmp Tech", role: "TECH", passwordHash: await bcrypt.hash(PASSWORD, 10) });
});

test.afterAll(async () => {
  for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
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
  await page.getByLabel("Reply-to address").fill(owner.email);
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

test("an email campaign to everyone: the check, a test to the admin, the two-tap send, the emails and the counts", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/campaigns");
  await expect(page.getByRole("link", { name: "Bring in your email list" })).toBeVisible();
  await page.getByRole("link", { name: "New campaign" }).click();
  await expect(page).toHaveURL(/\/campaigns\/new$/);
  emailCampaignId = await newCampaign(page, { name: `Spring special ${RUN}`, channel: "email", subject: "Spring tune-up special", body: "Hi {first_name},\n\n$20 off a full service this month. Bring this email in." });

  // The check: 2 people, 1 unsubscribed; the sample uses the sample names, not a customer's.
  await expect(page.getByText("2 people will get it. Not sending to: 1 unsubscribed.")).toBeVisible();
  const sample = page.locator("section", { has: page.getByRole("heading", { name: "The check" }) });
  await expect(sample.getByText("Hi Mary,")).toBeVisible();
  await expect(sample.getByText(/This is an advertisement from/)).toBeVisible();

  // "Send me a test": the sink has it, with [Test] and the sample names only.
  await clearSink();
  await page.getByRole("button", { name: "Send me a test" }).click();
  await expect(page.locator("[data-sonner-toast]").first()).toHaveText(/Sent to/);
  const testMail = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(owner.email)));
  const testRaw = testMail.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  expect(testRaw).toMatch(/\[Test\] Spring tune-up special/);
  expect(testRaw).toContain("Hi Mary,");
  expect(testRaw).not.toContain("Ann Able");
  expect(testRaw).not.toContain(emails.ann);

  // The two-tap send.
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await page.getByRole("button", { name: "Tap again to send to 2 people" }).click();
  await expect(page.getByText("Queued. It goes out in a moment.")).toBeVisible();
  await expect(page.getByText(/Getting ready|Sending/).first()).toBeVisible();
  const row = await sql<{ status: string; members: unknown }>(`SELECT status, members FROM "Campaign" WHERE id = $1`, [emailCampaignId]);
  expect(["QUEUING", "SENDING"]).toContain(row[0].status);
  expect((row[0].members as string[]).length).toBe(3);

  // The worker builds and sends: both customers get it, with the postal address, the advertisement line and the headers.
  await clearSink();
  await sendNow(page);
  const mails = await eventually(async () => {
    const all = (await sinkMessages()).filter((m) => m.to.includes(emails.ann) || m.to.includes(emails.bob));
    return all.length === 2 ? all : null;
  });
  for (const m of mails) {
    const raw = m.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
    expect(raw).toContain(POSTAL);
    expect(raw).toMatch(/This is an advertisement from/);
    expect(raw).toMatch(/List-Unsubscribe:/i);
    expect(raw).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
    expect(raw).toMatch(/\/u\/[A-Za-z0-9_-]{22}/);
    expect(raw).not.toContain(emails.gone);
  }
  expect((await sinkMessages()).some((m) => m.to.includes(emails.gone))).toBe(false);

  // Finished: Sent 2, skipped 1 (the sweep runs on the next pass).
  await sendNow(page);
  await page.goto(`/campaigns/${emailCampaignId}`);
  await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();
  const progress = page.locator("section", { has: page.getByRole("heading", { name: "Progress" }) });
  await expect(progress).toContainText(/Sent\s*2/);
  await expect(progress).toContainText(/1 unsubscribed/);
  await expect(page.getByRole("heading", { name: /Recipients/ })).toBeVisible();
  await expect(page.locator("tr", { hasText: emails.ann }).getByText("Sent", { exact: true })).toBeVisible();
  await page.goto("/campaigns");
  await expect(page.locator("tr", { hasText: `Spring special ${RUN}` })).toContainText("Sent");
  await page.context().close();
});

test("a text campaign skips people without written consent; the texts end with the STOP line", async ({ browser }) => {
  const h = hourIn("America/New_York");
  test.skip(h < 10 || h > 18, "marketing texts go out 9:00-20:00 Eastern only; run this in the daytime");
  const consented = await insert<{ id: string }>("Customer", { shopId, name: `Cara Consent ${RUN}`, phone: "+12125550171", notifyBy: "sms", smsConsentAt: new Date(), smsConsentPhone: "+12125550171", smsConsentSource: "paper" });
  await insert("Customer", { shopId, name: `Dan Doubtful ${RUN}`, phone: "+12125550172", notifyBy: "sms" });
  const page = await login(browser, owner);
  const id = await newCampaign(page, { name: `Text special ${RUN}`, channel: "sms", body: "Spring special: $20 off a full service this month." });
  await expect(page.getByText(/^1 person will get it\. Not sending to: .*1 haven't agreed to texts/)).toBeVisible();
  await expect(page.getByText(/1 text x 1 part/)).toBeVisible();
  await clearMockSent();
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await page.getByRole("button", { name: "Tap again to send to 1 person" }).click();
  await expect(page.getByText("Queued. It goes out in a moment.")).toBeVisible();
  await sendNow(page);
  const sent = await eventually(async () => (await mockSent()).find((m) => m.to === "+12125550171"));
  expect(sent.body).toMatch(/^.*: Spring special: \$20 off a full service this month\. Reply STOP to opt out\.$/);
  expect((await mockSent()).some((m) => m.to === "+12125550172")).toBe(false);
  const rows = await sql<{ status: string; address: string }>(`SELECT status, address FROM "OutMessage" WHERE "campaignId" = $1`, [id]);
  expect(rows).toEqual([{ status: "SENT", address: "+12125550171" }]);
  void consented;
  await page.context().close();
});

test("without a postal address, Send now says so; a tech sees campaigns read-only", async ({ browser }) => {
  await sql(`UPDATE "MessagingSettings" SET "postalAddress" = NULL WHERE "shopId" = $1`, [shopId]);
  await sql(`UPDATE "Shop" SET address = NULL WHERE id = $1`, [shopId]);
  const page = await login(browser, owner);
  const id = await newCampaign(page, { name: `No address ${RUN}`, channel: "email", subject: "Hello again", body: "Hi {first_name}, hello again." });
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await page.getByRole("button", { name: "Tap again to send to 2 people" }).click();
  await expect(page.getByText("Add the shop's postal address in Settings -> Messages. Marketing email must show it.")).toBeVisible();
  expect((await sql<{ status: string }>(`SELECT status FROM "Campaign" WHERE id = $1`, [id]))[0].status).toBe("DRAFT");
  await sql(`UPDATE "Shop" SET address = $2 WHERE id = $1`, [shopId, POSTAL]);
  await page.context().close();

  const t = await login(browser, tech);
  await t.goto("/campaigns");
  await expect(t.getByRole("heading", { name: "Campaigns" })).toBeVisible();
  await expect(t.getByRole("link", { name: "New campaign" })).toHaveCount(0);
  await expect(t.locator("tr", { hasText: `Spring special ${RUN}` })).toBeVisible();
  await t.goto(`/campaigns/${emailCampaignId}`);
  await expect(t.getByRole("heading", { name: "Progress" })).toBeVisible();
  await expect(t.getByRole("button", { name: "Copy" })).toHaveCount(0);
  await t.goto(`/campaigns/${id}`);
  await expect(t.getByText("2 people will get it.")).toBeVisible();
  await expect(t.getByRole("button", { name: "Send now", exact: true })).toHaveCount(0);
  await expect(t.getByLabel("Subject")).toHaveCount(0);
  await t.context().close();
});
