// Parts a ticket is waiting for, end to end (online-and-parts-design.md section 1): a ticket records a part on
// order and goes to Waiting on parts; the Parts on order page lists it; Received puts the ticket back on the bench
// and the customer's "the part came in" email reaches the sink; the ticket's Messages shows it.
//   Runs on a TEST BUILD with the SMTP sink, like notices.spec.ts. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearSink, eventually, sendNow, sinkMessages } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const company = `Pw ${RUN}`;
const owner = { email: `pw-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const customer = { name: `Wendy Waits ${RUN}`, email: `wendy-${RUN.toLowerCase()}@customer.test` };
let shopId: string;
let admin: Page;
let ticketId: string;
const made: string[] = [];

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("repair");
  await admin.getByLabel("Owner's name").fill("Pw Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York' WHERE id = $1`, [shopId]);
  await setModule(admin, company, "Marketing", true);
  await clearSink();
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("email is set up", async ({ browser }) => {
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

test("a ticket records a part on order and goes to Waiting on parts; the on-order page lists it", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/tickets/new");
  await page.getByLabel("new customer's name").fill(customer.name);
  await page.getByLabel("Email address").fill(customer.email);
  const notify = page.getByRole("radio", { name: "Email", exact: true });
  if (await notify.count()) await notify.check();
  await page.getByLabel("Brand", { exact: true }).fill("Janome");
  await page.getByLabel("Model", { exact: true }).fill("MC6700P");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Janome MC6700P/ })).toBeVisible();
  ticketId = page.url().split("/").pop()!.split("?")[0];

  const card = page.locator("section", { has: page.getByRole("heading", { name: /Parts on order|Waiting on/ }) });
  // The form is open already when nothing is on order; clicking its summary then would fold it away.
  const details = card.locator("details", { hasText: "Waiting on a part" });
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator("summary").click();
  await card.getByLabel("What it is (the customer reads this)").fill("Bobbin case");
  await card.getByLabel("Supplier").fill("Sewing Parts Online");
  await card.getByRole("button", { name: "Record the part on order" }).click();
  await expect(page.getByText("Recorded", { exact: true })).toBeVisible();
  await page.reload(); // the status select is uncontrolled: it shows the change after a reload, as the estimate spec does
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("WAITING_PARTS");
  await expect(page.getByRole("heading", { name: "Waiting on a part" })).toBeVisible();

  await page.goto("/parts/on-order");
  await expect(page.getByRole("heading", { name: /Sewing Parts Online/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Bobbin case/ })).toContainText(customer.name);
  await page.context().close();
});

test("Received: the ticket goes back on the bench and the customer's email reaches the sink", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/parts/on-order");
  const row = page.getByRole("row", { name: /Bobbin case/ });
  await row.getByRole("button", { name: "Received", exact: true }).click();
  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast).toBeVisible();
  expect(await toast.innerText()).toMatch(/Received it\. The customer hears the part is in\./);
  await expect(page.getByText("Nothing on order")).toBeVisible();

  await page.goto(`/tickets/${ticketId}`);
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("ON_BENCH");
  await expect(page.getByText("customer told")).toBeVisible();
  await sendNow(page);
  const mail = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(customer.email)));
  expect(mail.raw).toMatch(/Subject: The part for your Janome MC6700P is in/);
  expect(mail.raw.replace(/=\r?\n/g, "")).toMatch(/came in: Bobbin case\./);
  await page.goto(`/tickets/${ticketId}`);
  const messages = page.locator("section", { has: page.getByRole("heading", { name: "Messages" }) });
  await expect(messages.getByText("Parts arrived", { exact: true })).toBeVisible();
  await page.context().close();
});
