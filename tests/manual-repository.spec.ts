// The manual repository on the shop PC (docs/plans/manual-repository-design.md section 7, package repo-program): offer an
// _inbox PDF from Manual links, approve it through the hub's admin API, sync, "Download everything", the file on disk and
// "in the library"; then a copyright notice through the admin API, sync, and the model page says it was removed.
//
// Needs, all on this computer (scripts/local-test/README.md; run it alone, one Chrome):
//   - a test hub (stitchhub branch manual-repo) with REPO_UPLOADS=on, R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
//     R2_BUCKET and R2_ENDPOINT pointing at its test/r2-mock.mjs (startR2Mock), and its own scratch database
//   - the app under test with LIBRARY_DIR (TESTLIB), FETCH_ALLOW_HOSTS=<the R2 mock's host:port> and
//     MANUAL_DOWNLOAD_PAUSE_SECONDS=0, joined to that hub (this spec joins it when it isn't)
//   HUB_URL=http://localhost:3200 HUB_JOIN_KEY=... HUB_ADMIN_TOKEN=... HUB_DATABASE_URL=postgresql://.../<hub scratch db> TESTLIB=<LIBRARY_DIR> npx playwright test manual-repository
// HUB_DATABASE_URL is only used to give the hub's copy of this company a verified StitchHub account (the hub refuses offers
// without one; making one through the hub's own pages needs a mail round trip).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { test, expect, type Page } from "@playwright/test";
import { one, OWNER } from "./helpers";

const hub = process.env.HUB_URL;
const joinKey = process.env.HUB_JOIN_KEY;
const admin = process.env.HUB_ADMIN_TOKEN;
const hubDb = process.env.HUB_DATABASE_URL;
const lib = process.env.TESTLIB;
const run = Date.now().toString(36);
const brand = `Spec${run}`;

test.skip(!hub || !joinKey || !admin || !hubDb || !lib, "set HUB_URL, HUB_JOIN_KEY, HUB_ADMIN_TOKEN, HUB_DATABASE_URL and TESTLIB to test the manual repository");
test.setTimeout(300_000);

type Waiting = { fileId: string; offered?: { brand?: string } };
type Answer = { waiting: Waiting[]; fileName: string; manualId: string; id: string };
const api = async (method: string, route: string, body?: unknown) => {
  const r = await fetch(`${hub}${route}`, { method, headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(r.ok, `${method} ${route}: ${r.status}`).toBe(true);
  return (await r.json()) as Answer;
};

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();
}

async function syncNow(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Update from StitchHub" }).click();
  await expect(page.getByText("Synced with the hub")).toBeVisible({ timeout: 180_000 });
}

test("manual repository: offer, approve, download, removed after a notice", async ({ page }) => {
  await signIn(page);

  // Joined to the test hub (leave a past run's connection first when it isn't this hub).
  await page.goto("/settings");
  const join = page.getByRole("button", { name: "Join", exact: true });
  if (await join.count()) {
    const invite = { v: 1, url: hub, joinKey, name: "Test hub" };
    await page.locator("#hub-invite").fill("stitchhub:" + Buffer.from(JSON.stringify(invite)).toString("base64url"));
    await join.click();
  }
  await expect(page.getByText(/Connected to/)).toBeVisible({ timeout: 180_000 });
  await syncNow(page);

  // The hub needs a verified StitchHub account on this company before it takes an offer.
  const shopId = (await one<{ shopId: string }>(`SELECT "shopId" FROM "User" WHERE email = $1`, [OWNER.email]))!.shopId;
  const hdb = new pg.Pool({ connectionString: hubDb, max: 1 });
  try {
    const email = `repo-spec-${run}@stitchhub.test`;
    const accountId = `acc${crypto.randomBytes(8).toString("hex")}`;
    await hdb.query(`INSERT INTO accounts (id, email, verified_at, disabled) VALUES ($1, $2, now(), false)`, [accountId, email]);
    const set = await hdb.query(`UPDATE shops SET account_id = $1 WHERE shop_ref = $2`, [accountId, shopId]);
    expect(set.rowCount, "the hub knows this company (a sync claims it)").toBeGreaterThan(0);
  } finally {
    await hdb.end();
  }

  // 1. An _inbox PDF, offered from Manual links.
  const fileName = `${brand}_E2E1_ServiceManual_2020.pdf`;
  const bytes = Buffer.from(`%PDF-1.4\n% repository spec ${run}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
  fs.mkdirSync(path.join(lib!, "_inbox"), { recursive: true });
  fs.writeFileSync(path.join(lib!, "_inbox", fileName), bytes);
  await page.goto("/links");
  await expect(page.getByRole("heading", { name: "Manual repository" })).toBeVisible();
  await expect(page.getByText("The manual repository opens soon.")).toHaveCount(0);
  const row = page.locator("li", { hasText: fileName }).first();
  await row.getByText("Offer to the repository").click();
  await row.getByLabel("Category").fill("Sewing");
  await expect(row.getByLabel("Brand")).toHaveValue(brand); // guessed from the file name
  await expect(row.getByLabel("Model(s), separated by commas")).toHaveValue("E2E1");
  // Nothing is sent until the statement is ticked for this file and Offer is pressed.
  expect((await api("GET", "/v1/admin/repository")).waiting.filter((w) => w.offered?.brand === brand)).toHaveLength(0);
  await row.getByRole("checkbox").check();
  await row.getByRole("button", { name: "Offer this manual" }).click();
  await expect(page.getByText(/Sending to the repository/)).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    await page.reload();
    await expect(page.locator("li", { hasText: `${brand} E2E1` }).getByText("Waiting for review")).toBeVisible();
  }).toPass({ timeout: 90_000 });
  await page.screenshot({ path: "test-results/repository-offered.png" });

  // 2. The hub's owner approves it (admin API), the next sync brings it to the shop.
  const waiting = (await api("GET", "/v1/admin/repository")).waiting.find((w) => w.offered?.brand === brand);
  expect(waiting, "the file waits for review on the hub").toBeTruthy();
  const approved = await api("POST", `/v1/admin/repository/files/${waiting!.fileId}/approve`, {});
  expect(approved.fileName).toBe(fileName);
  await syncNow(page);
  await page.goto(`/links?q=${brand}`);
  const repoRow = page.locator("li", { hasText: "In the repository" }).filter({ hasText: brand }).filter({ has: page.getByRole("button", { name: /Download to library/ }) }).first();
  await expect(repoRow).toBeVisible();

  // 3. "Download everything": the file lands in the library and the model page says so.
  await page.getByRole("button", { name: /Download everything not in the library/ }).click();
  await page.getByRole("button", { name: /^Every link not yet in the library\?/ }).click();
  await expect(page.getByText("Queued: every working link not yet in the library")).toBeVisible();
  const landed = path.join(lib!, "Sewing", brand, fileName);
  await expect(async () => expect(fs.existsSync(landed)).toBe(true)).toPass({ timeout: 120_000 });
  expect(fs.readFileSync(landed).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(crypto.createHash("sha256").update(fs.readFileSync(landed)).digest("hex")).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
  await page.goto(`/models/${brand}/E2E1`);
  await expect(page.getByText(/Service Manual: in the library/)).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: "test-results/repository-downloaded.png" });

  // 4. A copyright notice (admin API): after a sync the row is gone and the copy here is marked.
  const notice = await api("POST", "/v1/admin/repository/notices", {
    via: "email",
    raw: `Notice about manual ${approved.manualId}: the work ${brand} E2E1 service manual.`,
    work: `${brand} E2E1 service manual`,
    locations: approved.manualId,
    signature: "A. Owner",
    complainant: { name: "A. Owner", organisation: "Spec Maker", address: "1 Test Way", phone: "555-0100", email: "owner@spec-maker.test" },
    statements: { goodFaith: true, accuracy: true },
  });
  await api("POST", `/v1/admin/repository/notices/${notice.id}/action`, { manualIds: [approved.manualId], substantial: true });
  await syncNow(page);
  await page.goto(`/models/${brand}/E2E1`);
  await expect(page.getByText("Removed from the repository after a copyright notice")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Delete my copy" })).toBeVisible();
  expect(fs.existsSync(landed), "the program never deletes the file itself").toBe(true);
  await page.goto("/links");
  await expect(page.locator("li", { hasText: `${brand} E2E1` }).getByText("Removed after a copyright notice")).toBeVisible();
  await page.screenshot({ path: "test-results/repository-removed.png" });

  // Delete my copy: only on the marked copy, and only when the person presses it.
  await page.goto(`/models/${brand}/E2E1`);
  await page.getByRole("button", { name: "Delete my copy" }).click();
  await page.getByRole("button", { name: "Delete this copy from the library?" }).click();
  await expect(page.getByText("Copy deleted")).toBeVisible();
  expect(fs.existsSync(landed)).toBe(false);
});
