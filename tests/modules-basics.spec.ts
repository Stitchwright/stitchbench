// Paid modules, end to end (modules-design.md section 13.2, modules-foundation acceptance 8 and 9): keys pasted in
// Settings -> Modules, the kinds they unlock at check-in, the administrator's switch on Companies, work that came in
// before a module was switched off, and the register with no vacuum lines.
//   Runs on a TEST BUILD (STITCH_TEST_BUILD=1 npm run build; next start -p 3500) or next dev, against a database on
//   this PC, with E2E_EMAIL in PLATFORM_ADMIN_EMAILS and the e2e logins from `npm run e2e:setup`. It reads and writes
//   the database directly (tests/helpers.ts) to clear the E2E shop's keys first and to remove the companies it makes.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, PNG, RUN, disconnect, expectRefused, login, shopOf, signIn, sql } from "./helpers";
import { devKey, pasteKey } from "./helpers/license-keys";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ymd = (iso: string) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

let e2eShopId: string;
const made: string[] = []; // companies this run created, removed at the end

test.beforeAll(async () => {
  e2eShopId = (await shopOf(OWNER)).shopId;
  // Every run starts with the E2E shop on no module.
  await sql(`DELETE FROM "License" WHERE "shopId" = $1`, [e2eShopId]);
  await sql(`DELETE FROM "ModuleGrant" WHERE "shopId" = $1`, [e2eShopId]);
});

test.afterAll(async () => {
  await sql(`DELETE FROM "License" WHERE "shopId" = $1`, [e2eShopId]);
  await sql(`DELETE FROM "ModuleGrant" WHERE "shopId" = $1`, [e2eShopId]);
  for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
});

/** Creates a company from the Companies screen (the admin is signed in on `page`) and returns its id. */
async function createCompany(page: Page, name: string, ownerEmail: string, kind: "repair" | "both") {
  await page.goto("/companies");
  await page.getByLabel("Company name").fill(name);
  await page.getByLabel("Kind of shop").selectOption(kind);
  await page.getByLabel("Owner's name").fill(`Owner of ${name}`);
  await page.getByLabel("Owner's email (their login)").fill(ownerEmail);
  await page.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByText("Company created")).toBeVisible();
  const row = await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [name]);
  expect(row.length).toBe(1);
  made.push(row[0].id);
  return row[0].id;
}

/** The Companies form: pick the company and module, then press one of "Turn on" / "Turn off" / "Let keys decide". */
async function switchModule(page: Page, company: string, module: string, mode: "Turn on" | "Turn off" | "Let keys decide", lastDay?: string) {
  await page.goto("/companies");
  await page.getByLabel("Company", { exact: true }).selectOption({ label: company });
  await page.getByLabel("Module", { exact: true }).selectOption({ label: module });
  if (lastDay) await page.getByLabel("On until (blank: no end date)").fill(lastDay);
  await page.getByRole("button", { name: mode, exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

test("keys: off, refused keys, a good key, and the kinds it unlocks", async ({ page }) => {
  await signIn(page, OWNER);

  // Nothing on yet.
  await page.goto("/settings/modules");
  await expect(page.getByText("Company ID", { exact: true })).toBeVisible();
  await expect(page.getByText(e2eShopId)).toBeVisible();
  await expect(page.getByText("Test build: test keys work here")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByText("Vac Shop")).toHaveCount(0);
  await page.goto("/vac");
  await expect(page.getByText(/Vac Shop isn't turned on/)).toBeVisible();
  await page.goto("/tickets/new");
  await expect(page.getByRole("heading", { name: "Check in a machine" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Vacuum", exact: true })).toHaveCount(0);

  // A key for another company, and a damaged key.
  await page.goto("/settings/modules");
  const box = page.getByLabel("Paste the key from your email (or the whole email)");
  await box.fill(devKey({ shopId: "someone-elses-company", modules: ["vac"] }));
  await page.getByRole("button", { name: "Add key" }).click();
  await expectRefused(page, /This key is for another company/);
  const good = devKey({ shopId: e2eShopId, modules: ["vac", "appliance"] });
  const [prefix, payload, sig] = good.split(".");
  const flipped = payload[10] === "A" ? "B" : "A";
  await box.fill(`${prefix}.${payload.slice(0, 10)}${flipped}${payload.slice(11)}.${sig}`);
  await page.getByRole("button", { name: "Add key" }).click();
  await expectRefused(page, /damaged/);

  // The good key, pasted inside a made-up email (wrapped lines and all).
  const email = `Subject: Your StitchBench key\n\nHere is your key, good through next year.\n\n${good.slice(0, 70)}\n${good.slice(70, 140)}\n${good.slice(140)}\n\nThanks!`;
  await pasteKey(page, email);
  await expect(page.getByText(/On until/).first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByText("Vac Shop")).toBeVisible();

  // Check-in offers every kind the key unlocked.
  await page.goto("/tickets/new");
  for (const k of ["Vacuum", "Stand mixer", "3D printer", "Resin 3D printer", "Other appliance"]) {
    await expect(page.getByRole("link", { name: k, exact: true })).toBeVisible();
  }
  await page.goto("/tickets/new?kind=vacuum");
  await expect(page.getByRole("heading", { name: "Check in a vacuum" })).toBeVisible();
  await expect(page.getByLabel("Bags or bagless")).toBeVisible();
  await page.getByLabel("New customer name").fill(`Vac Customer ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("Hoover");
  await page.getByLabel("Model", { exact: true }).fill("UH70120");
  await page.getByLabel("Serial number", { exact: true }).fill(`VAC${RUN}`);
  await page.getByLabel("Bags or bagless").selectOption("Bagged");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Hoover UH70120/ })).toBeVisible();
  await expect(page.getByText("Suction").first()).toBeVisible();
  await expect(page.getByText(/Factory tension/)).toHaveCount(0);
  await page.getByLabel("Suction as found").fill("60");
  await page.getByLabel("Suction as left").fill("85");
  await page.getByRole("button", { name: "Save readings" }).click();
  await expect(page.getByText("Readings saved")).toBeVisible();
});

test("Companies: the administrator's switch", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, OWNER);
  const name = `B ${RUN}`;
  const id = await createCompany(page, name, `b-${RUN}@stitchbench.test`, "repair");

  const until = inDays(30);
  await switchModule(page, name, "Scheduling", "Turn on", until);
  const row = page.getByRole("table").first().getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText(`Scheduling until ${ymd(until)}`);
  await expect(row).toContainText(id);

  await row.getByRole("button", { name: "Extend 1 month" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(row).not.toContainText(`Scheduling until ${ymd(until)}`);
  await expect(row).toContainText(/Scheduling until/);

  await switchModule(page, name, "Scheduling", "Turn off");
  await expect(page.getByRole("table").first().getByRole("row", { name: new RegExp(name) })).toContainText("off (switched)");

  await page.getByRole("table").first().getByRole("row", { name: new RegExp(name) }).getByRole("button", { name: "Copy" }).click();
  await expect(page.getByText("Copied")).toBeVisible();
});

test("work already in can be finished after a module is switched off", async ({ page, browser }) => {
  await signIn(page, OWNER);
  const name = `C ${RUN}`;
  const owner = { email: `c-${RUN}@stitchbench.test`, password: PASSWORD };
  const cId = await createCompany(page, name, owner.email, "repair");

  // C's owner pastes a vac key and checks a vacuum in.
  const c = await login(browser, owner);
  await pasteKey(c, devKey({ shopId: cId, modules: ["vac"] }));
  await c.goto("/tickets/new?kind=vacuum");
  await c.getByLabel("New customer name").fill("C Customer");
  await c.getByLabel("Brand", { exact: true }).fill("Miele");
  await c.getByLabel("Model", { exact: true }).fill("C3");
  await c.getByLabel("Bags or bagless").selectOption("Bagged");
  await c.getByRole("button", { name: "Create ticket" }).click();
  await expect(c.getByRole("heading", { level: 1, name: /Miele C3/ })).toBeVisible();
  const ticketUrl = c.url();
  const ticketId = ticketUrl.split("/").pop()!;
  const machineId = (await c.getByRole("link", { name: /history$/ }).getAttribute("href"))!.split("/").pop()!;

  // The administrator switches Vac Shop off for C.
  await switchModule(page, name, "Vac Shop", "Turn off");

  // Work already in: a new line and a status change still go through.
  await c.goto(ticketUrl);
  await c.getByLabel("Hours", { exact: true }).fill("0.5");
  await c.getByRole("button", { name: "Add labor" }).click();
  await expect(c.getByText("Repair labor")).toBeVisible();
  await c.locator("#status").selectOption("READY_FOR_PICKUP");
  await expect(c.getByText("Status: Ready - customer called")).toBeVisible();

  // No new vacuum check-ins.
  await c.goto("/tickets/new?kind=vacuum");
  await expect(c.getByText(/was switched off/)).toBeVisible();
  await expect(c.getByRole("link", { name: "Check in a sewing machine instead" })).toBeVisible();
  await expect(c.getByRole("button", { name: "Create ticket" })).toHaveCount(0);

  // Closing out: collected, then only the closing statuses, a payment, and no new photos.
  await c.goto(ticketUrl);
  await c.locator("#status").selectOption("COLLECTED");
  await expect(c.getByText("Status: Collected by customer")).toBeVisible();
  await c.reload();
  const options = await c.locator("#status option").allTextContents();
  expect(options.sort()).toEqual(["Abandoned", "Collected by customer", "Returned unrepaired"].sort());
  await c.getByLabel("Amount", { exact: true }).fill("10.00");
  await c.getByRole("button", { name: "Record payment" }).click();
  await expect(c.getByText("Payment recorded")).toBeVisible();
  const r = await c.request.post("/api/photos", { multipart: { machineId, ticketId, file: { name: "m.png", mimeType: "image/png", buffer: PNG } } });
  expect(r.status()).toBe(403);
  await c.context().close();
});

test("the register still rings up a plain sale, and adds a customer", async ({ page }) => {
  await signIn(page, OWNER);
  // Counter sales on, and an item to sell.
  await page.goto("/settings#company");
  const company = page.locator("#company");
  if (!(await company.locator('input[name="sellsRetail"]').isChecked())) {
    await company.locator('input[name="sellsRetail"]').check();
    await company.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  }
  const pn = `MOD${RUN}`;
  await page.goto("/parts");
  await page.getByLabel("Part number", { exact: true }).fill(pn);
  await page.getByLabel("Description", { exact: true }).fill("Belt (test)");
  await page.getByLabel("Cost each ($)").fill("2.00");
  await page.getByLabel("Price each ($, blank = cost + markup)").fill("6.00");
  await page.getByLabel("Quantity on hand").fill("5");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByText("5 on hand")).toBeVisible();

  // A plain sale, its receipt, and the void.
  await page.goto("/register");
  await page.locator("#register-code").fill(pn);
  await page.locator("#register-code").press("Enter");
  await expect(page.getByRole("table", { name: "Sale" })).toContainText("Belt (test)");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);
  await page.getByRole("link", { name: "Print receipt" }).click();
  await expect(page.getByRole("heading", { name: /Sale #\d+/ })).toBeVisible();
  await expect(page.getByText("Belt (test)")).toBeVisible();
  await page.getByLabel("Void this sale (rung up by mistake)").fill("test");
  await page.getByRole("button", { name: "Void sale" }).click();
  await expect(page.getByText("Sale voided")).toBeVisible();

  // A customer added from the register; the sale carries them.
  await page.goto("/register");
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Name", { exact: true }).fill(`Counter Customer ${RUN}`);
  await page.getByLabel("Phone", { exact: true }).fill("555-0199");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByText(`Counter Customer ${RUN} added`)).toBeVisible();
  await page.locator("#register-code").fill(pn);
  await page.locator("#register-code").press("Enter");
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("status")).toContainText(/Sale #\d+ done/);
  await page.getByRole("link", { name: "Print receipt" }).click();
  await expect(page.getByText(`Customer: Counter Customer ${RUN}`)).toBeVisible();
});
