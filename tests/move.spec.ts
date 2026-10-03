// Moving a company between two installs (company-move-design.md package move-import, its spec): the owner exports the
// company on one server (Settings → Company → Move this company), the source shows the moving banner and is read-only,
// the StitchBench administrator imports the file on the other server (Companies → Import a company, uploaded in parts),
// and the owner signs in there with the same password and finds the same tickets and photo, same ids.
// The two-server setup of docs/TESTING.md: the same test build twice against one database, :3501 (E2E_BASE_URL, the
// source) and :3500 (E2E_SECOND_URL, the target). One database for both means the source copy is deleted before the
// import (a move never merges). Without E2E_SECOND_URL the spec is skipped.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { OWNER, PNG, RUN, disconnect, insert, login, signIn, sql } from "./helpers";

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
    await expect(target.getByText(/Everyone signs in again here, with the same email and password/)).toBeVisible();
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
