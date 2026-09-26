// The shop keeps working when the internet is down, once it has connected to the hub. Run in phases by an outside
// script that cuts the connection between them (OFFLINE_PHASE): prepare (online: the repair shop sets a sewing shop
// up and both accept), down (the hub refuses connections), hang (the hub accepts but never answers), back (the hub
// is running again: what was queued while offline goes out; cleanup). State between phases is in OFFLINE_STATE.
//   Needs this install joined to a test hub (Settings) and E2E_EMAIL listed in PLATFORM_ADMIN_EMAILS.
import { test, expect, type Page, type Browser } from "@playwright/test";
import fs from "node:fs";

type Job = { url: string; tag: string; model: string };
type State = { run: string; sewing: { shop: string; name: string; email: string; password: string }; linkId?: string; jobs: Job[] };

const phase = process.env.OFFLINE_PHASE ?? "";
const stateFile = process.env.OFFLINE_STATE ?? "";
const repair = { email: process.env.E2E_EMAIL ?? "e2e@stitchbench.test", password: process.env.E2E_PASSWORD ?? "e2e-password-1" };
const OFFLINE = /No connection to the community hub/;
// A page or a button must answer in this long, however the hub behaves.
const QUICK_MS = 10_000;

test.skip(!process.env.HUB_URL || !phase || !stateFile, "set HUB_URL, OFFLINE_PHASE and OFFLINE_STATE");
test.setTimeout(600_000);

function loadState(): State {
  return JSON.parse(fs.readFileSync(stateFile, "utf8")) as State;
}
function saveState(s: State) {
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

async function login(browser: Browser, who: { email: string; password: string }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return page;
}

/** Every page a shop uses all day must come up quickly, hub or no hub. */
async function pagesComeUp(page: Page, paths: string[]) {
  for (const p of paths) {
    const t = Date.now();
    await page.goto(p);
    await expect(page.locator("main")).toBeVisible();
    const took = Date.now() - t;
    expect(took, `${p} took ${took} ms`).toBeLessThan(QUICK_MS);
  }
}

async function sync(page: Page) {
  for (let i = 0; i < 2; i++) {
    await page.goto("/partners");
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Synced with partners")).toBeVisible();
    await page.waitForTimeout(500);
  }
}

/** Something that needs the hub: it must say so (a toast) within `within` ms, not sit on a spinner. */
async function needsHub(page: Page, act: () => Promise<void>, within: number) {
  const t = Date.now();
  await act();
  // The toast, not text already on the page (the Partners page shows the last sync error).
  const toast = page.getByRole("status").filter({ hasText: OFFLINE }).or(page.locator("[data-sonner-toast]").filter({ hasText: OFFLINE }));
  await expect(toast.first()).toBeVisible({ timeout: within + 30_000 });
  const took = Date.now() - t;
  expect(took, `answered in ${took} ms`).toBeLessThan(within);
  return took;
}

async function takeMachineIn(s: Page, run: string, model: string) {
  await s.goto("/repairs/new");
  await s.locator("#customerName").fill("Olive Offline");
  await s.locator("#customerPhone").fill("555-0199");
  await s.locator("#brand").fill("Janome");
  await s.locator("#model").fill(model);
  await s.locator("#serial").fill(`OFF${run}${model.replace(/\D/g, "")}${Date.now().toString(36).slice(-3).toUpperCase()}`);
  await s.locator("#problem").fill("Taken in while the internet was down");
  await s.getByRole("button", { name: "Take it in and make the claim tag" }).click();
  const heading = s.getByRole("heading", { name: /Tag \d+/ });
  await expect(heading).toBeVisible();
  const tag = /Tag (\d+)/.exec((await heading.textContent()) ?? "")![1];
  return { url: s.url(), tag, model } as Job;
}

/** The row for one intake on the repair shop's partner page: that model with that claim-tag number. */
function benchRow(r: Page, job: Job) {
  return r.locator("tr", { hasText: job.model }).filter({ hasText: new RegExp(`\\b${job.tag}\\b`) });
}

test(`offline: ${phase}`, async ({ browser }) => {
  if (phase === "prepare") {
    const run = Date.now().toString(36).toUpperCase();
    const state: State = {
      run,
      sewing: { shop: `Offline Quilts ${run}`, name: "Olive Owner", email: `olive.${run.toLowerCase()}@quilt.test`, password: "quilt-pass-1" },
      jobs: [],
    };
    const r = await login(browser, repair);
    await r.goto("/partners");
    await r.locator("#ss-shop").fill(state.sewing.shop);
    await r.locator("#ss-name").fill(state.sewing.name);
    await r.locator("#ss-email").fill(state.sewing.email);
    await r.locator("#ss-pw").fill(state.sewing.password);
    await r.locator("#ss-repairCommissionPct").fill("15");
    await r.locator("#ss-consignSharePct").fill("30");
    await r.getByRole("button", { name: "Set up their shop" }).click();
    await expect(r.getByText("Set up and partnered")).toBeVisible();
    await r.reload();
    await r.getByRole("link", { name: state.sewing.shop }).click();
    await r.waitForURL(/\/partners\/[^/]+$/);
    state.linkId = new URL(r.url()).pathname.split("/").pop()!;
    await r.goto(`/partners/${state.linkId}/agreement`);
    await r.locator("#accept-name").fill("Bruce Tester");
    await r.getByLabel(/I've read these terms/).check();
    await r.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(r.getByText("Accepted", { exact: true })).toBeVisible();
    await sync(r);
    const s = await login(browser, state.sewing);
    await s.goto("/partners");
    await s.getByRole("link", { name: /E2E Test Shop/ }).click();
    await s.getByRole("link", { name: "Read and accept the agreement" }).click();
    await s.locator("#accept-name").fill(state.sewing.name);
    await s.getByLabel(/I've read these terms/).check();
    await s.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(s.getByText("Both shops accepted version 1.")).toBeVisible();
    await sync(s);
    saveState(state);
    return;
  }

  const state = loadState();

  if (phase === "down" || phase === "hang") {
    // The sewing shop's counter: everything local works, and a machine taken in now reaches the repair shop later.
    const s = await login(browser, state.sewing);
    await pagesComeUp(s, ["/register", "/parts", "/repairs", "/customers", "/partners", "/"]);
    const job = await takeMachineIn(s, state.run, phase === "down" ? "MC6650" : "MC8200");
    state.jobs.push(job);
    await expect(s.getByText("Here, waiting for the repair shop").first()).toBeVisible();
    // A new item goes into inventory (its number unique to this run of the phase, so a rerun isn't a duplicate).
    const item = `OFF-${phase.toUpperCase()}-${state.run}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    await s.goto("/parts");
    await s.getByLabel("Part number", { exact: true }).fill(item);
    await s.getByLabel("Description", { exact: true }).fill("Seam ripper (offline test)");
    await s.getByLabel("Price each ($, blank = cost + markup)").fill("4.00");
    await s.getByLabel("Quantity on hand").fill("5");
    await s.getByRole("button", { name: "Add part" }).click();
    await expect(s.getByRole("heading", { name: new RegExp(item) })).toBeVisible();

    // The repair shop's bench: the same, plus what needs the hub says so instead of hanging.
    const r = await login(browser, repair);
    await pagesComeUp(r, ["/", "/tickets", "/parts", "/customers", "/market", "/shared", "/partners", "/manuals", "/xref"]);
    await r.goto("/tickets/new");
    await r.getByLabel("New customer name").fill("Offline Customer");
    await r.getByLabel("Brand", { exact: true }).fill("Janome");
    await r.getByLabel("Model", { exact: true }).fill("MC6700P");
    await r.getByLabel("Serial number", { exact: true }).fill(`OFFT${state.run}${phase}${Date.now().toString(36).slice(-3)}`);
    await r.getByLabel("Problem reported", { exact: true }).fill("Skipping stitches");
    await r.getByRole("button", { name: "Create ticket" }).click();
    await expect(r.getByRole("heading", { level: 1, name: /Janome MC6700P/ })).toBeVisible();
    // With a hub that never answers, the first try can take the full wait; after that it answers in seconds.
    const first = await needsHub(
      r,
      async () => {
        await r.goto("/partners");
        await r.getByRole("button", { name: "Sync now" }).click();
      },
      phase === "hang" ? 45_000 : QUICK_MS,
    );
    console.log(`${phase}: sync now answered in ${first} ms`);
    const second = await needsHub(
      r,
      async () => {
        await r.goto("/market/mine");
        await r.locator("#ls-title").fill(`Offline listing ${state.run}`);
        await r.locator("#ls-pn").fill(`OFF-${state.run}`);
        await r.locator("#ls-brand").fill("Brother");
        await r.locator("#ls-price").fill("5.00");
        await r.locator("#ls-qty").fill("1");
        await r.getByRole("button", { name: "List it for sale" }).click();
      },
      QUICK_MS,
    );
    console.log(`${phase}: listing answered in ${second} ms`);
    // The sidebar says the hub is out of reach, once.
    await r.goto("/");
    await expect(r.locator("aside").getByText(/Offline since/)).toBeVisible();
    // The sewing shop's machine hasn't reached the bench: it waits for the connection.
    await r.goto(`/partners/${state.linkId}`);
    await expect(benchRow(r, job)).toHaveCount(0);
    saveState(state);
    return;
  }

  if (phase === "back") {
    const r = await login(browser, repair);
    await sync(r);
    // Both machines taken in while offline are on the bench now, and the warning is gone.
    await r.goto(`/partners/${state.linkId}`);
    for (const job of state.jobs) await expect(benchRow(r, job)).toHaveCount(1);
    await r.goto("/");
    await expect(r.locator("aside").getByText(/Offline since/)).toHaveCount(0);
    // The sewing shop sees its jobs went through.
    const s = await login(browser, state.sewing);
    await sync(s);
    // Each job page now names the repair shop's ticket for it (the "waiting" line only changes when the tech acts).
    for (const { url } of state.jobs) {
      await s.goto(url);
      await expect(s.getByText(/their ticket #[0-9]+/)).toBeVisible();
    }
    // Cleanup, so other specs can leave the hub: end the partnership from the repair shop.
    await r.goto(`/partners/${state.linkId}`);
    await r.locator("#note").fill("End of the offline test");
    await r.getByRole("button", { name: "End partnership" }).click();
    await expect(r.getByText("Partnership ended", { exact: true })).toBeVisible();
    await sync(r);
    return;
  }
  throw new Error(`unknown OFFLINE_PHASE ${phase}`);
});
