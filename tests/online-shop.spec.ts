// The online shop end to end (online-and-parts-design.md section 3): the owner switches it on with the shop's Stripe
// keys and lists an item from its page; a signed-out browser finds it, adds it to the cart, checks out, pays on the
// Stripe mock's page and lands on the order page; the sale is in the books and the stock is down; staff mark it ready
// and the customer's email reaches the sink; picked up closes it.
//   Runs on a TEST BUILD with the SMTP sink and the Stripe mock (STRIPE_API_BASE on the server, STRIPE_MOCK_PORT here).
//   Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearSink, eventually, sendNow, sinkMessages } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const STRIPE_MOCK = `http://127.0.0.1:${process.env.STRIPE_MOCK_PORT ?? "3403"}`;
const company = `Os ${RUN}`;
const owner = { email: `os-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const slug = `os-${RUN.toLowerCase()}`;
const customer = { name: `Olivia Orders ${RUN}`, email: `olivia-${RUN.toLowerCase()}@customer.test` };
let shopId: string;
let partId: string;
let admin: Page;
let orderUrl: string;
const made: string[] = [];

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Os Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York', "sellsRetail" = true, "taxRatePct" = 6.35, phone = '(212) 555-0100', address = '12 Main St' WHERE id = $1`, [shopId]);
  partId = newId();
  await insert("Part", {
    id: partId,
    shopId,
    partNumber: `WF-${RUN}`,
    description: "Walking foot",
    brand: "Janome",
    qtyOnHand: 5,
    priceCents: 2999,
    altNumbers: [],
    numberKeys: [`WF${RUN}`.toUpperCase()],
  });
  await setModule(admin, company, "Marketing", true);
  await clearSink();
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("the owner sets up email, switches the shop on with Stripe keys, and lists an item", async ({ browser }) => {
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

  await page.goto("/settings/shop");
  await page.getByLabel(/^Address \(after \/shop\//).fill(slug);
  await page.getByLabel("The online shop is on").check();
  await page.getByLabel("Pickup at the shop").check();
  await page.getByLabel(/^Pickup instructions/).fill("Ring the bell at the side door.");
  await page.getByLabel(/^Stripe secret key/).fill("sk_test_e2e1234567890");
  await page.getByLabel(/^Webhook signing secret/).fill("whsec_mock1234567890");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`/shop/${slug}$`) })).toBeVisible();

  await page.goto(`/parts/${partId}`);
  await page.getByLabel("Sell online").check();
  await page.getByLabel(/^Title customers see/).fill("Janome walking foot");
  await page.getByRole("button", { name: "Save listing" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  const row = await sql<{ online: boolean; onlineTitle: string }>(`SELECT online, "onlineTitle" FROM "Part" WHERE id = $1`, [partId]);
  expect(row[0]).toMatchObject({ online: true, onlineTitle: "Janome walking foot" });
  await page.context().close();
});

test("a customer, signed out, buys it: cart, checkout, the Stripe mock's page, the order page", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/shop/${slug}`);
  await expect(page.getByRole("link", { name: /Janome walking foot/ })).toBeVisible();
  await page.getByRole("link", { name: /Janome walking foot/ }).click();
  await expect(page.getByRole("heading", { name: "Janome walking foot" })).toBeVisible();
  await page.getByLabel("Quantity").fill("2");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page).toHaveURL(/\/cart\?c=.*added=1/);
  await expect(page.getByText("Added to your cart.")).toBeVisible();
  await expect(page.getByText("$59.98").first()).toBeVisible();
  await page.getByLabel("Your name").fill(customer.name);
  await page.getByLabel("Mobile number").fill("(212) 555-0199");
  await page.getByRole("textbox", { name: "Email" }).fill(customer.email);
  await page.getByRole("radio", { name: "Email" }).check();
  await page.waitForTimeout(5_500); // the bot check: forms sent within five seconds are dropped
  await page.getByRole("button", { name: /^Pay now/ }).click();
  await expect(page).toHaveURL(new RegExp(`^${STRIPE_MOCK.replace(/\./g, "\\.")}/pay/cs_`), { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Stripe mock checkout" })).toBeVisible();
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await expect(page).toHaveURL(/\/shop\/o\/[A-Za-z0-9_-]{43}\?paid=1$/, { timeout: 20_000 });
  orderUrl = page.url().split("?")[0];
  await expect(page.getByRole("heading", { name: "Thanks! We have your order." })).toBeVisible();
  await expect(page.getByText("Order #1001")).toBeVisible();
  const order = await sql<{ status: string; totalCents: number; saleId: string | null }>(`SELECT status, "totalCents", "saleId" FROM "WebOrder" WHERE "shopId" = $1`, [shopId]);
  expect(order).toHaveLength(1);
  expect(order[0].status).toBe("PAID");
  expect(order[0].saleId).not.toBeNull();
  const sale = await sql<{ totalCents: number; tenders: { method: string }[] }>(`SELECT "totalCents", tenders FROM "Sale" WHERE id = $1`, [order[0].saleId]);
  expect(sale[0].totalCents).toBe(order[0].totalCents);
  expect(sale[0].tenders[0].method).toBe("ONLINE");
  expect((await sql<{ qtyOnHand: number }>(`SELECT "qtyOnHand" FROM "Part" WHERE id = $1`, [partId]))[0].qtyOnHand).toBe(3);
  await ctx.close();
});

test("staff mark it ready (the customer's email arrives) and picked up", async ({ browser }) => {
  const staff = await login(browser, owner);
  await staff.goto("/register/online");
  const card = staff.locator("[data-order='1001']");
  await expect(card.getByText("Paid, to pack")).toBeVisible();
  await card.getByRole("button", { name: "Ready for pickup" }).click();
  await expect(staff.getByText("Marked ready; the customer hears").first()).toBeVisible();
  await sendNow(staff);
  const mail = await eventually(async () => (await sinkMessages()).find((m) => m.to.includes(customer.email) && /is ready to pick up/.test(m.raw)));
  expect(mail.raw.replace(/=\r?\n/g, "")).toMatch(/Ring the bell at the side door/);
  await staff.goto("/register/online");
  await expect(staff.locator("[data-order='1001']").getByText("Ready for pickup", { exact: true })).toBeVisible();
  await staff.locator("[data-order='1001']").getByRole("button", { name: "Picked up" }).click();
  await expect(staff.getByText("Picked up", { exact: true }).first()).toBeVisible();
  await expect.poll(async () => (await sql<{ status: string }>(`SELECT status FROM "WebOrder" WHERE "shopId" = $1`, [shopId]))[0].status).toBe("DONE");
  await staff.context().close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(orderUrl);
  await expect(page.getByRole("heading", { name: "Picked up. Thank you!" })).toBeVisible();
  await ctx.close();
});
