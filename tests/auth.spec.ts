// Signing in and out, as the throwaway E2E shop's owner: a wrong password, coming back to the page a person was sent
// from, a link that must not sign anyone out, and roles and access changed while someone is signed in. It adds one
// person to the E2E shop per run (like walkthrough.spec).
import { test, expect, type Page } from "@playwright/test";

const owner = { email: process.env.E2E_EMAIL ?? "e2e@stitchbench.test", password: process.env.E2E_PASSWORD ?? "e2e-password-1" };
const run = Date.now().toString(36);

async function fillIn(page: Page, who: { email: string; password: string }) {
  await page.getByLabel("Email", { exact: true }).fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** From the sign-in page: fill it in and wait until the page has moved on. */
async function signIn(page: Page, who: { email: string; password: string }) {
  await fillIn(page, who);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("a wrong password is refused with a message", async ({ page }) => {
  await page.goto("/login");
  await fillIn(page, { email: owner.email, password: "not-the-password" });
  await expect(page.getByText("Email or password is wrong")).toBeVisible();
  await expect(page).toHaveURL(/\/login\?error=1/);
});

test("signing in goes back to the page that was asked for, and never to another site", async ({ page, browser, baseURL }) => {
  await page.goto("/parts");
  await expect(page).toHaveURL(/\/login\?.*callbackUrl=/);
  await signIn(page, owner);
  await expect(page).toHaveURL(/\/parts$/);

  // A callbackUrl that names another site (from a crafted link) is dropped: the dashboard, on this site.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(`/login?callbackUrl=${encodeURIComponent("https://evil.example/")}`);
  await signIn(p2, owner);
  await expect(p2.getByRole("heading", { name: "Bench" })).toBeVisible();
  expect(new URL(p2.url()).origin).toBe(new URL(baseURL!).origin);
  await other.close();
});

test("opening /api/session-end from a link doesn't sign anyone out", async ({ page }) => {
  await page.goto("/login");
  await signIn(page, owner);
  await expect(page.getByRole("heading", { name: "Bench" })).toBeVisible();
  await page.goto("/api/session-end"); // what a link on another site would do
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto("/parts");
  await expect(page).toHaveURL(/\/parts$/);
});

test("a tech has no People; a role change and removed access end the session where the person is", async ({ page, browser }) => {
  const tech = { name: `Tech ${run}`, email: `tech.${run}@stitchbench.test`, password: "tech-pass-1234" };
  await page.goto("/login");
  await signIn(page, owner);
  await page.goto("/settings");
  await page.locator("#u-name").fill(tech.name);
  await page.locator("#u-email").fill(tech.email);
  await page.locator("#u-pw").fill(tech.password);
  await page.getByRole("button", { name: "Add person" }).click();
  const row = () => page.locator("li", { hasText: tech.email });
  await expect(row()).toBeVisible();

  // The new person, on another device, is a tech: Settings offers no People.
  const device = await browser.newContext();
  const t = await device.newPage();
  await t.goto("/login");
  await signIn(t, tech);
  await expect(t.getByRole("heading", { name: "Bench" })).toBeVisible();
  await t.goto("/settings");
  await expect(t.getByRole("button", { name: "Add person" })).toHaveCount(0);

  // Made an admin, they have to sign in again, and then People is there.
  await row().getByText("Change role").click();
  await row().getByLabel(`Role for ${tech.name}`).selectOption("ADMIN");
  await row().getByRole("button", { name: "Set role" }).click();
  await expect(row().locator(".pill", { hasText: /^admin$/ })).toBeVisible();
  await t.goto("/settings");
  await expect(t).toHaveURL(/\/login\?ended=1/);
  await signIn(t, tech);
  await t.goto("/settings");
  await expect(t.getByRole("button", { name: "Add person" })).toBeVisible();

  // Access removed: their next page sends them to sign in, with the reason.
  await row().getByRole("button", { name: "Remove access" }).click();
  await expect(row().getByRole("button", { name: "Restore access" })).toBeVisible();
  await t.goto("/parts");
  await expect(t).toHaveURL(/\/login\?ended=1/);
  await expect(t.getByText("Please sign in again")).toBeVisible();
  await device.close();
});
