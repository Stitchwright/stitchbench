// Small Appliance Repair end to end (modules-design.md 13.2, appliance-repair acceptance 2-4 and modules-e2e 2): a
// stand mixer, a 3D printer and a resin printer at check-in and on their tickets, the shop's own "Espresso machine"
// kind with a question that keeps its answer when relabelled, and "Check-in opens on".
//   Runs on a TEST BUILD against the local database; the admin turns the module on from Companies.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `App ${RUN}`;
const owner = { email: `app-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page;
const made: string[] = [];

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("repair");
  await admin.getByLabel("Owner's name").fill("App Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  made.push(shopId);
  await setModule(admin, company, "Small Appliance Repair", true);
});

test.afterAll(async () => {
  for (const id of made) {
    await sql(`DELETE FROM "Ticket" WHERE "shopId" = $1`, [id]);
    await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  }
  await disconnect();
  await admin.context().close();
});

test("a stand mixer: Tilt-head / Bowl-lift, Bowl size, the dime test and the mixer checklist", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/tickets/new?kind=stand-mixer");
  await expect(page.getByRole("heading", { name: "Check in a stand mixer" })).toBeVisible();
  const types = await page.getByLabel("Type", { exact: true }).locator("option").allTextContents();
  expect(types).toEqual(expect.arrayContaining(["Tilt-head", "Bowl-lift"]));
  await expect(page.getByLabel("Bowl size")).toBeVisible();
  await expect(page.getByLabel("Bowl", { exact: true })).toBeChecked();
  await page.getByLabel("New customer name").fill(`Mixer Owner ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("KitchenAid");
  await page.getByLabel("Model", { exact: true }).fill("KSM150PS");
  await page.getByLabel("Type", { exact: true }).selectOption("Tilt-head");
  await page.getByLabel("Bowl size").selectOption("5 qt");
  await page.getByLabel("Leaking grease").check();
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /KitchenAid KSM150PS/ })).toBeVisible();
  await expect(page.getByLabel("Dime test (planetary mixers) as found")).toBeVisible();
  await expect(page.getByLabel("Old grease removed, gearbox cleaned")).toBeVisible();
  await expect(page.getByText("5 qt", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Dime test (planetary mixers) as left").selectOption("pass");
  await page.getByRole("button", { name: "Save readings" }).click();
  await expect(page.getByText("Readings saved")).toBeVisible();
  await page.context().close();
});

test("a 3D printer asks Filament in use and Nozzle size (no Resin), and its ticket has Firmware version as text", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/tickets/new?kind=3d-printer");
  await expect(page.getByLabel("Filament in use")).toBeVisible();
  await expect(page.getByLabel("Nozzle size")).toBeVisible();
  await expect(page.getByLabel("Resin in use")).toHaveCount(0);
  await expect(page.getByLabel("Build plate", { exact: true })).toBeChecked();
  await page.getByLabel("New customer name").fill(`Printer Owner ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("Prusa");
  await page.getByLabel("Model", { exact: true }).fill("MK4");
  await page.getByLabel("Nozzle size").selectOption("0.4");
  await page.getByLabel("Filament in use").selectOption("PETG");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Prusa MK4/ })).toBeVisible();
  await page.getByLabel("Firmware version as found").fill("6.1.0");
  await page.getByLabel("Firmware version as left").fill("6.2.1");
  await page.getByLabel("Test print as left").selectOption("pass");
  await page.getByRole("button", { name: "Save readings" }).click();
  await expect(page.getByText("Readings saved")).toBeVisible();
  await expect(page.getByLabel("Firmware version as left")).toHaveValue("6.2.1");
  await page.context().close();
});

test("a resin printer asks Resin in use, and its checklist starts with the FEP film", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/tickets/new?kind=resin-printer");
  await expect(page.getByLabel("Resin in use")).toBeVisible();
  await expect(page.getByLabel("Filament in use")).toHaveCount(0);
  await page.getByLabel("New customer name").fill(`Resin Owner ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("Elegoo");
  await page.getByLabel("Model", { exact: true }).fill("Mars 4");
  await page.getByLabel("Resin in use").selectOption("Standard");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Elegoo Mars 4/ })).toBeVisible();
  const checklist = page.locator("section", { has: page.getByRole("heading", { name: "Service checklist" }) });
  const first = await checklist.getByRole("checkbox").first().evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent?.trim());
  expect(first).toBe("FEP / release film checked or replaced");
  await expect(page.getByLabel("LCD exposure test as found")).toBeVisible();
  await page.context().close();
});

test("What you repair: Espresso machine with a Boiler type question; relabelling keeps the answer", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/equipment");
  await expect(page.getByRole("heading", { name: "What you repair" })).toBeVisible();
  const add = page.locator("section", { has: page.getByRole("heading", { name: "Add your own kind" }) });
  await add.getByLabel("Name", { exact: true }).fill("Espresso machine");
  await add.getByLabel("Word used in sentences").fill("espresso machine");
  await add.getByLabel("Types, one per line").fill("Semi-automatic\nSuper-automatic");
  await add.getByLabel("Accessories, one per line (start a line with * to tick it at check-in)").fill("* Power cord\nPortafilter");
  await add.getByLabel("Checklist, one per line").fill("Descaled\nGroup gasket checked");
  await add.getByLabel("Question 1").fill("Boiler type");
  await add.getByLabel("Answer type").first().selectOption("select");
  await add.getByLabel("Choices (separate with commas)").first().fill("Single, Dual");
  await add.getByLabel("Asked").first().selectOption("machine");
  await add.getByRole("button", { name: "Add the kind" }).click();
  await expect(page.getByText("Kind added")).toBeVisible();

  // The chip, the question at check-in, the answer on the ticket.
  await page.goto("/tickets/new");
  await page.getByRole("link", { name: "Espresso machine", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check in an espresso machine" })).toBeVisible();
  await expect(page.getByLabel("Power cord", { exact: true })).toBeChecked();
  await page.getByLabel("New customer name").fill(`Espresso Owner ${RUN}`);
  await page.getByLabel("Brand", { exact: true }).fill("Gaggia");
  await page.getByLabel("Model", { exact: true }).fill("Classic Pro");
  await page.getByLabel("Type", { exact: true }).selectOption("Semi-automatic");
  await page.getByLabel("Boiler type").selectOption("Dual");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Gaggia Classic Pro/ })).toBeVisible();
  const ticketUrl = page.url();
  // The answer shows in Details and again in the intake form's own select: the first is enough.
  await expect(page.getByText("Boiler type").first()).toBeVisible();
  await expect(page.getByText("Dual", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Descaled")).toBeVisible();

  // Relabel the question: the key (and so the answer) stays.
  await page.goto("/settings/equipment");
  // Scoped to "Your own kinds": the built-in "Other appliance" lists "Espresso machine" as a type too.
  const own = page.locator("section", { has: page.getByRole("heading", { name: "Your own kinds" }) });
  const mine = own.locator("details", { hasText: "Espresso machine" }).first();
  await mine.locator("summary").click();
  await mine.getByLabel("Question 1").fill("Boiler");
  await mine.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.goto(ticketUrl);
  await expect(page.getByText("Boiler", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Dual", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Boiler", { exact: true })).toHaveValue("Dual");
  await page.context().close();
});

test("Check-in opens on the stand mixer: /tickets/new starts there and the dashboard offers it first", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/equipment");
  await page.getByLabel("Kind", { exact: true }).selectOption("stand-mixer");
  await page.locator("section", { has: page.getByRole("heading", { name: "Check-in opens on" }) }).getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.goto("/tickets/new");
  await expect(page.getByRole("heading", { name: "Check in a stand mixer" })).toBeVisible();
  await page.goto("/");
  const buttons = page.getByRole("link", { name: /^Check in a/ });
  await expect(buttons.first()).toHaveText(/Check in a stand mixer/);
  await page.context().close();
});
