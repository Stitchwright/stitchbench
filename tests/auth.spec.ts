// Signing in and out, as the throwaway E2E shop's owner: a wrong password, coming back to the page a person was sent
// from, a link that must not sign anyone out, roles and access changed while someone is signed in, the slow-down after
// repeated wrong passwords, and the pages that are closed (/signup, /companies). Round 3 batch C: a browser that signed in
// before (or used a reset link) gets in while the account is flooded with wrong passwords (M44), signing out or changing
// the password ends the other device's session (L42, I22), a tech's replayed shop save, the ticket counter's checks and
// sign-up's refusals (I22). It adds one person to the E2E shop per run (like walkthrough.spec); the other throwaway
// logins and companies are taken away again.
import { createHash, randomBytes } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import { disconnect, expectRefused, insert, login, one, OTHER, remove, shopOf, sql as db, TECH } from "./helpers";

const owner = { email: process.env.E2E_EMAIL ?? "e2e@stitchbench.test", password: process.env.E2E_PASSWORD ?? "e2e-password-1" };
const run = Date.now().toString(36);

test.afterAll(async () => {
  await disconnect();
});

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
  await expect(p2.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();
  expect(new URL(p2.url()).origin).toBe(new URL(baseURL!).origin);
  await other.close();
});

test("opening /api/session-end from a link doesn't sign anyone out", async ({ page }) => {
  await page.goto("/login");
  await signIn(page, owner);
  await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();
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
  await expect(t.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();
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

// src/auth.ts: after 5 wrong tries on an account within 15 minutes, its tries run one at a time, each after a wait that
// doubles from 1 s (up to 30 s), and the right password still works. Per account only: the per-address limit needs
// TRUST_PROXY and a proxy, so it isn't tried here. A throwaway login, so the E2E owner isn't slowed down for other specs.
test("repeated wrong passwords slow that account down, and the right password still works", async ({ page }) => {
  test.setTimeout(240_000);
  const who = { email: `pace.${run}@stitchbench.test`, password: "pace-pass-1234" };
  const { shopId } = await shopOf(owner);
  const { id } = await insert<{ id: string }>("User", { shopId, email: who.email, name: `Pace ${run}`, role: "TECH", passwordHash: await bcrypt.hash(who.password, 10) });
  try {
    /** One try from the sign-in page: how long from the click until the page has answered. */
    const attempt = async (password: string) => {
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill(who.email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      const t0 = Date.now();
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((u) => u.pathname !== "/login" || u.searchParams.has("error"));
      return Date.now() - t0;
    };
    for (let i = 0; i < 5; i++) {
      await attempt("not-the-password");
      await expect(page).toHaveURL(/\/login\?error=1/);
    }
    // The 6th try waits 1 s, the 7th 2 s (the count is what was wrong before it), still refused.
    const sixth = await attempt("not-the-password");
    await expect(page).toHaveURL(/\/login\?error=1/);
    expect(sixth, "6th try waits 1 s").toBeGreaterThanOrEqual(1000);
    const seventh = await attempt("not-the-password");
    await expect(page).toHaveURL(/\/login\?error=1/);
    expect(seventh, "7th try waits 2 s").toBeGreaterThanOrEqual(2000);
    // The right password, after its 4 s wait, gets in.
    const right = await attempt(who.password);
    expect(right, "8th try waits 4 s").toBeGreaterThanOrEqual(4000);
    await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();
  } finally {
    await remove("User", id);
  }
});

// Round 3 W1: an email is unique inside one company, so one address can have a login in two. The right password for one
// signs in straight; a password that fits both asks "Choose a company"; the choice signs in only that login, and the step
// can't be used again or from another browser. (E2E shop and the "other" shop, one throwaway login in each.)
test("the same email in two companies: straight in with one password, a chooser when both fit", async ({ browser, page }) => {
  test.setTimeout(120_000);
  const email = `twin.${run}@stitchbench.test`;
  const { shopId: shopA } = await shopOf(owner);
  const { shopId: shopB } = await shopOf(OTHER);
  const hash = (pw: string) => bcrypt.hash(pw, 10);
  const a = await insert<{ id: string }>("User", { shopId: shopA, email, name: `Twin A ${run}`, role: "TECH", passwordHash: await hash("twin-pass-A-1234") });
  const b = await insert<{ id: string }>("User", { shopId: shopB, email, name: `Twin B ${run}`, role: "TECH", passwordHash: await hash("twin-pass-B-1234") });
  try {
    // Different passwords: each goes straight in, no chooser.
    await page.goto("/login");
    await signIn(page, { email, password: "twin-pass-A-1234" });
    await expect(page.getByText("Choose a company")).toHaveCount(0);
    await page.context().clearCookies();
    // A wrong password: the same message as for any other login.
    await page.goto("/login");
    await fillIn(page, { email, password: "not-the-password" });
    await expect(page.getByText("Email or password is wrong")).toBeVisible();
    // The same password for both: the chooser lists the companies, and the choice signs in that login only.
    await db(`UPDATE "User" SET "passwordHash" = $1 WHERE id = $2`, [await hash("twin-pass-A-1234"), b.id]);
    await page.goto("/login");
    await fillIn(page, { email, password: "twin-pass-A-1234" });
    await expect(page.getByText("Choose a company", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/login\?choose=/);
    const chooser = page.url();
    // From another browser (no cookie) the step is not accepted, and shows no company.
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await p2.goto(chooser);
    await expect(p2.getByText("Choose a company", { exact: true })).toHaveCount(0);
    await expect(p2.getByText("can't be used")).toBeVisible();
    await other.close();
    const buttons = page.locator("form button[name=userId]");
    await expect(buttons).toHaveCount(2);
    await buttons.first().click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    // The chooser's address is used up: going back to it signs in nothing.
    await page.context().clearCookies();
    await page.goto(chooser);
    await expect(page.getByText("Choose a company", { exact: true })).toHaveCount(0);
  } finally {
    await remove("User", a.id);
    await remove("User", b.id);
  }
});

// Sign-up is off unless ALLOW_SIGNUP=true (the hosted installs and the dev .env leave it off); a run against a server
// that has it on skips this.
test("/signup is closed", async ({ page }) => {
  test.skip(process.env.ALLOW_SIGNUP === "true", "ALLOW_SIGNUP is on for this run");
  const r = await page.goto("/signup");
  expect(r?.status()).toBe(404);
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);
});

// Companies is the StitchBench administrator's (PLATFORM_ADMIN_EMAILS): everyone else, whatever their role or company,
// gets a 404; signed out it's the sign-in page.
test("/companies is only for the StitchBench administrator", async ({ page, browser }) => {
  await page.goto("/companies");
  await expect(page).toHaveURL(/\/login\?.*callbackUrl=/);
  for (const who of [TECH, OTHER]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto("/login");
    await signIn(p, who);
    const r = await p.goto("/companies");
    expect(r?.status(), who.email).toBe(404);
    await expect(p.getByRole("link", { name: "Companies" })).toHaveCount(0);
    await ctx.close();
  }
});

/** A throwaway tech in the E2E shop (taken away by the caller). */
async function throwaway(label: string) {
  const who = { email: `${label}.${run}@stitchbench.test`, password: `${label}-pass-1234` };
  const { shopId } = await shopOf(owner);
  const { id } = await insert<{ id: string }>("User", { shopId, email: who.email, name: `${label} ${run}`, role: "TECH", passwordHash: await bcrypt.hash(who.password, 10) });
  return { ...who, id };
}

/**
 * Someone guessing at `email` from elsewhere, through Auth.js' own sign-in route: `n` wrong passwords at once, not waited
 * for. 5 are checked at once, the next 20 queue (1, 2, 4 ... 30 s each, one after another: minutes), the rest are refused.
 */
async function flood(guesser: APIRequestContext, email: string, n = 30) {
  const { csrfToken } = (await (await guesser.get("/api/auth/csrf")).json()) as { csrfToken: string };
  for (let i = 0; i < n; i++) {
    void guesser.post("/api/auth/callback/credentials", { form: { email, password: `wrong-${i}`, csrfToken, callbackUrl: "/" }, maxRedirects: 0, timeout: 0 }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 3000)); // the first 5 answered, the queue full
}

/** A browser that never signed in as `who` doesn't get in while the flood lasts: refused, or still held after 5 s. */
async function heldOut(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await fillIn(page, who);
  await page.waitForTimeout(5000);
  await expect(page).toHaveURL(/\/login/);
}

// src/lib/known-device.ts (round 3 M44): the sign-in page remembers the browser; its tries skip the account's queue.
test("a browser that signed in before gets in while the account is flooded with wrong passwords", async ({ page, browser, playwright, baseURL }) => {
  test.setTimeout(120_000);
  const who = await throwaway("flood");
  const guesser = await playwright.request.newContext({ baseURL });
  const stranger = await browser.newContext();
  try {
    // Earlier: signed in on this browser, then signed out (the browser stays known).
    await page.goto("/login");
    await signIn(page, who);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    await flood(guesser, who.email);
    await heldOut(await stranger.newPage(), who);
    const t0 = Date.now();
    await fillIn(page, who);
    await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - t0, "no wait in the queue").toBeLessThan(10_000);
  } finally {
    await guesser.dispose();
    await stranger.close();
    await remove("User", who.id);
  }
});

// The reset link proves the mailbox: the browser it was used in is known from then on (src/actions/password-reset.ts).
test("the browser a reset link is used in gets in while the account is flooded", async ({ page, browser, playwright, baseURL }) => {
  test.setTimeout(120_000);
  const who = await throwaway("reset");
  const guesser = await playwright.request.newContext({ baseURL });
  const stranger = await browser.newContext();
  try {
    await flood(guesser, who.email);
    // The link "Forgot your password?" mails (only its sha256 is kept), made here so no mail server is needed.
    const token = randomBytes(32).toString("base64url");
    await insert("PasswordReset", { userId: who.id, tokenHash: createHash("sha256").update(token).digest("hex"), kind: "reset", expiresAt: new Date(Date.now() + 3600_000) });
    const fresh = { email: who.email, password: "a-new-password-5678" };
    await page.goto(`/reset?t=${token}`);
    await page.getByLabel("New password (8 characters or more)").fill(fresh.password);
    await page.getByLabel("The same password again").fill(fresh.password);
    await page.getByRole("button", { name: "Save the password" }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);
    await heldOut(await stranger.newPage(), fresh);
    await fillIn(page, fresh);
    await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible({ timeout: 10_000 });
  } finally {
    await guesser.dispose();
    await stranger.close();
    await remove("User", who.id);
  }
});

// Round 3 L42 (decided 30 Sep): Sign out ends that login's sessions everywhere, so a copied cookie stops working too.
test("signing out ends the session on the other device too", async ({ page, browser }) => {
  const who = await throwaway("signout");
  const other = await browser.newContext();
  try {
    await page.goto("/login");
    await signIn(page, who);
    const o = await other.newPage();
    await o.goto("/login");
    await signIn(o, who);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await o.goto("/parts");
    await expect(o).toHaveURL(/\/login\?ended=1/);
  } finally {
    await other.close();
    await remove("User", who.id);
  }
});

test("changing your password signs your other browser out", async ({ page, browser }) => {
  const who = await throwaway("pwchange");
  const other = await browser.newContext();
  try {
    await page.goto("/login");
    await signIn(page, who);
    const o = await other.newPage();
    await o.goto("/login");
    await signIn(o, who);
    await page.goto("/settings");
    await page.getByLabel("Current password").fill(who.password);
    await page.getByLabel("New password (8+ characters)").fill("a-changed-password-1");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Password changed" })).toBeVisible();
    await o.goto("/parts");
    await expect(o).toHaveURL(/\/login\?ended=1/);
  } finally {
    await other.close();
    await remove("User", who.id);
  }
});

// The owner's own "Save shop" request, caught before it leaves, sent again from the tech's browser: refused, nothing saved.
test("a tech replaying the shop settings save is refused", async ({ page, browser }) => {
  const { shopId } = await shopOf(owner);
  const row = () => one(`SELECT name, phone, "taxRatePct", "nextTicketNumber", "laborRateCents" FROM "Shop" WHERE id = $1`, [shopId]);
  await page.goto("/login");
  await signIn(page, owner);
  await page.goto("/settings");
  let caught: { headers: Record<string, string>; body: Buffer } | null = null;
  await page.route("**/settings", async (route) => {
    const r = route.request();
    if (r.method() === "POST" && r.headers()["next-action"]) {
      caught = { headers: r.headers(), body: r.postDataBuffer() ?? Buffer.alloc(0) };
      await route.abort();
    } else await route.continue();
  });
  await page.getByLabel("Shop name").fill(`Taken over ${run}`);
  await page.getByLabel("Sales tax (%)").fill("29");
  await page.getByRole("button", { name: "Save shop" }).click();
  await expect.poll(() => caught !== null).toBe(true);
  const before = await row();
  const t = await login(browser, TECH);
  const { cookie: _c, host: _h, "content-length": _l, ...headers } = caught!.headers;
  void [_c, _h, _l];
  const res = await t.request.post("/settings", { headers, data: caught!.body });
  expect(await res.text()).toContain("Only the shop owner or an admin can change this.");
  expect(await row()).toEqual(before);
  await t.context().close();
});

test("the next ticket number: blank keeps it; a number in use or not a number is refused", async ({ page }) => {
  const { shopId } = await shopOf(owner);
  const counter = async () => (await one<{ n: number }>(`SELECT "nextTicketNumber" AS n FROM "Shop" WHERE id = $1`, [shopId]))!.n;
  const top = (await one<{ top: number | null }>(`SELECT max(number) AS top FROM "Ticket" WHERE "shopId" = $1`, [shopId]))?.top ?? 0;
  const was = await counter();
  await page.goto("/login");
  await signIn(page, owner);
  await page.goto("/settings");
  const field = page.getByLabel("Next ticket number");
  const save = () => page.getByRole("button", { name: "Save shop" }).click();
  if (top > 0) {
    await field.fill(String(top));
    await save();
    await expectRefused(page, `the next ticket number has to be ${top + 1} or more`);
  }
  for (const odd of ["0", "abc", "12.5"]) {
    await field.fill(odd);
    await save();
    await expectRefused(page, "Next ticket number: enter a whole number");
  }
  expect(await counter()).toBe(was);
  await field.fill("");
  await save();
  await expect(page.locator("[data-sonner-toast][data-type='success']").filter({ hasText: "Saved" }).first()).toBeVisible();
  expect(await counter(), "blank keeps the counter").toBe(was);
});

// Only against a server with ALLOW_SIGNUP=true (and no SETUP_TOKEN); set ALLOW_SIGNUP=true for the run too.
// E2E_RESERVED_EMAIL: an address in that server's PLATFORM_ADMIN_EMAILS that has no login.
test("sign-up refuses the administrator's address, and a partner code needs the community hub", async ({ browser }) => {
  test.skip(process.env.ALLOW_SIGNUP !== "true", "sign-up is off for this run");
  const reserved = process.env.E2E_RESERVED_EMAIL;
  const hub = await one<{ joined: boolean }>(`SELECT (url IS NOT NULL AND "installKey" IS NOT NULL) AS joined FROM "HubState" WHERE id = 1`);
  test.skip(!reserved && !!hub?.joined, "nothing to try: no E2E_RESERVED_EMAIL, and this install is on a hub");
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const fill = async (o: { shop: string; email: string; code?: string }) => {
    await p.goto("/signup");
    await p.getByLabel("Shop name").fill(o.shop);
    await p.getByLabel("Your name").fill("Sign-up check");
    await p.getByLabel("Email", { exact: true }).fill(o.email);
    await p.getByLabel("Password (8+ characters)").fill("signup-pass-1234");
    await p.locator("#kind").selectOption("retail");
    if (o.code) await p.getByLabel(/Partner code/).fill(o.code);
    await p.getByRole("button", { name: "Create shop" }).click();
  };
  const made = (name: string) => one<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [name]);
  try {
    if (reserved) {
      await fill({ shop: `Reserved ${run}`, email: reserved });
      await expect(p).toHaveURL(/\/signup\?error=reserved/);
      await expect(p.getByText("That email is reserved")).toBeVisible();
      expect(await made(`Reserved ${run}`)).toBeNull();
    }
    // On an install that isn't on a hub, a partner code would join it to one: the new shop is made, the code isn't used.
    if (!hub?.joined) {
      await fill({ shop: `Partner code ${run}`, email: `signup.${run}@stitchbench.test`, code: "7KQP-M2XH-9TRD" });
      await expect(p).toHaveURL(/\/partners\?error=need-hub/);
      expect(await one(`SELECT (url IS NOT NULL AND "installKey" IS NOT NULL) AS joined FROM "HubState" WHERE id = 1`)).toEqual(hub);
    }
  } finally {
    const shop = await made(`Partner code ${run}`);
    if (shop) await remove("Shop", shop.id);
    await ctx.close();
  }
});
