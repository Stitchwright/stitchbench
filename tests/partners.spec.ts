// StitchShop and partner shops, both sides, on one install (the repair shop sets the sewing shop up here), talking
// through a test StitchHub: agreement, machine intake -> repair ticket -> estimate -> customer OK -> ready -> paid at
// the sewing shop's register with a consigned item -> statement on both sides; plus an order from the catalog.
//   Needs this install joined to a test hub (Settings) and E2E_EMAIL listed in PLATFORM_ADMIN_EMAILS.
//   HUB_URL=http://localhost:3200 npx playwright test partners
import { test, expect, type Page, type Browser } from "@playwright/test";

const run = Date.now().toString(36).toUpperCase();
const sewing = { shop: `Quilt Corner ${run}`, name: "Pat Quilter", email: `pat.${run.toLowerCase()}@quilt.test`, password: "quilt-pass-1" };
const repair = { email: process.env.E2E_EMAIL ?? "e2e@stitchbench.test", password: process.env.E2E_PASSWORD ?? "e2e-password-1" };
const pn = `NOT-${run}`; // an item the repair shop consigns and sells to partners

test.skip(!process.env.HUB_URL, "set HUB_URL (a test StitchHub this install has joined)");
test.setTimeout(600_000);

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

/** Both shops live on this install, so one sync moves every message; twice lets replies go round. */
async function sync(page: Page) {
  for (let i = 0; i < 2; i++) {
    await page.goto("/partners");
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Synced with partners")).toBeVisible();
    await page.waitForTimeout(500);
  }
}

test("a repair shop and its partner sewing shop", async ({ browser }) => {
  const r = await login(browser, repair);

  // An item the repair shop sells to partners (partner price) and will consign.
  await r.goto("/parts");
  await r.locator("#partNumber").fill(pn);
  await r.locator("#description").fill("Rotary cutter 45mm");
  await r.locator("#kind").selectOption("NOTION");
  await r.locator("#price").fill("24.00");
  await r.locator("#wholesale").fill("14.00");
  await r.getByLabel(/Offer to partner shops/).check();
  await r.locator("#qtyOnHand").fill("20");
  await r.getByRole("button", { name: "Add part" }).click();
  await expect(r.getByRole("heading", { name: new RegExp(pn) })).toBeVisible();

  // Set up StitchShop for the sewing shop: their company, owner login and the partnership, in one go.
  await r.goto("/partners");
  await r.locator("#ss-shop").fill(sewing.shop);
  await r.locator("#ss-name").fill(sewing.name);
  await r.locator("#ss-email").fill(sewing.email);
  await r.locator("#ss-pw").fill(sewing.password);
  await r.locator("#ss-repairCommissionPct").fill("15");
  await r.locator("#ss-consignSharePct").fill("30");
  await r.getByRole("button", { name: "Set up their shop" }).click();
  await expect(r.getByText("Set up and partnered")).toBeVisible();
  await r.reload();
  await r.getByRole("link", { name: sewing.shop }).click();
  await r.waitForURL(/\/partners\/[^/]+$/);
  const linkId = new URL(r.url()).pathname.split("/").pop()!;

  // The repair shop accepts the agreement and puts 5 cutters on the sewing shop's shelf.
  await r.goto(`/partners/${linkId}/agreement`);
  await expect(r.getByText(/earns\s+15%/)).toBeVisible();
  await expect(r.getByText(/Shop software/)).toBeVisible();
  await r.locator("#accept-name").fill("Bruce Tester");
  await r.getByLabel(/I've read these terms/).check();
  await r.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(r.getByText("Accepted", { exact: true })).toBeVisible();
  await r.goto(`/partners/${linkId}/consignment`);
  await r.locator("#cpn").fill(pn);
  await r.locator("#cqty").fill("5");
  await r.locator("#cprice").fill("24.00");
  await r.getByRole("button", { name: "Place on their shelf" }).click();
  await expect(r.getByText("Placed on their shelf", { exact: true })).toBeVisible();
  await sync(r);

  // The sewing shop signs in: StitchShop, register first.
  const s = await login(browser, sewing);
  await expect(s).toHaveURL(/\/register$/);
  await expect(s.locator("aside").first()).toContainText("StitchShop");
  await expect(s.getByRole("link", { name: "Repairs" })).toBeVisible();
  await expect(s.getByRole("link", { name: "Tickets" })).toHaveCount(0);
  await s.goto("/partners");
  await s.getByRole("link", { name: /E2E Test Shop/ }).click();
  await s.getByRole("link", { name: "Read and accept the agreement" }).click();
  await s.locator("#accept-name").fill(sewing.name);
  await s.getByLabel(/I've read these terms/).check();
  await s.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(s.getByText("Both shops accepted version 1.")).toBeVisible();
  // The consigned cutters are in the sewing shop's inventory.
  await s.goto(`/parts?q=${pn}`);
  await expect(s.getByText("consigned")).toBeVisible();

  // Take a machine in at the counter.
  await s.goto("/repairs/new");
  await s.locator("#customerName").fill("Mary Stitch");
  await s.locator("#customerPhone").fill("555-0142");
  await s.locator("#brand").fill("Janome");
  await s.locator("#model").fill("MC6700P");
  await s.locator("#serial").fill(`SN${run}`);
  // A problem of only spaces gets past the browser's "required": refused, and no customer is left behind by it.
  await s.locator("#problem").fill("   ");
  await s.getByRole("button", { name: "Take it in and make the claim tag" }).click();
  await expect(s.getByText(/Say what's wrong with it/)).toBeVisible();
  await s.locator("#problem").fill("Skipping stitches, loud clunk");
  await s.locator("#preApproved").fill("100");
  await s.getByRole("button", { name: "Take it in and make the claim tag" }).click();
  await expect(s.getByRole("heading", { name: /Tag 101/ })).toBeVisible();
  const jobUrl = s.url();
  await expect(s.getByText("Here, waiting for the repair shop").first()).toBeVisible();
  await s.getByRole("link", { name: "Print claim tag" }).click();
  await expect(s.getByText("CLAIM TAG", { exact: true })).toBeVisible();
  // The corrected try made the only "Mary Stitch".
  await s.goto("/customers?q=Mary%20Stitch");
  await expect(s.getByRole("link", { name: "Mary Stitch" })).toHaveCount(1);
  await sync(s);

  // The repair shop has a ticket for it, from the partner, with only first name + initial.
  await r.goto(`/partners/${linkId}`);
  const row = r.locator("tr", { hasText: "MC6700P" });
  await expect(row).toContainText("101");
  await row.getByRole("link", { name: /^#/ }).click();
  await expect(r.getByText(/their tag/)).toBeVisible();
  await expect(r.getByText(/customer Mary S\./).first()).toBeVisible();
  await expect(r.getByText("555-0142")).toHaveCount(0);
  // Bill it, ask for the customer's OK.
  await r.getByLabel("Custom description").fill("Clean, oil, time the hook");
  await r.getByLabel("Price", { exact: true }).fill("120.00");
  await r.getByRole("button", { name: "Add service" }).click();
  await expect(r.getByText("Clean, oil, time the hook")).toBeVisible();
  await r.locator("#repairNote").fill("Hook timing off; over the $100 OK");
  await r.getByRole("button", { name: "Send note" }).click();
  await expect(r.getByText("The shop will see it")).toBeVisible();
  await r.locator("#status").selectOption("WAITING_CUSTOMER_OK");
  await expect(r.getByText("Status: Waiting on customer OK")).toBeVisible();
  const ticketUrl = r.url();
  await sync(r);

  // The sewing shop sees it needs the customer's OK, calls, and approves.
  await s.goto(jobUrl);
  await expect(s.getByText("The repair shop needs the customer's OK")).toBeVisible();
  await expect(s.getByText(/Hook timing off/).first()).toBeVisible();
  await expect(s.getByText("$120.00").first()).toBeVisible();
  await s.getByRole("button", { name: "Customer approved" }).click();
  await expect(s.getByText("Sent to the repair shop")).toBeVisible();
  await sync(s);

  // Back on the bench: approved, repaired, sent back.
  await r.goto(ticketUrl);
  await expect(r.getByText(/customer approved up to \$120\.00/).first()).toBeVisible();
  await expect(r.locator("#status")).toHaveValue("ON_BENCH");
  // "Collected" is the sewing shop's to mark (when its customer pays and takes the machine), not the bench's.
  await expect(r.locator('#status option[value="COLLECTED"]')).toBeDisabled();
  await r.locator("#status").selectOption("READY_FOR_PICKUP");
  await expect(r.getByText("Status: Ready - customer called")).toBeVisible();
  await sync(r);

  // The customer collects and pays at the sewing shop's register, and buys a consigned cutter too.
  await s.goto("/register");
  await s.getByRole("button", { name: "Repair pickup" }).click();
  await s.getByRole("button", { name: "Add $120.00" }).click();
  await s.locator("#register-code").fill(pn);
  await s.locator("#register-code").press("Enter");
  await expect(s.getByRole("table", { name: "Sale" })).toContainText("Rotary cutter 45mm");
  await expect(s.getByTestId("sale-total")).toHaveText("$144.00");
  await s.locator("#tender-amount").fill("150");
  await s.getByRole("button", { name: "Cash", exact: true }).click();
  await expect(s.getByText("$6.00").first()).toBeVisible();
  await s.getByRole("button", { name: "Complete sale" }).click();
  await expect(s.getByText(/Sale #1001 done\. Change due \$6\.00/)).toBeVisible();
  await s.getByRole("link", { name: "Print receipt" }).click();
  await expect(s.getByText("TOTAL", { exact: true })).toBeVisible();
  await s.screenshot({ path: "test-results/stitchshop-receipt.png", fullPage: true });
  await sync(s);

  // The repair shop: paid at the partner's counter, collected; one cutter sold off the consignment shelf.
  await r.goto(ticketUrl);
  await expect(r.getByText(new RegExp(`Paid at ${sewing.shop}, sale #1001`)).first()).toBeVisible();
  await expect(r.locator("#status")).toHaveValue("COLLECTED");
  await r.goto(`/partners/${linkId}/consignment`);
  const cut = r.locator("tr", { hasText: pn });
  await expect(cut.locator("td").nth(3)).toHaveText("1"); // sold
  await expect(cut.locator("td").nth(5)).toHaveText("4"); // on the shelf

  // Statement, both sides: repair $120 less 15% ($18) = $102, cutter $24 less 30% ($7.20) = $16.80: $118.80 owed.
  await r.goto(`/partners/${linkId}/statement`);
  await expect(r.getByTestId("balance")).toHaveText("$118.80");
  await s.goto(`/partners/${linkId}/statement`);
  await expect(s.getByTestId("balance")).toHaveText("$118.80");
  await expect(s.getByText(/owes E2E Test Shop/).last()).toBeVisible();

  // An order from the repair shop's catalog: 2 cutters at the partner price.
  await s.goto(`/partners/${linkId}/order`);
  await s.getByLabel(`Quantity of ${pn}`).fill("2");
  await s.getByRole("button", { name: "Send order" }).click();
  await expect(s.getByRole("heading", { name: /Order PO-1001/ })).toBeVisible();
  const orderPath = new URL(s.url()).pathname;
  await sync(s);
  await r.goto(orderPath);
  await r.getByRole("button", { name: "Delivered" }).click();
  await expect(r.getByText("Marked delivered")).toBeVisible();
  await sync(r);
  await s.goto(orderPath);
  await s.getByRole("button", { name: "Received: add to inventory" }).click();
  await expect(s.getByText("Added to your inventory")).toBeVisible();

  // Settle: the sewing shop pays the balance ($118.80 + $28.00 order).
  await s.goto(`/partners/${linkId}/statement`);
  await expect(s.getByTestId("balance")).toHaveText("$146.80");
  await s.locator("#method").fill("Check 1001");
  await s.getByRole("button", { name: "Record payment" }).click();
  await expect(s.getByText("Payment recorded")).toBeVisible();
  await s.reload();
  await expect(s.getByTestId("balance")).toHaveText("$0.00");
  await sync(s);
  await r.goto(`/partners/${linkId}/statement`);
  // The sewing shop's word first; the repair shop confirms the money arrived.
  await expect(r.getByTestId("balance")).toHaveText("$146.80");
  await r.getByRole("button", { name: "Confirm it arrived" }).click();
  await expect(r.getByText("Payment confirmed")).toBeVisible();
  await r.reload();
  await expect(r.getByTestId("balance")).toHaveText("$0.00");
  await r.screenshot({ path: "test-results/partner-statement.png", fullPage: true });
  await s.goto("/repairs");
  await s.screenshot({ path: "test-results/stitchshop-repairs.png", fullPage: true });

  // Ending the partnership: both shops see it (and this install is free to leave the hub again).
  await r.goto(`/partners/${linkId}`);
  await r.locator("#note").fill("End of the test");
  await r.getByRole("button", { name: "End partnership" }).click();
  await expect(r.getByText("Partnership ended", { exact: true })).toBeVisible();
  await sync(r);
  await s.goto(`/partners/${linkId}`);
  await expect(s.getByText(/partnership ended/)).toBeVisible();
});

// Hosting: the repair shop makes a code in its own StitchBench; the host adds the sewing shop from Companies with it.
test("a hosted sewing shop added from Companies with a partner code", async ({ browser }) => {
  const host = { shop: `Hosted Quilts ${run}`, name: "Lee Hosted", email: `lee.${run.toLowerCase()}@quilt.test`, password: "hosted-pass-1" };
  const r = await login(browser, repair);
  await r.goto("/partners");
  await r.locator("#repairCommissionPct").fill("12");
  await r.getByRole("button", { name: "Make partner code" }).click();
  const code = (await r.getByTestId("partner-code").textContent())!.trim();
  expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

  await r.goto("/companies");
  await r.locator("#c-shop").fill(host.shop);
  await r.locator("#c-kind").selectOption("retail");
  await r.locator("#c-name").fill(host.name);
  await r.locator("#c-email").fill(host.email);
  await r.locator("#c-pw").fill(host.password);
  await r.locator("#c-code").fill(code.toLowerCase());
  await r.getByRole("button", { name: "Create company" }).click();
  await expect(r.getByText("Company created")).toBeVisible();
  await sync(r);

  // The new shop is a sewing shop, already partnered on the offered terms; the repair shop sees it too.
  const s = await login(browser, host);
  await expect(s).toHaveURL(/\/register$/);
  await s.goto("/partners");
  await expect(s.locator("tr", { hasText: "E2E Test Shop" })).toContainText("12% on repairs");
  await r.goto("/partners");
  await expect(r.getByRole("link", { name: host.shop })).toBeVisible();
  // Tidy up: end it so the install can leave the hub in other tests.
  await r.getByRole("link", { name: host.shop }).click();
  await r.getByRole("button", { name: "End partnership" }).click();
  await expect(r.getByText("Partnership ended", { exact: true })).toBeVisible();
});
