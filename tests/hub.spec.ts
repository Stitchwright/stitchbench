// StitchBench with a community hub (StitchHub): join, manual links (add, download, fix, history, roll back,
// remove) and sharing a note. Needs a test hub and a URL that serves a PDF:
//   HUB_URL=http://localhost:3200 HUB_JOIN_KEY=... HUB_ADMIN_TOKEN=... PDF_URL=http://localhost:3400/test-manual.pdf TESTLIB=<LIBRARY_DIR> npx playwright test hub
// HUB_ADMIN_TOKEN loads the MC6700P catalog links into a fresh hub; without it the hub must already have them.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

const hub = process.env.HUB_URL;
const joinKey = process.env.HUB_JOIN_KEY;
const pdfUrl = process.env.PDF_URL;
const run = Date.now().toString(36);
const linkUrl = `${process.env.PDF_URL}?run=${run}`; // each run adds its own link (the hub refuses duplicates)

test.skip(!hub || !joinKey || !pdfUrl, "set HUB_URL, HUB_JOIN_KEY and PDF_URL to test the community hub");
test.setTimeout(300_000);

async function twoTap(page: Page, first: ReturnType<Page["getByRole"]>, confirmText: string) {
  await first.click();
  await page.getByRole("button", { name: confirmText }).click();
}

test("community hub: links and shared notes", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(process.env.E2E_EMAIL ?? "e2e@stitchbench.test");
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Bench" })).toBeVisible();

  // Join with a member invite (the first sync pulls the whole link catalog). Leave first if a past run joined.
  await page.goto("/settings");
  const leave = page.getByRole("button", { name: "Leave the hub" });
  if (await leave.count()) {
    await leave.click();
    await page.getByRole("button", { name: "Disconnect from the hub?" }).click();
    await expect(page.getByRole("button", { name: "Join", exact: true })).toBeVisible();
  }
  const invite = { v: 1, url: hub, joinKey, name: "Test hub", discord: "https://discord.gg/stitchtest" };
  await page.locator("#hub-invite").fill("stitchhub:" + Buffer.from(JSON.stringify(invite)).toString("base64url"));
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByText(/Connected to/)).toBeVisible({ timeout: 180_000 });
  // The invite's Discord link becomes "Community chat" (until the hub says otherwise at the next sync).
  await expect(page.getByRole("link", { name: "Community chat" })).toHaveAttribute("href", /discord/);
  await page.screenshot({ path: "test-results/hub-settings.png" });

  // The catalog's links for this model. A fresh test hub has none: with HUB_ADMIN_TOKEN, load this model's rows from the
  // shipped link list (the hub skips ones it already has), then sync so this install has them.
  if (process.env.HUB_ADMIN_TOKEN) {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "prisma", "seed-data", "hub_links.json"), "utf8")) as { models: string }[];
    const rows = all.filter((l) => l.models === "MC6700P");
    const r = await fetch(`${hub}/v1/admin/links/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.HUB_ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(rows),
    });
    expect(r.ok).toBe(true);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Synced with the hub")).toBeVisible({ timeout: 180_000 });
  }
  await page.goto("/models/Janome/MC6700P");
  await expect(page.getByRole("heading", { name: /Manual links \(([2-9]|\d\d+)\)/ })).toBeVisible();

  // Add a link, download it into the library.
  const title = `Hub test manual ${run}`;
  await page.getByText("Add a link for the MC6700P").click();
  await page.locator("#lu-new").fill(linkUrl);
  await page.locator("#lt-new").fill(title);
  await page.locator("#ln-new").fill("added by the hub test");
  await page.getByRole("button", { name: "Share link" }).click();
  await expect(page.getByText("Link shared with every shop")).toBeVisible();
  const item = page.locator("li", { has: page.getByRole("link", { name: title }) });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: /Download to library/ }).click();
  await expect(page.getByText("Saved to the manual library's _inbox")).toBeVisible({ timeout: 60_000 });
  if (process.env.TESTLIB) {
    const inbox = path.join(process.env.TESTLIB, "_inbox");
    expect(fs.readdirSync(inbox).some((f) => f.startsWith("Janome_MC6700P_ServiceManual"))).toBe(true);
  }

  // Fix it, see the history, roll back.
  const moved = pdfUrl!.replace(/[^/]+$/, `moved-${run}.pdf`);
  await item.getByText("Fix link").click();
  await item.locator("input[name=url]").fill(moved);
  await item.locator("input[name=note]").fill("moved (test)");
  await item.getByRole("button", { name: "Save for everyone" }).click();
  await expect(page.getByText("Link fixed for every shop")).toBeVisible();
  await expect(item.getByRole("link", { name: title })).toHaveAttribute("href", moved);
  await item.getByRole("button", { name: "History" }).click();
  await expect(item.getByText("Changed", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/hub-link-history.png", fullPage: true });
  await twoTap(page, item.getByRole("button", { name: "Roll back to this" }).first(), "Go back to this version?");
  await expect(page.getByText("Rolled back").first()).toBeVisible();
  await expect(item.getByRole("link", { name: title })).toHaveAttribute("href", linkUrl);

  // Clean up the link.
  await twoTap(page, item.getByRole("button", { name: "Remove", exact: true }), "Remove for everyone?");
  await expect(page.getByRole("link", { name: title })).toHaveCount(0);

  // Share a note from a machine; it goes to the hub and comes back as the community's copy.
  await page.goto("/machines");
  await page.getByRole("link", { name: /Janome MC6700P/ }).first().click();
  const note = `Hub test note ${run}`;
  await page.locator("summary", { hasText: "Share with other techs" }).click();
  await page.locator("#share-title").fill(note);
  await page.locator("#share-body").fill("Checks that notes go through the community hub.");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const shared = page.locator("li", { has: page.getByText(note, { exact: true }) });
  await expect(shared).toBeVisible();
  await expect(shared.getByText(/Sending to the community hub/)).toHaveCount(0);
  await expect(shared.getByText(/E2E Test Shop/)).toBeVisible();
  await page.screenshot({ path: "test-results/hub-note.png", fullPage: true });
  await twoTap(page, shared.getByRole("button", { name: "Remove" }), "Stop sharing this?");
  await expect(page.getByText(note, { exact: true })).toHaveCount(0);

  // The catalog page.
  await page.goto("/links?q=MC6700P");
  await expect(page.getByRole("heading", { name: "Manual links" })).toBeVisible();
  await page.screenshot({ path: "test-results/hub-links-page.png", fullPage: true });
});
