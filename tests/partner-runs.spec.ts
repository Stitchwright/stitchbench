// Partner pickup runs through the UI (scheduling-messaging-design.md 15.9 acceptance 3). Runs only with HUB_URL (a test
// StitchHub this install has joined, never the review's servers); without it the file is skipped, like partners.spec.ts.
// Two companies on this install are linked through the hub by the partners spec's method: the repair shop makes an
// invite code, the sewing shop redeems it; messages then travel install -> hub -> install on "Sync now".
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";

test.describe.configure({ mode: "serial" });
test.skip(!process.env.HUB_URL, "set HUB_URL (a test StitchHub this install has joined)");

const PASSWORD = "e2e-password-1";
const repairCo = `RunRepair ${RUN}`;
const retailCo = `RunRetail ${RUN}`;
const repairOwner = { email: `runrep-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
const retailOwner = { email: `runret-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let admin: Page;
let repairShopId: string;
let retailShopId: string;
let linkId: string;
const made: string[] = [];

async function createCompany(name: string, kind: string, email: string): Promise<string> {
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(name);
  await admin.getByLabel("Kind of shop").selectOption(kind);
  await admin.getByLabel("Owner's name").fill(`${name} Owner`);
  await admin.getByLabel("Owner's email (their login)").fill(email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  const id = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [name]))[0].id;
  made.push(id);
  await sql(`UPDATE "Shop" SET "timeZone" = 'America/New_York' WHERE id = $1`, [id]);
  return id;
}

/** "Sync now" on the Partners page, as a person would, until both sides hold the same run. */
async function syncBoth(a: Page, b: Page) {
  for (const p of [a, b, a]) {
    await p.goto("/partners");
    const btn = p.getByRole("button", { name: /Sync now/ });
    if (await btn.count()) {
      await btn.click();
      await p.waitForTimeout(1500);
    }
  }
}

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  repairShopId = await createCompany(repairCo, "repair", repairOwner.email);
  retailShopId = await createCompany(retailCo, "retail", retailOwner.email);
  await setModule(admin, retailCo, "Scheduling", true);
  // The partnership through the hub: the repair shop's invite code, redeemed by the sewing shop.
  const rep = await login(browser, repairOwner);
  await rep.goto("/partners");
  await rep.getByRole("button", { name: /Invite a (sewing|quilt) shop|Make a code/i }).first().click();
  const code = (await rep.getByText(/stitchpartner:|^[A-Z0-9]{6,}$/).first().innerText()).trim();
  await rep.context().close();
  const ret = await login(browser, retailOwner);
  await ret.goto("/partners");
  await ret.getByLabel(/code/i).first().fill(code);
  await ret.getByRole("button", { name: /Join|Use the code|Add/i }).first().click();
  await expect(ret.getByText(repairCo)).toBeVisible({ timeout: 30_000 });
  await ret.context().close();
  linkId = (await sql<{ id: string }>(`SELECT id FROM "PartnerLink" WHERE "shopId" = $1`, [retailShopId]))[0].id;
  // Both installs are this one: the feature is announced by the sync; set it directly so the first run isn't refused.
  await sql(`UPDATE "PartnerLink" SET features = ARRAY['pickup'] WHERE id = $1`, [linkId]);
  // A machine waiting at the sewing shop, taken in there (the repair shop gets it through the hub).
  await ret.context().close().catch(() => {});
});

test.afterAll(async () => {
  for (const id of made) await sql(`DELETE FROM "Shop" WHERE id = $1`, [id]);
  await disconnect();
  await admin.context().close();
});

test("the sewing shop schedules a run with its waiting machine; the repair shop OKs it and records the pickup", async ({ browser }) => {
  const ret = await login(browser, retailOwner);
  // Take a machine in for the repair shop.
  await ret.goto("/repairs/new");
  await ret.getByLabel("New customer name").fill(`Mary Sender ${RUN}`);
  await ret.getByLabel("Phone", { exact: true }).fill("(212) 555-0151");
  await ret.getByLabel("Brand", { exact: true }).fill("Bernina");
  await ret.getByLabel("Model", { exact: true }).fill("B770");
  await ret.getByRole("button", { name: /Take it in|Create|Save/ }).first().click();
  await expect(ret).toHaveURL(/\/repairs\/[a-z0-9]+/);
  const jobId = ret.url().split("/").pop()!;
  const rep = await login(browser, repairOwner);
  await syncBoth(ret, rep);

  await ret.goto(`/partners/${linkId}/runs/new`);
  await expect(ret.getByRole("heading", { name: /Schedule a run with/ })).toBeVisible();
  await expect(ret.getByRole("checkbox", { name: /Mary S\./ })).toBeChecked();
  await ret.getByRole("button", { name: "Schedule it and tell them" }).click();
  await expect(ret).toHaveURL(/\/runs\/[0-9a-f-]+$/, { timeout: 20_000 });
  const runId = ret.url().split("/").pop()!;
  await expect(ret.getByText("Not OK'd by")).toBeVisible();

  await syncBoth(ret, rep);
  await rep.goto(`/partners/${linkId}/runs/${runId}`);
  await expect(rep.getByRole("heading", { name: /^Run on/ })).toBeVisible();
  await rep.getByRole("button", { name: "OK it" }).click();
  await expect(rep.getByText("OK'd and sent")).toBeVisible();
  await rep.getByRole("button", { name: "Record what the driver took" }).click();
  await expect(rep.getByText("Recorded and sent")).toBeVisible();
  await syncBoth(rep, ret);
  const ticket = await sql<{ status: string }>(`SELECT t.status FROM "Ticket" t JOIN "RepairJob" j ON j."ticketId" = t.id WHERE j.id = $1 AND j."shopId" = $2`, [jobId, repairShopId]);
  expect(ticket[0].status).toBe("IN_TRUCK");
  await ret.goto(`/repairs/${jobId}`);
  await expect(ret.getByText(/Handed to the driver/)).toBeVisible();
  await rep.context().close();
  await ret.context().close();
});
