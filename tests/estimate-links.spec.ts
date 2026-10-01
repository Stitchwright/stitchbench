// Estimate approval by link, end to end (scheduling-messaging-design.md 15.3 acceptance 3). Runs on a TEST BUILD with the
// SMTP sink and the Twilio mock running, as messaging.spec.ts does, and is run twice: once with PUBLIC_URL set on the
// server (the same value in this process: the link tests) and once without it (the "they call or reply" tests).
// It makes its own company (Marketing switched on from Companies) and removes it at the end.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearMockSent, clearSink, eventually, mockInbound, mockSent, sendNow, sinkMessages } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const SHOP_NUMBER = "+12125550100";
const PUBLIC = process.env.PUBLIC_URL?.trim() || "";
const company = `Est ${RUN}`;
const owner = { email: `est-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page;
const made: string[] = [];

/** A direct ticket for a new customer, with $145.00 on the bill, waiting for the customer's OK (set on the page). */
async function waitingTicket(page: Page, customer: { name: string; email?: string; phone?: string; notify: "Email" | "Text" }): Promise<string> {
  await page.goto("/tickets/new");
  await page.getByLabel("New customer name").fill(customer.name);
  if (customer.phone) await page.getByLabel("Phone", { exact: true }).fill(customer.phone);
  if (customer.email) await page.getByLabel("Email address").fill(customer.email);
  await page.getByRole("radio", { name: customer.notify, exact: true }).check();
  await page.getByLabel("Brand", { exact: true }).fill("Janome");
  await page.getByLabel("Model", { exact: true }).fill("MC6700P");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Janome MC6700P/ })).toBeVisible();
  const id = page.url().split("/").pop()!.split("?")[0];
  await sql(`INSERT INTO "TicketLine" (id, "ticketId", kind, description, qty, "unitPriceCents", taxable) VALUES ($1, $2, 'SERVICE', 'Cleaning and oil', 1, 14500, false)`, [`est${RUN.toLowerCase()}${Math.random().toString(36).slice(2, 10)}`, id]);
  await page.reload();
  await page.getByLabel("Status", { exact: true }).selectOption({ label: "Waiting on customer OK" });
  await expect(page.getByText("Status: Waiting on customer OK")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Customer's OK" })).toBeVisible();
  return id;
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Est Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  // Texts only go out 9:00-20:00 shop time: pick a zone where it is mid-day now.
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

test("an estimate link: sent by email, opened signed out, approved after the confirm step, shown on the ticket", async ({ browser }) => {
  test.skip(!PUBLIC, "needs PUBLIC_URL on the server and in this process");
  const page = await login(browser, owner);
  const name = `Linda Approver ${RUN}`;
  const email = `linda-${RUN.toLowerCase()}@customer.test`;
  const ticketId = await waitingTicket(page, { name, email, notify: "Email" });

  // Send: the form offers email (ticked) and the wording with the link.
  await expect(page.getByLabel("Email", { exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Send the estimate", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send the estimate", exact: true }).click();
  await expect(page.getByText("Queued. It goes out in a moment.")).toBeVisible();
  await sendNow(page);
  const mail = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(email)));
  const raw = mail.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const url = /(https?:\/\/[^\s"<>]+\/e\/[A-Za-z0-9_-]{43})/.exec(raw)?.[1];
  expect(url, "the email carries the /e/ link").toBeTruthy();
  expect(url!.startsWith(PUBLIC)).toBe(true);
  const stored = await sql<{ body: string }>(`SELECT body FROM "OutMessage" WHERE "ticketId" = $1`, [ticketId]);
  expect(stored[0].body).not.toContain(url!.split("/e/")[1]);
  expect(stored[0].body).toMatch(/\/e\/•••/);

  // Back on the ticket (sendNow went to the Messages page): it stays open while the customer answers.
  await page.goto(`/tickets/${ticketId}`);

  // The customer, signed out: the lines and the total, nothing else about them.
  const ctx = await browser.newContext();
  const link = await ctx.newPage();
  const path = url!.slice(PUBLIC.length);
  await link.goto(path);
  await expect(link.getByText("Cleaning and oil")).toBeVisible();
  await expect(link.getByText("$145.00").first()).toBeVisible();
  const text = await link.locator("body").innerText();
  expect(text).toContain("Linda");
  expect(text).not.toContain("Approver");
  expect(text).not.toContain(email);
  await expect(link.getByRole("link", { name: /^Approve/ })).toBeVisible();

  // The GET "Approve" step changes nothing.
  await link.getByRole("link", { name: /^Approve/ }).click();
  await expect(link.getByText(/Approve \$145\.00 for your Janome MC6700P\?/)).toBeVisible();
  const state = await sql<{ answer: string | null; status: string }>(`SELECT l.answer, t.status FROM "EstimateLink" l JOIN "Ticket" t ON t.id = l."ticketId" WHERE t.id = $1`, [ticketId]);
  expect(state[0].answer).toBeNull();
  expect(state[0].status).toBe("WAITING_CUSTOMER_OK");

  // The ticket page stays open, the customer confirms: the bench sees it without a reload.
  await expect(page.getByText(/Sent .* by email/)).toBeVisible();
  await link.getByLabel("Anything to tell us?").fill("Please hurry");
  await link.getByRole("button", { name: "Yes, approve" }).click();
  await expect(link.getByText(/You approved this on/)).toBeVisible();
  await expect(page.getByText(/Approved by link/)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Status now: On bench")).toBeVisible();
  await expect(page.getByText(/note: Please hurry/)).toBeVisible();

  // Reloaded, the status says so too; the link shows the answer and can't be answered again.
  await page.reload();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("ON_BENCH");
  await link.reload();
  await expect(link.getByText(/You approved this on/)).toBeVisible();
  await expect(link.getByRole("link", { name: /^Approve/ })).toHaveCount(0);
  const res = await link.request.post(`${PUBLIC}/api/e/${path.split("/e/")[1]}`, { form: { answer: "DECLINED", confirm: "1" }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
  const after = await sql<{ answer: string }>(`SELECT answer FROM "EstimateLink" WHERE "ticketId" = $1`, [ticketId]);
  expect(after[0].answer).toBe("APPROVED");
  const garbage = await link.goto("/e/not-a-real-token");
  expect(garbage?.status()).toBe(200);
  await expect(link.getByText("This link isn't valid. Please call the shop.")).toBeVisible();
  await ctx.close();
  await page.context().close();
});

test("without a public address: no link, they call or reply, a text reply shows with They approved", async ({ browser }) => {
  test.skip(!!PUBLIC, "run again without PUBLIC_URL");
  const page = await login(browser, owner);
  const phone = "(212) 555-0163";
  const name = `Terry Texter ${RUN}`;
  const ticketId = await waitingTicket(page, { name, phone, notify: "Text" });

  await expect(page.getByRole("button", { name: "Send the estimate (they call or reply)" })).toBeVisible();
  await expect(page.getByLabel("Text", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Send the estimate (they call or reply)" }).click();
  await expect(page.getByText("Queued. It goes out in a moment.")).toBeVisible();
  await sendNow(page);
  const sent = await eventually(async () => (await mockSent()).find((m) => m.to === "+12125550163"));
  expect(sent.body).toMatch(/\$145\.00/);
  expect(sent.body).toMatch(/reply to this text/i);
  expect(sent.body).not.toContain("/e/");
  const links = await sql(`SELECT id FROM "EstimateLink" WHERE "shopId" = $1`, [shopId]);
  expect(links).toHaveLength(0);

  // Their reply: read by the worker, shown on the ticket.
  await mockInbound("+12125550163", "Yes please go ahead");
  await sql(`UPDATE "MessagingSettings" SET "inboundAt" = NULL WHERE "shopId" = $1`, [shopId]);
  await sendNow(page);
  await page.goto(`/tickets/${ticketId}`);
  await expect(page.getByText("Yes please go ahead")).toBeVisible();
  await page.getByRole("button", { name: "They approved" }).click();
  await expect(page.getByText("Recorded", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("ON_BENCH");
  const t = await sql<{ notes: string; approvedCents: number }>(`SELECT notes, "approvedCents" FROM "Ticket" WHERE id = $1`, [ticketId]);
  expect(t[0].approvedCents).toBe(14500);
  expect(t[0].notes).toContain("by text reply");
  await page.context().close();
});
