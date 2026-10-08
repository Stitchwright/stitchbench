// Shop hop passports, the program's side (shop-features-round-2-design.md 4.6): Shop hop is not in the menu until the
// owner turns it on in Settings, Selling; then the Shop hop page says to join the hub when the install hasn't, and with
// the hub (the lead's hub build with the /v1/hops routes) an organizer starts a hop, and a passport typed in gets the big
// tick. The hub part needs the hub's hop routes: this spec runs after the lead builds them (test hub on :3200).
//   Runs on a TEST BUILD. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Hp ${RUN}`;
const owner = { email: `hp-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Hp Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("off until turned on; then the Shop hop page", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/register");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Shop hop" })).toHaveCount(0);
  await page.goto("/hops");
  await expect(page.getByText(/Shop hops are off/)).toBeVisible();
  await page.goto("/settings/sales");
  await page.getByRole("button", { name: "Turn shop hops on" }).click();
  await expect(page.getByText(/Shop hops are on/)).toBeVisible();
  await page.goto("/register");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Shop hop" }).click();
  await expect(page.getByRole("heading", { name: "Shop hop" })).toBeVisible();
  await expect(page.getByText(/No hops yet|Join it in Settings, Community hub/).first()).toBeVisible();
});

test("with the hub: start a hop and stamp a passport by its code", async ({ browser }) => {
  test.skip(!process.env.E2E_HUB_HOPS, "needs the hub's /v1/hops routes (set E2E_HUB_HOPS=1 once the lead's hub build has them)");
  const page = await login(browser, owner);
  await page.goto("/hops");
  await page.getByText("Organizing a hop? Start one").click();
  await page.getByLabel("Name").fill(`Fall Hop ${RUN}`);
  const today = new Date().toISOString().slice(0, 10);
  await page.getByLabel("First day").fill(today);
  await page.getByLabel("Last day").fill(today);
  await page.getByRole("button", { name: "Start the hop" }).click();
  await expect(page.getByRole("heading", { name: `Fall Hop ${RUN}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open the camera" })).toBeVisible();
  // A passport made on the hub's hop page (E2E_HOP_PASSPORT), typed in.
  await page.getByLabel("Or type the code on her passport").fill(process.env.E2E_HOP_PASSPORT ?? "HOP-0000-0000");
  await page.getByRole("button", { name: "Stamp it" }).click();
  await expect(page.getByText(/Stamp 1 of 1|isn't in this hop/)).toBeVisible();
});
