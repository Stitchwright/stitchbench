// Moving a company between two installs (company-move-design.md package move-import, its spec): the owner exports the
// company on one server (Settings → Company → Move this company), the source shows the moving banner and is read-only,
// the StitchBench administrator imports the file on the other server (Companies → Import a company, uploaded in parts),
// and the owner signs in there with the same password and finds the same tickets and photo, same ids.
// The two-server setup of docs/TESTING.md: the same test build twice against one database, :3501 (E2E_BASE_URL, the
// source) and :3500 (E2E_SECOND_URL, the target). One database for both means the source copy is deleted before the
// import (a move never merges). Without E2E_SECOND_URL the spec is skipped.
//
// The partner half (package move-hub): a repair shop and its partner sewing shop on this install (E2E_BASE_URL, joined
// to a test StitchHub: HUB_URL, as partners.spec.ts needs); the sewing shop moves to a third server on a database of
// its own that is on no hub yet (E2E_THIRD_URL, with its StitchBench administrator E2E_THIRD_EMAIL / E2E_THIRD_PASSWORD
// in its PLATFORM_ADMIN_EMAILS). The import joins that server to the hub and re-points the company; a note the repair
// shop sends afterwards reaches the third server and not the old copy; the old copy learns at its next hub sync, shows
// the moved notice and refuses new work. Without those variables it is skipped.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { OWNER, PNG, RUN, disconnect, expectRefused, insert, login, signIn, sql, type Login } from "./helpers";

const PASSWORD = "e2e-password-1";
const SECOND = process.env.E2E_SECOND_URL;
const company = `Move ${RUN}`;
const owner = { email: `move-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };

/** The company and everything of its own, as removeCompany does (tickets first: a machine can't go while a ticket names it). */
async function deleteCompany(shopId: string) {
  await sql(`DELETE FROM "Ticket" WHERE "shopId" = $1`, [shopId]);
  await sql(`DELETE FROM "StockUnit" WHERE "shopId" = $1`, [shopId]);
  await sql(`DELETE FROM "PartnerSeen" WHERE "shopId" = $1`, [shopId]);
  await sql(`DELETE FROM "PartnerFailure" WHERE "shopId" = $1`, [shopId]);
  await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
}

test("a company exported on one server is imported on the other, same tickets, same photo", async ({ browser }) => {
  test.skip(!SECOND, "needs E2E_SECOND_URL (a second server on the same database)");
  test.setTimeout(300_000);
  // The administrator makes the company on the source.
  const admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("repair");
  await admin.getByLabel("Owner's name").fill("Move Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  await admin.context().close();
  const shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  const file = path.join(os.tmpdir(), `move-spec-${RUN}.stitchmove.ndjson.gz`);
  try {
    const customer = await insert<{ id: string }>("Customer", { shopId, name: `Mover ${RUN}` });
    const machine = await insert<{ id: string }>("Machine", { shopId, customerId: customer.id, brand: "Bernina", model: "770 QE", modelKey: "770qe" });
    const ticket = await insert<{ id: string }>("Ticket", {
      shopId,
      number: 4242,
      machineId: machine.id,
      customerId: customer.id,
      status: "ON_BENCH",
      problem: "Move test",
      accessories: [],
      accessoriesReturned: [],
      updatedAt: new Date(),
    });
    const photo = await insert<{ id: string }>("MachinePhoto", { shopId, machineId: machine.id, ticketId: ticket.id, mime: "image/png", data: PNG, caption: "Move test photo" });

    // The owner on the source: the ticket and the photo, then the move.
    const src = await login(browser, owner);
    await src.goto("/tickets");
    await expect(src.getByText(`Mover ${RUN}`).first()).toBeVisible();
    const before = await src.request.get(`/api/photos/${photo.id}`);
    expect(before.status()).toBe(200);
    expect(Buffer.from(await before.body()).equals(PNG)).toBe(true);
    await src.goto("/settings#move");
    await src.getByLabel(/Where is it going/).fill("the second server");
    await src.getByLabel(/I understand the file holds everything/).check();
    await src.getByRole("button", { name: "Prepare the move file" }).click();
    await expect(src.getByText(/This company is moving to the second server; it is read-only here since/).first()).toBeVisible();
    const [download] = await Promise.all([src.waitForEvent("download"), src.getByRole("link", { name: "Download the move file" }).click()]);
    await download.saveAs(file);
    expect(fs.statSync(file).size).toBeGreaterThan(100);
    // The source is read-only and says so on every page.
    await src.goto("/tickets");
    await expect(src.getByText(/This company is moving to the second server/).first()).toBeVisible();
    await src.context().close();

    // One database for both servers: the source copy goes before the import (a move never merges).
    await deleteCompany(shopId);

    // The administrator on the target: Companies → Import a company.
    const ctx = await browser.newContext({ baseURL: SECOND });
    const target = await ctx.newPage();
    await signIn(target, OWNER);
    await target.goto("/companies");
    await target.getByLabel(/Move file/).setInputFiles(file);
    await expect(target.getByText(new RegExp(`${company} is on this install now`)).first()).toBeVisible({ timeout: 120_000 });
    await expect(target.getByText(/Everyone signs in again here, with the same email and password/).first()).toBeVisible();
    await expect(target.getByText(/moved in/).first()).toBeVisible();
    await ctx.close();

    // The owner signs in on the target with the same password: the same ticket, the same photo, the same ids.
    const octx = await browser.newContext({ baseURL: SECOND });
    const page = await octx.newPage();
    await signIn(page, owner);
    await page.goto("/tickets");
    await expect(page.getByText(`Mover ${RUN}`).first()).toBeVisible();
    await page.goto(`/tickets/${ticket.id}`);
    await expect(page.locator(`img[src="/api/photos/${photo.id}"]`).first()).toBeVisible();
    const after = await page.request.get(`/api/photos/${photo.id}`);
    expect(after.status()).toBe(200);
    expect(Buffer.from(await after.body()).equals(PNG)).toBe(true);
    // Not moving here: the copy that arrived isn't frozen.
    await expect(page.getByText(/This company is moving/)).toHaveCount(0);
    await octx.close();
    const rows = await sql<{ movedInAt: Date | null; movingAt: Date | null }>(`SELECT "movedInAt", "movingAt" FROM "Shop" WHERE id = $1`, [shopId]);
    expect(rows[0].movedInAt).not.toBeNull();
    expect(rows[0].movingAt).toBeNull();
  } finally {
    await deleteCompany(shopId).catch(() => {});
    fs.rmSync(file, { force: true });
    await disconnect();
  }
});

const THIRD = process.env.E2E_THIRD_URL;
const thirdAdmin: Login = { email: process.env.E2E_THIRD_EMAIL ?? "", password: process.env.E2E_THIRD_PASSWORD ?? "" };

async function syncPartners(page: Page) {
  for (let i = 0; i < 2; i++) {
    await page.goto("/partners");
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Synced with partners")).toBeVisible();
  }
}

test("a partner sewing shop moves to another install: the hub re-points it, partner messages follow it, the old copy hears", async ({ browser }) => {
  test.skip(!THIRD || !thirdAdmin.email || !process.env.HUB_URL, "needs E2E_THIRD_URL (+ E2E_THIRD_EMAIL / E2E_THIRD_PASSWORD) and HUB_URL (this install on a test hub)");
  test.setTimeout(600_000);
  const sewing = { shop: `Move Quilts ${RUN}`, name: "Mo Quilter", email: `mo-${RUN.toLowerCase()}@quilt.test`, password: "quilt-pass-1" };
  const file = path.join(os.tmpdir(), `move-partner-${RUN}.stitchmove.ndjson.gz`);
  let shopId: string | null = null;
  try {
    // The repair shop sets up its partner sewing shop on this install; both accept the agreement.
    const r = await login(browser, OWNER);
    await r.goto("/partners");
    await r.locator("#ss-shop").fill(sewing.shop);
    await r.locator("#ss-name").fill(sewing.name);
    await r.locator("#ss-email").fill(sewing.email);
    await r.locator("#ss-pw").fill(sewing.password);
    await r.getByRole("button", { name: "Set up their shop" }).click();
    await expect(r.getByText("Set up and partnered")).toBeVisible();
    await r.reload();
    await r.getByRole("link", { name: sewing.shop }).click();
    await r.waitForURL(/\/partners\/[^/]+$/);
    const linkId = new URL(r.url()).pathname.split("/").pop()!;
    await r.goto(`/partners/${linkId}/agreement`);
    await r.locator("#accept-name").fill("Bruce Tester");
    await r.getByLabel(/I've read these terms/).check();
    await r.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(r.getByText("Accepted", { exact: true })).toBeVisible();
    await syncPartners(r);
    shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [sewing.shop]))[0].id;

    const s = await login(browser, sewing);
    await s.goto("/partners");
    await s.getByRole("link", { name: /E2E Test Shop/ }).click();
    await s.getByRole("link", { name: "Read and accept the agreement" }).click();
    await s.locator("#accept-name").fill(sewing.name);
    await s.getByLabel(/I've read these terms/).check();
    await s.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(s.getByText("Both shops accepted version 1.")).toBeVisible();
    // A machine taken in for the repair shop.
    await s.goto("/repairs/new");
    await s.locator("#customerName").fill("Mary Mover");
    await s.locator("#customerPhone").fill("555-0177");
    await s.locator("#brand").fill("Janome");
    await s.locator("#model").fill("MC6700P");
    await s.locator("#problem").fill("Skipping stitches");
    await s.getByRole("button", { name: "Take it in and make the claim tag" }).click();
    await expect(s.getByRole("heading", { name: /Tag 101/ })).toBeVisible();
    const jobPath = new URL(s.url()).pathname;
    await syncPartners(s);
    await r.goto(`/partners/${linkId}`);
    await r.locator("tr", { hasText: "MC6700P" }).getByRole("link", { name: /^#/ }).click();
    const ticketPath = new URL(r.url()).pathname;

    // The sewing shop's owner moves it: the file carries the hub's move token.
    await s.goto("/settings#move");
    await s.getByLabel(/Where is it going/).fill("the third server");
    await s.getByLabel(/I understand the file holds everything/).check();
    await s.getByRole("button", { name: "Prepare the move file" }).click();
    await expect(s.getByText(/StitchHub: the file carries a move token/)).toBeVisible();
    const [download] = await Promise.all([s.waitForEvent("download"), s.getByRole("link", { name: "Download the move file" }).click()]);
    await download.saveAs(file);
    await s.context().close();

    // The third server (on no hub yet) imports it: it joins the hub, which has the company there now.
    const tctx = await browser.newContext({ baseURL: THIRD });
    const t = await tctx.newPage();
    await signIn(t, thirdAdmin);
    await t.goto("/companies");
    await t.getByLabel(/Move file/).setInputFiles(file);
    await expect(t.getByText(new RegExp(`${sewing.shop} is on this install now`)).first()).toBeVisible({ timeout: 120_000 });
    await expect(t.getByTestId("move-hub-step")).toContainText(/has the company here now, and this install joined it/);
    await tctx.close();

    // After the move the repair shop sends a note on the job: it reaches the third server, not the old copy.
    await r.goto(ticketPath);
    await r.locator("#repairNote").fill(`After the move ${RUN}`);
    await r.getByRole("button", { name: "Send note" }).click();
    await expect(r.getByText("The shop will see it")).toBeVisible();
    await syncPartners(r);
    const nctx = await browser.newContext({ baseURL: THIRD });
    const n = await nctx.newPage();
    await signIn(n, sewing);
    await syncPartners(n);
    await n.goto(jobPath);
    await expect(n.getByText(new RegExp(`After the move ${RUN}`)).first()).toBeVisible();
    await expect(n.getByTestId("moved-bar")).toHaveCount(0);
    await nctx.close();

    // The old copy hears it at this install's next hub sync: the moved notice, read-only, and the note never came here.
    await r.goto("/settings");
    await r.getByRole("button", { name: "Sync now" }).first().click();
    await expect(r.getByText("Synced with the hub")).toBeVisible();
    const old = await login(browser, sewing);
    await old.goto(jobPath);
    await expect(old.getByTestId("moved-bar")).toContainText(/This company moved to .+ on .+\. This copy is read-only; delete it after/);
    await expect(old.getByText(new RegExp(`After the move ${RUN}`))).toHaveCount(0);
    await old.goto("/repairs/new");
    await old.locator("#customerName").fill("Late Customer");
    await old.locator("#customerPhone").fill("555-0178");
    await old.locator("#brand").fill("Janome");
    await old.locator("#model").fill("HD3000");
    await old.locator("#problem").fill("Thread jams");
    await old.getByRole("button", { name: "Take it in and make the claim tag" }).click();
    await expectRefused(old, /This company moved to/);
    await old.context().close();
    await r.context().close();
    const row = (await sql<{ movedOutAt: Date | null; movingAt: Date | null }>(`SELECT "movedOutAt", "movingAt" FROM "Shop" WHERE id = $1`, [shopId]))[0];
    expect(row.movedOutAt).not.toBeNull();
    expect(row.movingAt).not.toBeNull();
  } finally {
    // The old copy here (the third server's copy is that server's to keep or remove).
    if (shopId) await deleteCompany(shopId).catch(() => {});
    fs.rmSync(file, { force: true });
    await disconnect();
  }
});
