// Settings → Account end to end (hub-accounts-billing-design.md section 7, package 2 base-license): a company's owner
// creates the StitchHub account from the program (door 1), sets the password from the hub's email, and the page then
// shows the account verified and the standing the hub gave (a free trial with its last day); a second company on the
// same install shows a link code (door 2), typed in on the hub under "Connect a shop".
//   Runs on a TEST BUILD (the :3501 server of docs/TESTING.md) whose install is joined to the local test hub
//   (scripts/local-test/start_hub.bat on :3200, the stitchhub repo on a branch with accounts). The hub runs with
//   MAIL_DEV_LOG=true (start_hub.bat sets it) and no SMTP_URL, so the set-password link is printed to its log file,
//   scripts/local-test/.run/hub.log (HUB_LOG overrides the path; HUB_URL the hub's address), where this spec reads it.
//   Skips when the install isn't on that hub or the log isn't there. Written against the code: expect label slips.
//   E2E_KEEP=1 leaves the two companies behind (the hub keeps its account and shop rows either way: they are the test
//   hub's, named with the run).
import fs from "node:fs";
import path from "node:path";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, one, sql } from "./helpers";
import { eventually } from "./helpers/messaging";

test.describe.configure({ mode: "serial" });

const HUB = (process.env.HUB_URL ?? "http://localhost:3200").replace(/\/+$/, "");
const HUB_LOG = process.env.HUB_LOG ?? path.join(__dirname, "..", "scripts", "local-test", ".run", "hub.log");
const PASSWORD = "e2e-password-1";
const HUB_PASSWORD = `Hub-${RUN}-pass-9`;
const companyA = `Acct ${RUN}`;
const companyB = `Acct ${RUN} Two`;
const ownerA = { email: `acct-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const ownerB = { email: `acct-${RUN.toLowerCase()}-two@stitchbench.test`, password: PASSWORD };
let admin: Page;
let hub: BrowserContext; // the owner's browser on the hub, signed in once the password is set
const made: string[] = [];

/** The set-password link the hub printed for `email` after byte `from` of its log (MAIL_DEV_LOG), on the hub's address. */
function setPasswordLink(email: string, from: number): string | null {
  const log = fs.readFileSync(HUB_LOG, "utf8").slice(from);
  const at = log.indexOf(`mail (not sent, MAIL_DEV_LOG): to ${email}`);
  if (at < 0) return null;
  const m = /https?:\/\/\S+\/account\/set-password\?t=([A-Za-z0-9_-]+)/.exec(log.slice(at));
  if (!m) return null;
  // The hub names itself by HUB_URL or its port; the browser here reaches it by HUB.
  const u = new URL(m[0]);
  return `${HUB}${u.pathname}${u.search}`;
}

async function createCompany(name: string, owner: { email: string }) {
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(name);
  await admin.getByLabel("Kind of shop").selectOption("both");
  await admin.getByLabel("Owner's name").fill("Acct Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  const id = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [name]))[0].id;
  made.push(id);
  return id;
}

test.beforeAll(async ({ browser }) => {
  const state = await one<{ url: string | null; installKey: string | null; scope: string }>(`SELECT url, "installKey", scope FROM "HubState" WHERE id = 1`);
  const joined = !!state?.url && !!state.installKey && state.url.replace(/\/+$/, "") === HUB;
  test.skip(!joined, `the install under test isn't joined to the test hub at ${HUB} (Settings → Community hub → Join with start_hub.bat's invite)`);
  test.skip(!fs.existsSync(HUB_LOG), `no hub log at ${HUB_LOG}: start the hub with scripts/local-test/start_hub.bat (MAIL_DEV_LOG=true)`);
  const up = await fetch(`${HUB}/health`).then(
    (r) => r.ok,
    () => false,
  );
  test.skip(!up, `the test hub at ${HUB} isn't answering`);
  admin = await login(browser, OWNER);
  await createCompany(companyA, ownerA);
  await createCompany(companyB, ownerB);
  hub = await browser.newContext();
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin?.context().close();
  await hub?.close();
});

test("door 1: the owner creates the account, sets the password from the hub's email, and the page shows verified and the trial", async ({ browser }) => {
  const page = await login(browser, ownerA);
  await page.goto("/settings/account");
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByText("Create your StitchHub account")).toBeVisible();
  await expect(page.getByTestId("company-id")).toHaveText(made[0]);
  // Not connected to any account yet: the program works without one.
  await expect(page.getByText(/works: no key is needed yet/)).toBeVisible();

  const logFrom = fs.statSync(HUB_LOG).size;
  await expect(page.getByLabel("Your email")).toHaveValue(ownerA.email);
  await page.getByRole("checkbox", { name: /I accept the/ }).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Account started: check your email")).toBeVisible();
  await expect(page.getByText("waiting for the email")).toBeVisible();
  await expect(page.getByText(`Account: ${ownerA.email}`)).toBeVisible();
  const shopA = await one<{ hubAccountEmail: string | null; hubAccountVerified: boolean; termsVersion: string | null }>(
    `SELECT "hubAccountEmail", "hubAccountVerified", "termsVersion" FROM "Shop" WHERE id = $1`,
    [made[0]],
  );
  expect(shopA).toMatchObject({ hubAccountEmail: ownerA.email, hubAccountVerified: false });
  expect(shopA?.termsVersion).toBeTruthy();

  // The hub printed the email instead of sending it: the link sets the password and verifies the address.
  const link = await eventually(async () => setPasswordLink(ownerA.email, logFrom));
  const hp = await hub.newPage();
  await hp.goto(link);
  // The hub's one page holds every form (sign-up, settings) with the same labels: the set-password form's own fields.
  await hp.locator("#spPassword").fill(HUB_PASSWORD);
  await hp.locator("#spPassword2").fill(HUB_PASSWORD);
  await hp.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(hp.getByText("Your password is saved")).toBeVisible();
  await expect(hp).toHaveURL(/\/account\/shops$/);
  await expect(hp.locator("#shopRows")).toContainText(companyA);
  await hp.close();

  // The program learns of it at the next sync, or now: Check again claims this company and takes the hub's answer.
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Checked with StitchHub")).toBeVisible();
  await expect(page.getByText("verified", { exact: true })).toBeVisible();
  await expect(page.getByText(/StitchHub says:/)).toContainText(/Free trial/);
  await expect(page.getByText(/StitchHub says:/)).toContainText(/through [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  const after = await one<{ hubAccountVerified: boolean; hubStanding: string | null; hubStandingUntil: string | null }>(
    `SELECT "hubAccountVerified", "hubStanding", "hubStandingUntil" FROM "Shop" WHERE id = $1`,
    [made[0]],
  );
  expect(after).toMatchObject({ hubAccountVerified: true, hubStanding: "trial" });
  expect(after?.hubStandingUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Today's hub signs no key yet: the program itself stays as it was (off = working).
  await expect(page.getByText(/works: no key is needed yet/)).toBeVisible();
  await page.context().close();
});

test("door 2: a second company shows a link code; typed in on the hub it joins the same account", async ({ browser }) => {
  const page = await login(browser, ownerB);
  await page.goto("/settings/account");
  await expect(page.getByText("I already have an account")).toBeVisible();
  await page.getByRole("button", { name: "Show a link code" }).click();
  await expect(page).toHaveURL(/\/settings\/account\?code=/);
  const code = page.getByTestId("link-code");
  await expect(code).toBeVisible();
  await expect(code).toHaveText(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  await expect(page.getByText(/type this code under/)).toContainText("Connect a shop");
  const text = (await code.textContent())!.trim();

  // On the hub, signed in from door 1: the code connects company B to the same account.
  const hp = await hub.newPage();
  await hp.goto(`${HUB}/account/shops`);
  await expect(hp.locator("#shopRows")).toContainText(companyA);
  await hp.locator("#code").fill(text);
  await hp.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(hp.locator("#shopRows")).toContainText(companyB);
  await hp.close();

  // Back in the program, the second company sees the account and its own trial.
  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Checked with StitchHub")).toBeVisible();
  await expect(page.getByText(`Account: ${ownerA.email}`)).toBeVisible();
  await expect(page.getByText("verified", { exact: true })).toBeVisible();
  await expect(page.getByText(/StitchHub says:/)).toContainText(/Free trial/);
  const b = await one<{ hubAccountEmail: string | null; hubAccountVerified: boolean; hubStanding: string | null }>(
    `SELECT "hubAccountEmail", "hubAccountVerified", "hubStanding" FROM "Shop" WHERE id = $1`,
    [made[1]],
  );
  expect(b).toMatchObject({ hubAccountEmail: ownerA.email, hubAccountVerified: true, hubStanding: "trial" });
  // Company A's row is untouched by B's connection.
  const a = await one<{ hubAccountEmail: string | null; hubStanding: string | null }>(`SELECT "hubAccountEmail", "hubStanding" FROM "Shop" WHERE id = $1`, [made[0]]);
  expect(a).toMatchObject({ hubAccountEmail: ownerA.email, hubStanding: "trial" });
  await page.context().close();
});
