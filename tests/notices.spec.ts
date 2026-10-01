// Customer notices end to end (scheduling-messaging-design.md 15.2 acceptance 4). Runs on a TEST BUILD with the SMTP sink
// running, as messaging.spec.ts does; the server needs READY_NOTICE_DELAY_SECONDS=1 (or so) for the ready notice to be
// due by the time "Send now" is pressed. It makes its own company (Marketing switched on from Companies) and removes it
// at the end. The unsubscribe steps seed a marketing email with scripts/checks/seed-marketing.ts.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearSink, eventually, sendNow, sinkMessages } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const company = `Ntc ${RUN}`;
const owner = { email: `ntc-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const TRACKING = "9400 1000 0000 0000 0000 00";
let shopId: string;
let admin: Page;
const made: string[] = [];

/** Runs seed-marketing.ts for this company and returns the token it prints. */
function seedMarketing(email: string): string {
  const root = path.resolve(__dirname, "..");
  const out = execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "--conditions=react-server", "scripts/checks/seed-marketing.ts", "--shop", shopId, "--email", email, "--name", `Unsub Reader ${RUN}`], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  const token = /token=([A-Za-z0-9_-]{22})/.exec(out)?.[1];
  if (!token) throw new Error(`seed-marketing printed no token:\n${out}`);
  return token;
}

/** A direct ticket for a new customer who wants email. */
async function newTicket(page: Page, customer: { name: string; email: string }): Promise<string> {
  await page.goto("/tickets/new");
  await page.getByLabel("New customer name").fill(customer.name);
  await page.getByLabel("Email address").fill(customer.email);
  await page.getByRole("radio", { name: "Email", exact: true }).check();
  await page.getByLabel("Brand", { exact: true }).fill("Janome");
  await page.getByLabel("Model", { exact: true }).fill("MC6700P");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Janome MC6700P/ })).toBeVisible();
  return page.url().split("/").pop()!.split("?")[0];
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Ntc Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await setModule(admin, company, "Marketing", true);
  await clearSink();
});

test.afterAll(async () => {
  for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("email is set up for the company", async ({ browser }) => {
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

test("a ready ticket: the toast names the channel, Send now delivers it, the ticket shows it Sent, a notice by hand is proof, the letter prints", async ({ browser }) => {
  const page = await login(browser, owner);
  const email = `rita-${RUN.toLowerCase()}@customer.test`;
  const ticketId = await newTicket(page, { name: `Rita Ready ${RUN}`, email });

  // Ready: the toast says what goes to whom and when.
  await page.getByLabel("Status", { exact: true }).selectOption({ label: "Ready - customer called" });
  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast).toBeVisible();
  const said = await toast.innerText();
  console.log("ready toast:", said);
  expect(said).toMatch(/An email goes to Rita Ready .* at .*Change the status back before then to stop it/);
  const queued = await sql<{ status: string; kind: string }>(`SELECT status, kind FROM "OutMessage" WHERE "ticketId" = $1`, [ticketId]);
  expect(queued).toEqual([{ status: "QUEUED", kind: "ready" }]);

  // Sent by the worker; the sink has it; the ticket's Messages section shows it Sent.
  await sendNow(page);
  const mail = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(email)));
  expect(mail.raw).toMatch(/Subject: Your Janome MC6700P is ready/);
  await page.goto(`/tickets/${ticketId}`);
  const messages = page.locator("section", { has: page.getByRole("heading", { name: "Messages" }) });
  await expect(messages.getByText("Ready for pickup", { exact: true })).toBeVisible();
  await expect(messages.locator(".pill", { hasText: "Sent" })).toBeVisible();

  // The uncollected-machine schedule shows its dates.
  await expect(messages.getByRole("heading", { name: "If it isn't picked up" })).toBeVisible();
  await expect(messages.getByText(/Abandoned after /)).toBeVisible();

  // A notice given by hand (certified mail with a tracking number) is recorded as proof.
  await messages.getByText("Record a notice given by hand").click();
  await messages.getByLabel("How", { exact: true }).selectOption("certified_mail");
  await messages.getByLabel("Tracking number (certified mail)").fill(TRACKING);
  await messages.getByLabel("What was said or sent").fill("Final notice letter, mailed today.");
  await messages.getByRole("button", { name: "Record it" }).click();
  await expect(page.getByText("Recorded", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(new RegExp(`Given by certified mail .*\\(tracking ${TRACKING}\\) · recorded by Ntc Owner`)).first()).toBeVisible();
  const proof = await sql<{ channel: string; status: string; providerId: string }>(`SELECT channel, status, "providerId" FROM "OutMessage" WHERE "ticketId" = $1 AND kind = 'abandon'`, [ticketId]);
  expect(proof).toEqual([{ channel: "certified_mail", status: "SENT", providerId: TRACKING }]);

  // The notice letter: shop header, the customer, the machine, and a print button.
  await page.getByRole("link", { name: "Print as a letter" }).first().click();
  await expect(page.getByRole("heading", { name: "Notice letter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print or save PDF" })).toBeVisible();
  await expect(page.getByText(`Rita Ready ${RUN}`)).toBeVisible();
  await expect(page.getByText(/Re: your Janome MC6700P/)).toBeVisible();
  await expect(page.getByText(company).first()).toBeVisible();
  await page.context().close();
});

test("the unsubscribe link: opening changes nothing, the button opts out, Opt-outs shows it, one-click POST answers 200", async ({ browser }) => {
  const email = `unsub-${RUN.toLowerCase()}@customer.test`;
  const token = seedMarketing(email);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // GET: the question, nothing more about the customer than a masked address; no suppression yet.
  await page.goto(`/u/${token}`);
  await expect(page.getByText(`Stop marketing emails from ${company} to u•••@customer.test?`)).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(email);
  const before = await sql(`SELECT 1 FROM "Suppression" WHERE "shopId" = $1 AND address = $2`, [shopId, email]);
  expect(before).toHaveLength(0);
  const get = await page.request.get(`/api/u/${token}`, { maxRedirects: 0 });
  expect(get.status()).toBe(303);
  expect(await sql(`SELECT 1 FROM "Suppression" WHERE "shopId" = $1 AND address = $2`, [shopId, email])).toHaveLength(0);

  // The button: done, and the suppression is there (marketing only, from the link).
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByText(/Done\. You won't get marketing emails from/)).toBeVisible();
  const sup = await sql<{ channel: string; scope: string; source: string }>(`SELECT channel, scope, source FROM "Suppression" WHERE "shopId" = $1 AND address = $2`, [shopId, email]);
  expect(sup).toEqual([{ channel: "email", scope: "marketing", source: "unsubscribe_link" }]);
  await page.reload();
  await expect(page.getByText(/Done\. You won't get marketing emails from/)).toBeVisible();

  // Opt-outs lists it.
  const shop = await login(browser, owner);
  await shop.goto("/messages/opt-outs");
  // Two tables name the address: the opt-outs and the consent record. The opt-out row says the scope.
  const row = shop.getByRole("row", { name: new RegExp(`${email} Email Marketing only Unsubscribe link`) });
  await expect(row).toBeVisible();
  await shop.context().close();

  // RFC 8058 one-click from a mail program: 200, and the second address is suppressed too.
  const email2 = `unsub2-${RUN.toLowerCase()}@customer.test`;
  const token2 = seedMarketing(email2);
  const res = await page.request.post(`/api/u/${token2}`, { form: { "List-Unsubscribe": "One-Click" } });
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("Unsubscribed.");
  expect(await sql(`SELECT 1 FROM "Suppression" WHERE "shopId" = $1 AND address = $2 AND source = 'unsubscribe_link'`, [shopId, email2])).toHaveLength(1);

  // A bad token: nothing to do, no hint about anyone.
  await page.goto("/u/not-a-real-token-here");
  await expect(page.getByText("This link isn't valid.")).toBeVisible();
  await ctx.close();
});
