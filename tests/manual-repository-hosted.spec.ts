// The manual repository on a hosted install (docs/plans/manual-repository-design.md 5.4, package repo-hosted): no library on
// the server, so the browser reads the file from the tech's folder (the folder-input fallback, filled with setInputFiles),
// checks and hashes it, PUTs it to R2 itself and downloads from R2 itself. Offer, approve through the hub's admin API,
// sync, download.
//
// Needs what manual-repository.spec.ts needs, with the app under test running WITHOUT LIBRARY_DIR (a hosted-style server) and
// FETCH_ALLOW_HOSTS=<the R2 mock's host:port> (the server accepts a PUT address only on R2's own host, or one named there).
// R2's CORS rule for the app's origin (INSTALL.md) is stood in for here by routing the browser's calls to the R2 mock
// (R2_MOCK_URL, the mock the hub's R2_ENDPOINT points at) and answering the preflight, as the bucket's CORS policy does.
//   HUB_URL=... HUB_JOIN_KEY=... HUB_ADMIN_TOKEN=... HUB_DATABASE_URL=... R2_MOCK_URL=http://127.0.0.1:PORT npx playwright test manual-repository-hosted
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { test, expect, type Page } from "@playwright/test";
import { one, OWNER } from "./helpers";

const hub = process.env.HUB_URL;
const joinKey = process.env.HUB_JOIN_KEY;
const admin = process.env.HUB_ADMIN_TOKEN;
const hubDb = process.env.HUB_DATABASE_URL;
const r2 = process.env.R2_MOCK_URL;
const run = Date.now().toString(36);
const brand = `Host${run}`;

test.skip(!hub || !joinKey || !admin || !hubDb || !r2, "set HUB_URL, HUB_JOIN_KEY, HUB_ADMIN_TOKEN, HUB_DATABASE_URL and R2_MOCK_URL to test the hosted manual repository");
test.setTimeout(300_000);

type Waiting = { fileId: string; offered?: { brand?: string } };
type Answer = { waiting: Waiting[]; fileName: string; manualId: string; id: string };
const api = async (method: string, route: string, body?: unknown) => {
  const r = await fetch(`${hub}${route}`, { method, headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(r.ok, `${method} ${route}: ${r.status}`).toBe(true);
  return (await r.json()) as Answer;
};

async function syncNow(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Update from StitchHub" }).click();
  await expect(page.getByText("Synced with the hub")).toBeVisible({ timeout: 180_000 });
}

test("hosted manual repository: offer from the browser's folder, approve, download", async ({ page, request }) => {
  // A hosted-style server has no library on it.
  const status = await request.get("/api/library/status");
  test.skip((await status.json()).enabled === true, "the app under test has a LIBRARY_DIR: this spec is for a hosted-style server");

  // The bucket's CORS rule for this site, as INSTALL.md describes it.
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,PUT,OPTIONS", "access-control-allow-headers": "*" };
  await page.route(`${r2}/**`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await route.fetch();
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  // Without a File System Access API the page offers the folder input (what Firefox and Safari get).
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();

  await page.goto("/settings");
  const join = page.getByRole("button", { name: "Join", exact: true });
  if (await join.count()) {
    const invite = { v: 1, url: hub, joinKey, name: "Test hub" };
    await page.locator("#hub-invite").fill("stitchhub:" + Buffer.from(JSON.stringify(invite)).toString("base64url"));
    await join.click();
  }
  await expect(page.getByText(/Connected to/)).toBeVisible({ timeout: 180_000 });
  await syncNow(page);
  const shopId = (await one<{ shopId: string }>(`SELECT "shopId" FROM "User" WHERE email = $1`, [OWNER.email]))!.shopId;
  const hdb = new pg.Pool({ connectionString: hubDb, max: 1 });
  try {
    const accountId = `acc${crypto.randomBytes(8).toString("hex")}`;
    await hdb.query(`INSERT INTO accounts (id, email, verified_at, disabled) VALUES ($1, $2, now(), false)`, [accountId, `repo-host-${run}@stitchhub.test`]);
    expect((await hdb.query(`UPDATE shops SET account_id = $1 WHERE shop_ref = $2`, [accountId, shopId])).rowCount).toBeGreaterThan(0);
  } finally {
    await hdb.end();
  }

  // The tech's folder: a manuals folder with one PDF, picked through the folder input.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manuals-"));
  const folder = path.join(dir, "MyManuals");
  fs.mkdirSync(folder);
  const fileName = `${brand}_H1_ServiceManual_2018.pdf`;
  const bytes = Buffer.from(`%PDF-1.4\n% hosted repository spec ${run}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
  fs.writeFileSync(path.join(folder, fileName), bytes);
  await page.goto("/manuals");
  await page.locator("#pick-folder").setInputFiles(folder);
  await expect(page.getByText(/^1 PDFs · indexed/)).toBeVisible();
  await page.getByLabel("Find a manual").fill(brand);
  const row = page.locator("li", { hasText: fileName });
  await expect(row).toBeVisible();

  // Offer: nothing is sent until the statement is ticked for this file and Offer is pressed.
  await row.getByRole("button", { name: "Offer to the repository" }).click();
  await row.getByLabel("Category").fill("Sewing");
  await expect(row.getByLabel("Brand")).toHaveValue(brand);
  expect((await api("GET", "/v1/admin/repository")).waiting.filter((w) => w.offered?.brand === brand)).toHaveLength(0);
  await row.getByRole("checkbox").check();
  await row.getByRole("button", { name: "Offer this manual" }).click();
  await expect(page.getByText(/Sent\. It waits for the hub owner's review/)).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: "test-results/repository-hosted-offered.png" });

  // Approved on the hub, then synced: the repository row has a Download button that saves from R2 in the browser.
  const waiting = (await api("GET", "/v1/admin/repository")).waiting.find((w) => w.offered?.brand === brand);
  expect(waiting, "the file waits for review on the hub").toBeTruthy();
  const approved = await api("POST", `/v1/admin/repository/files/${waiting!.fileId}/approve`, {});
  await syncNow(page);
  await page.goto("/links");
  await expect(page.locator("li", { hasText: `${brand} H1` }).getByText("Waiting for review")).toHaveCount(0);
  await page.goto(`/links?q=${brand}`);
  const repoRow = page.locator("li", { hasText: "In the repository" }).filter({ hasText: brand }).filter({ has: page.getByRole("button", { name: "Download" }) }).first();
  await expect(repoRow).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), repoRow.getByRole("button", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toBe(approved.fileName);
  const saved = fs.readFileSync((await download.path())!);
  expect(crypto.createHash("sha256").update(saved).digest("hex")).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
  await page.screenshot({ path: "test-results/repository-hosted-downloaded.png" });
});
