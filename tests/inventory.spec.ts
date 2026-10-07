// Inventory: barcode labels, the scanner station (look up, receive, count, use on a ticket) and most-used parts.
// The community most-used list needs a test StitchHub: HUB_URL + HUB_JOIN_KEY (skipped otherwise).
import { test, expect } from "@playwright/test";

const run = Date.now().toString(36).toUpperCase();
const pn = `INV-${run}`;
const alt = `ALT-${run}`;
test.setTimeout(240_000);

test("labels, scanner and most-used parts", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(process.env.E2E_EMAIL ?? "e2e@stitchbench.test");
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();

  // A supply with another number it's sold under.
  await page.goto("/parts");
  await page.locator("#partNumber").fill(pn);
  await page.locator("#description").fill("Test bobbins, class 15");
  await page.locator("#kind").selectOption("SUPPLY");
  await page.locator("#altNumbers").fill(alt);
  await page.locator("#location").fill("A1");
  await page.locator("#price").fill("3.00");
  await page.locator("#qtyOnHand").fill("2");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(pn) })).toBeVisible();
  const partId = page.url().split("/").pop()!;

  // Labels: a barcode of the part number on a sheet and on a thermal label.
  await page.goto(`/labels?id=${partId}&format=sheet&price=1`);
  await expect(page.locator(".label svg").first()).toBeVisible();
  await expect(page.locator(".label .pn").first()).toHaveText(pn);
  await expect(page.locator(".label").first()).toContainText("$3.00");
  await page.goto(`/labels?id=${partId}&format=thermal&copies=2`);
  await expect(page.locator(".label")).toHaveCount(2);
  await page.screenshot({ path: "test-results/labels-thermal.png" });

  // Scanner: the box takes keyboard-wedge input (type + Enter), like a USB scanner.
  await page.goto("/parts/scan");
  const box = page.locator("#scan-code");
  await box.fill(pn);
  await box.press("Enter");
  await expect(page.getByText(`${pn}: 2 on hand, bin A1`)).toBeVisible();
  await page.getByRole("tab", { name: "Receive" }).click();
  await page.locator("#scan-qty").fill("3");
  await box.fill(alt); // its other number finds it too
  await box.press("Enter");
  await expect(page.getByText(`+3 received: ${pn} (now 5)`)).toBeVisible();
  await page.getByRole("tab", { name: "Count shelf" }).click();
  for (let i = 0; i < 4; i++) {
    await box.fill(pn);
    await box.press("Enter");
    await expect(page.getByText(`counted ${i + 1}`)).toBeVisible();
    await page.waitForTimeout(1600); // the same code twice within 1.5 s counts once (camera debounce)
  }
  await page.getByRole("button", { name: "Save counts" }).click();
  await expect(page.getByText("Saved 1 count")).toBeVisible();
  await page.getByRole("tab", { name: "Use on ticket" }).click();
  // The newest open ticket is the default; other specs leave a vacuum ticket (its module off) at the top, which is read-only. Pick a repair ticket.
  const bench = await page.locator("#scan-ticket option", { hasText: "Janome MC6700P" }).first().getAttribute("value");
  await page.locator("#scan-ticket").selectOption(bench!);
  await page.locator("#scan-qty").fill("1");
  await box.fill(pn);
  await box.press("Enter");
  await expect(page.getByText(new RegExp(`1 × ${pn} added to ticket #\\d+ \\(3 left\\)`))).toBeVisible();
  await box.fill(`NOPE-${run}`);
  await box.press("Enter");
  await expect(page.getByText(`NOPE-${run} isn't in your parts.`)).toBeVisible();
  await expect(page.getByRole("link", { name: "add as a new part" })).toHaveAttribute("href", `/parts?new=NOPE-${run}#add`);
  await page.screenshot({ path: "test-results/scan-station.png", fullPage: true });

  // Most used in this shop.
  await page.goto("/parts/most-used");
  const row = page.locator("tr", { has: page.getByRole("link", { name: pn }) });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(1)).toHaveText("1");

  // A supplier's line sheet pasted from Excel: columns are recognised from the header row.
  await page.goto("/parts/import");
  const upc = `04427${String(Date.now()).slice(-7)}`;
  const sheet = [
    ["SKU", "UPC", "Description", "Wholesale", "Retail", "Qty"],
    [`CL-${run}`, upc, "Seam ripper", "4.10", "$8.25", "6"],
    [`OL-${run}`, "", "Rotary blades 45mm, 5 pack", "12.00", "21.99", "3"],
  ]
    .map((r) => r.join("\t"))
    .join("\n");
  await page.locator("#paste").fill(sheet);
  await expect(page.locator("#map-partNumber")).toHaveValue("0");
  await expect(page.locator("#map-barcode")).toHaveValue("1");
  await expect(page.locator("#map-cost")).toHaveValue("3");
  await expect(page.getByRole("table", { name: "Preview" })).toContainText("$8.25");
  await page.getByRole("button", { name: "Import 2 items" }).click();
  await expect(page.getByText("Imported: 2 added, 0 updated, 0 skipped").first()).toBeVisible();
  await page.goto(`/parts?q=CL-${run}`);
  await expect(page.getByRole("link", { name: `CL-${run}` })).toBeVisible();
  // The shop's own records as a spreadsheet (Settings -> Your data).
  const exp = await page.request.get("/api/export/inventory");
  expect(exp.status()).toBe(200);
  expect(exp.headers()["content-type"]).toContain("text/csv");
  expect(await exp.text()).toContain(`CL-${run},${upc},Seam ripper`);

  // Most used across the community (after this shop reports its counts to the hub).
  if (process.env.HUB_URL) {
    // Counts go to the hub only once the shop offers them.
    await page.goto("/parts/most-used");
    const offer = page.getByRole("button", { name: "Offer our counts" });
    if (await offer.count()) {
      await offer.click();
      await expect(page.getByRole("button", { name: "Stop offering our counts" })).toBeVisible();
    }
    await page.goto("/settings");
    await expect(page.getByText(/Connected to/)).toBeVisible();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Synced with the hub")).toBeVisible({ timeout: 180_000 });
    await page.goto("/parts/most-used?view=community");
    await expect(page.getByText(pn)).toBeVisible();
    await page.screenshot({ path: "test-results/most-used-community.png", fullPage: true });
  }
});

test("the same part new and used, and condition columns on import and export", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(process.env.E2E_EMAIL ?? "e2e@stitchbench.test");
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^(Bench|E2E Test Shop)$/ })).toBeVisible();

  // A number in stock new, then the same number used: a second item, "<number> (used)", that a scan finds too.
  const tw = `TW-${run}`;
  await page.goto("/parts");
  await page.locator("#partNumber").fill(tw);
  await page.locator("#description").fill("Twin test bobbin case");
  await page.locator("#qtyOnHand").fill("2");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByRole("heading", { name: tw })).toBeVisible();
  await page.goto("/parts");
  await page.locator("#partNumber").fill(tw);
  await page.locator("#description").fill("Twin test bobbin case from a donor machine");
  await page.locator("#condition").selectOption("USED");
  await page.locator("#qtyOnHand").fill("1");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByRole("heading", { name: `${tw} (used)` })).toBeVisible();
  await page.goto("/parts/scan");
  const box = page.locator("#scan-code");
  await box.fill(`${tw} (used)`);
  await box.press("Enter");
  await expect(page.getByText(`${tw} (used): 1 on hand`)).toBeVisible();
  await box.fill(tw);
  await box.press("Enter");
  await expect(page.getByText(`${tw}: 2 on hand`)).toBeVisible();

  // The list tags the used one, and both labels filter it.
  await page.goto(`/parts?q=${tw}`);
  await expect(page.getByRole("link", { name: tw, exact: true })).toBeVisible();
  const usedRow = page.locator("tr", { has: page.getByRole("link", { name: `${tw} (used)` }) });
  await expect(usedRow).toContainText("Used");
  await page.goto(`/parts?q=${tw}&condition=USED`);
  await expect(page.getByRole("link", { name: `${tw} (used)` })).toBeVisible();
  await expect(page.getByRole("link", { name: tw, exact: true })).toHaveCount(0);
  await page.goto(`/parts?q=${tw}&origin=COMPATIBLE`);
  await expect(page.getByRole("link", { name: `${tw} (used)` })).toHaveCount(0);

  // A sheet with Condition and Made by columns.
  await page.goto("/parts/import");
  const imp = `IMPC-${run}`;
  const sheet = [
    ["SKU", "Description", "Qty", "Condition", "Made by"],
    [`${imp}A`, "Imported screen", "2", "Used", "Aftermarket"],
    [`${imp}B`, "Imported knob", "1", "New", "3D printed"],
  ]
    .map((r) => r.join("\t"))
    .join("\n");
  await page.locator("#paste").fill(sheet);
  await expect(page.locator("#map-condition")).toHaveValue("3");
  await expect(page.locator("#map-origin")).toHaveValue("4");
  await page.getByRole("button", { name: "Import 2 items" }).click();
  await expect(page.getByText("Imported: 2 added, 0 updated, 0 skipped").first()).toBeVisible();
  await page.goto(`/parts?q=${imp}`);
  await expect(page.locator("tr", { has: page.getByRole("link", { name: `${imp}A` }) })).toContainText("Compatible");
  await expect(page.locator("tr", { has: page.getByRole("link", { name: `${imp}B` }) })).toContainText("3D printed");

  // The shop's records as a spreadsheet carry the condition, who made it and the shop number.
  const exp = await (await page.request.get("/api/export/inventory")).text();
  expect(exp.split("\n")[0]).toContain("condition,made_by,shop_number");
  expect(exp).toContain(`${tw} (used),${tw},`);
  expect(exp).toMatch(new RegExp(`${imp}A,.*,Used,Compatible,`));
});
