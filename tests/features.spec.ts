// Settings → Features end to end (free-software-design.md section 7, decision 6; package 2 "StitchBench: free for
// all"): a company made from Companies starts with every add-on off; its owner switches Vac Shop on and the menu and
// check-in follow; the owner adds as many people as she likes; a tech sees the list without the switches; switched
// off, Vac Shop's menu item stays read-only and a vacuum check-in says how to switch it back on; the old Settings →
// Modules address leads to Features; Settings says the program is free and links its source code.
//   Runs on a TEST BUILD (docs/TESTING.md) or next dev, with E2E_EMAIL in PLATFORM_ADMIN_EMAILS (it makes its company
//   from Companies and removes it at the end).
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Feat ${RUN}`;
const owner = { email: `feat-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const techs = [1, 2, 3].map((n) => ({ name: `Feat Tech ${n}`, email: `feat-tech${n}-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD }));
let admin: Page;
let shopId: string;

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Feat Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
});

test.afterAll(async () => {
  if (shopId && !process.env.E2E_KEEP) {
    await sql(`DELETE FROM "Ticket" WHERE "shopId" = $1`, [shopId]);
    await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  }
  await disconnect();
  await admin?.context().close();
});

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

test("every feature starts off; the owner switches Vac Shop on and the menu and check-in follow", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/features");
  for (const id of ["vac", "appliance", "scheduling", "marketing", "maker"]) await expect(page.getByTestId(`feature-${id}`)).toContainText("Off");
  await expect(nav(page).getByText("Vac Shop")).toHaveCount(0);
  await page.getByRole("button", { name: "Switch on Vac Shop" }).click();
  await expect(page.getByText("Vac Shop switched on")).toBeVisible();
  await expect(page.getByTestId("feature-vac")).toContainText("On");
  await expect(page.getByTestId("feature-vac")).toContainText("Switched on");
  await expect(page.getByTestId("feature-vac")).toContainText("by Feat Owner");
  await expect(page.getByRole("heading", { name: "Getting started" })).toBeVisible();
  await page.goto("/tickets/new");
  await expect(page.getByRole("link", { name: "Vacuum", exact: true })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Vac Shop" })).toBeVisible();
  const row = await sql<{ enabled: boolean }>(`SELECT enabled FROM "ShopFeature" WHERE "shopId" = $1 AND module = 'vac'`, [shopId]);
  expect(row).toEqual([{ enabled: true }]);
  await page.context().close();
});

test("the owner adds three people (no two-login limit); a tech sees the list without the switches", async ({ browser }) => {
  const page = await login(browser, owner);
  for (const t of techs) {
    await page.goto("/settings#people");
    await page.locator("#u-name").fill(t.name);
    await page.locator("#u-email").fill(t.email);
    await page.locator("#u-pw").fill(t.password);
    await page.getByRole("button", { name: "Add person" }).click();
    await expect(page.locator("li", { hasText: t.email })).toBeVisible();
  }
  const people = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "User" WHERE "shopId" = $1 AND active`, [shopId]);
  expect(people[0].n).toBe("4");
  await page.context().close();

  const tech = await login(browser, techs[0]);
  await tech.goto("/settings/features");
  await expect(tech.getByTestId("feature-vac")).toContainText("On");
  await expect(tech.getByText("The shop owner or an admin switches these on and off.")).toBeVisible();
  await expect(tech.getByRole("button", { name: /^Switch (on|off) / })).toHaveCount(0);
  await tech.context().close();
});

test("switched off: Vac Shop's menu item stays read-only, and a vacuum check-in says how to switch it back on", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/features");
  await page.getByRole("button", { name: "Switch off Vac Shop" }).click();
  await expect(page.getByText("Vac Shop switched off")).toBeVisible();
  await expect(page.getByTestId("feature-vac")).toContainText("Off");
  await page.goto("/tickets/new?kind=vacuum");
  await expect(page.getByText(/Vac Shop was switched off on/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings → Features" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create ticket" })).toHaveCount(0);
  await expect(nav(page).getByRole("link", { name: "Vac Shop" }).getByLabel("Read only")).toBeVisible();
  const audit = await sql<{ subjectLabel: string }>(`SELECT "subjectLabel" FROM "AuditEntry" WHERE "shopId" = $1 AND action = 'feature.switch' ORDER BY at`, [shopId]);
  expect(audit.map((a) => a.subjectLabel)).toEqual(["Vac Shop", "Vac Shop"]);
  await page.context().close();
});

test("Settings → Modules leads to Features; Settings says the program is free and links its source code", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/settings/modules");
  await expect(page).toHaveURL(/\/settings\/features$/);
  await page.goto("/settings");
  await expect(page.locator("#about")).toContainText("is free and open source software");
  await expect(page.getByTestId("source-code")).toHaveAttribute("href", /^https:\/\/github\.com\/SiteSentrix\/StitchBench/);
  await expect(page.locator("#features")).toContainText("None switched on yet");
  await page.goto("/settings/account");
  await expect(page.getByTestId("free-line")).toContainText("is free: every feature, for every shop");
  await page.context().close();
});
