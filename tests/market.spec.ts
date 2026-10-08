// Parts cross-reference and marketplace against a test StitchHub, from both sides of a sale.
// The other shop ("member B") is scripted straight against the hub API.
//   HUB_URL=http://localhost:3200 HUB_JOIN_KEY=... HUB_ADMIN_TOKEN=... npx playwright test market
import { test, expect, type Page } from "@playwright/test";

const hub = process.env.HUB_URL;
const joinKey = process.env.HUB_JOIN_KEY;
const run = Date.now().toString(36).toUpperCase();

test.skip(!hub || !joinKey, "set HUB_URL and HUB_JOIN_KEY to test the marketplace");
test.setTimeout(300_000);

async function api(path: string, key: string, init: { method?: string; json?: unknown; body?: BodyInit } = {}) {
  const r = await fetch(hub + path, {
    method: init.method ?? (init.json || init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${key}`, ...(init.json ? { "Content-Type": "application/json" } : {}) },
    body: init.json ? JSON.stringify(init.json) : init.body,
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function twoTap(page: Page, name: string | RegExp, confirmText: string) {
  await page.getByRole("button", { name }).first().click();
  await page.getByRole("button", { name: confirmText }).click();
}

async function refresh(page: Page) {
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("Up to date")).toBeVisible();
}

test("cross-reference and marketplace", async ({ page }) => {
  // Member B: another shop on the hub.
  const b = await (await fetch(`${hub}/v1/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ joinKey, name: `Test Seller Shop ${run}` }) })).json();
  const bKey = b.installKey as string;

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(process.env.E2E_EMAIL ?? "e2e@stitchbench.test");
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();

  // On the hub (join with an invite if a past run didn't).
  await page.goto("/settings");
  if (await page.getByRole("button", { name: "Join", exact: true }).count()) {
    await page.locator("#hub-invite").fill("stitchhub:" + Buffer.from(JSON.stringify({ v: 1, url: hub, joinKey })).toString("base64url"));
    await page.getByRole("button", { name: "Join", exact: true }).click();
  }
  await expect(page.getByText(/Connected to/)).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: "Update from StitchHub" }).click();
  await expect(page.getByText("Synced with the hub")).toBeVisible({ timeout: 180_000 });

  // ---- cross-reference: add, fix, history, roll back, and it shows on the model page ----
  const partNo = `TS-${run}`;
  await page.goto("/xref");
  await page.locator("#xn-new").fill(`Test screw ${run}`);
  await page.locator("#xc-new").fill("Screw");
  await page.locator("#xs-new").fill("M3 x 6 mm pan head");
  await page.locator("#xnum-new").fill(`Brother, ${partNo}`);
  await page.locator("#xfit-new").fill("Brother, PE770");
  await page.getByRole("button", { name: "Add to the cross-reference" }).click();
  await expect(page.getByRole("heading", { name: `Test screw ${run}` })).toBeVisible();
  await expect(page.getByRole("link", { name: "Brother PE770" })).toBeVisible();
  const xrefUrl = page.url();
  const fitsBox = page.locator("textarea[name=fits]");
  await fitsBox.fill("Brother, PE770\nBaby Lock, BMP8");
  await page.locator("textarea[name=sources]").fill("Test Supply Co, https://example.com/screw, 0.95");
  await page.getByRole("button", { name: "Save for everyone" }).click();
  await expect(page.getByText("Saved for every shop")).toBeVisible();
  await expect(page.getByRole("link", { name: "Baby Lock BMP8" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Test Supply Co/ })).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByText("Changed", { exact: true })).toBeVisible();
  await twoTap(page, "Roll back to this", "Go back to this version?");
  await expect(page.getByText("Rolled back").first()).toBeVisible();
  await page.goto(xrefUrl);
  await expect(page.getByRole("link", { name: "Baby Lock BMP8" })).toHaveCount(0);
  // The whole list: the model page shows the first 25, and every earlier run left a test screw that fits.
  await page.goto("/models/Brother/PE770/parts");
  await expect(page.getByRole("link", { name: `Test screw ${run}` })).toBeVisible();

  // ---- selling: list it, member B orders, accept, paid, ship ----
  await page.goto("/market/mine");
  await page.locator("#ls-title").fill(`Test listing ${run}`);
  await page.locator("#ls-pn").fill(partNo);
  await page.locator("#ls-brand").fill("Brother");
  await page.locator("#ls-price").fill("5.00");
  await page.locator("#ls-qty").fill("3");
  await page.locator("#ls-origin").selectOption("COMPATIBLE");
  await page.getByRole("button", { name: "List it for sale" }).click();
  await expect(page.getByRole("heading", { name: `Test listing ${run}` })).toBeVisible({ timeout: 60_000 });
  // Who made it comes back from the hub and shows on the listing.
  await expect(page.getByText("Compatible", { exact: true })).toBeVisible();
  const listingId = page.url().split("/").pop()!;
  await api("/v1/orders", bKey, { json: { listingId, qty: 2, shipTo: "Test Seller Shop\n1 Main St\nTown, ST 00000", buyerNote: "test order", buyerContact: { name: "B" } } });
  await page.goto("/market/orders?role=seller");
  await refresh(page);
  await page.getByRole("link", { name: /^SH-/ }).first().click();
  // The order's item says who made it.
  await expect(page.getByText("Compatible", { exact: true })).toBeVisible();
  await page.locator("#ac-ship").fill("4.00");
  await page.locator("#ac-pay").fill("PayPal: test@example.com");
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Accepted: the buyer has your invoice")).toBeVisible();
  await expect(page.getByText("$14.00")).toBeVisible();
  await page.getByRole("button", { name: "Mark it paid" }).click();
  await expect(page.getByText("Marked paid")).toBeVisible();
  const sellOrderId = page.url().split("/").pop()!;
  await page.locator("#sh-track").fill("9400100000000000000000");
  await page.getByRole("checkbox", { name: /Take 2 out of my parts stock/ }).uncheck();
  await page.getByRole("button", { name: "Mark shipped" }).click();
  await expect(page.getByText("Shipped: the buyer has the tracking")).toBeVisible();
  await expect(page.getByRole("link", { name: /9400100000000000000000/ })).toHaveAttribute("href", /usps/i);
  // Once it has shipped, the seller can rate the buyer (the form shows only when the hub would take the rating).
  await page.locator("#rt-stars").selectOption("5");
  await page.locator("#rt-comment").fill("Paid fast");
  await page.getByRole("button", { name: "Send rating" }).click();
  await expect(page.getByText("Thanks for rating")).toBeVisible();
  // The buyer (member B) rates us after it shipped; we see it on the order.
  await api(`/v1/orders/${sellOrderId}/rate`, bKey, { json: { stars: 4, comment: "Well packed" } });
  await page.goto("/market/orders?role=seller");
  await refresh(page);
  await page.goto(`/market/orders/${sellOrderId}`);
  await expect(page.getByText("“Well packed”")).toBeVisible();
  await expect(page.getByText("“Paid fast”")).toBeVisible();
  await page.getByRole("link", { name: "Invoice", exact: true }).click();
  await expect(page.getByText(/Invoice\s+SH-/)).toBeVisible();
  await page.screenshot({ path: "test-results/market-invoice-seller.png", fullPage: true });

  // ---- buying: member B lists, we order, B accepts; we pay, B ships, we receive into stock ----
  const fd = new FormData();
  fd.set("listing", JSON.stringify({ title: `B's presser foot ${run}`, kind: "ACCESSORY", condition: "NEW", brand: "Janome", partNumber: `PF-${run}`, priceCents: 1250, qty: 2, shippingCents: 500, shipsFrom: "Town, ST" }));
  const bl = await api("/v1/listings", bKey, { body: fd });
  await page.goto("/market/orders");
  await refresh(page);
  await page.goto(`/market/${bl.id}`);
  await expect(page.getByRole("heading", { name: `B's presser foot ${run}` })).toBeVisible();
  const shipTo = page.getByRole("textbox", { name: "Ship to" });
  if (!(await shipTo.inputValue())) await shipTo.fill("E2E Test Shop\n2 Bench Rd\nTown, ST 00000");
  await page.getByRole("button", { name: "Send order" }).click();
  await expect(page.getByRole("heading", { name: /Order SH-/ })).toBeVisible({ timeout: 60_000 });
  const orderId = page.url().split("/").pop()!;
  await api(`/v1/orders/${orderId}/accept`, bKey, { json: { sellerContact: { name: "B shop", address: "1 Main St" }, payInstructions: "Zelle 555-0100" } });
  await page.goto("/market/orders");
  await refresh(page);
  await page.goto(`/market/orders/${orderId}`);
  await expect(page.getByText("Zelle 555-0100")).toBeVisible();
  await page.getByRole("textbox", { name: "How you paid" }).fill("Zelle, test");
  await page.getByRole("button", { name: "I've sent payment" }).click();
  await expect(page.getByText("The seller knows you've paid")).toBeVisible();
  await api(`/v1/orders/${orderId}/paid`, bKey, { json: {} });
  await api(`/v1/orders/${orderId}/ship`, bKey, { json: { carrier: "UPS", tracking: "1Z999AA10123456784" } });
  await page.goto("/market/orders");
  await refresh(page);
  await page.goto(`/market/orders/${orderId}`);
  await page.getByRole("button", { name: "Mark received" }).click();
  await expect(page.getByText("Received", { exact: true }).first()).toBeVisible();
  await page.locator("#rt-stars").selectOption("3");
  await page.locator("#rt-comment").fill("Slow to ship");
  await page.getByRole("button", { name: "Send rating" }).click();
  await expect(page.getByText("Thanks for rating")).toBeVisible();
  // Member B's shop page shows the rating we gave it as a seller.
  await page.goto(`/market/shops/${b.installId}`);
  await expect(page.getByText("“Slow to ship”")).toBeVisible();
  await page.goto(`/parts?q=PF-${run}`);
  await expect(page.getByRole("link", { name: `PF-${run}` })).toBeVisible();
  await page.screenshot({ path: "test-results/market-received.png", fullPage: true });

  // Clean up: take our listing down and block member B.
  await page.goto(`/market/${listingId}`);
  await twoTap(page, /Remove listing/, "Take it off the marketplace?");
  if (process.env.HUB_ADMIN_TOKEN) {
    await fetch(`${hub}/v1/admin/installs/${b.installId}/block`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.HUB_ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ blocked: true }),
    });
  }
});
