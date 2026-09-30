// End-to-end smoke test of the bench workflow.
// E2E_EMAIL / E2E_PASSWORD must be a user of a throwaway shop (it creates records).
import { test, expect } from "@playwright/test";

const email = process.env.E2E_EMAIL!;
const password = process.env.E2E_PASSWORD!;
const serial = `E2E${Date.now().toString().slice(-6)}`;
// 1x1 PNG
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("check in, work, bill and review a machine", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Bench" })).toBeVisible();

  // A part to use later
  await page.goto("/parts");
  const pn = `E2E-${serial}`;
  await page.getByLabel("Part number", { exact: true }).fill(pn);
  await page.getByLabel("Description", { exact: true }).fill("Bobbin case (test)");
  await page.getByLabel("Fits models").fill("MC6700P");
  await page.getByLabel("Cost each ($)").fill("18.50");
  await page.getByLabel("Price each ($, blank = cost + markup)").fill("29.99");
  await page.getByLabel("Quantity on hand").fill("3");
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByText("3 on hand")).toBeVisible();

  // Intake
  await page.goto("/tickets/new");
  await page.getByLabel("New customer name").fill("E2E Customer");
  await page.getByLabel("Brand", { exact: true }).fill("Janome");
  await page.getByLabel("Model", { exact: true }).fill("MC6700P");
  await page.getByLabel("Serial number", { exact: true }).fill(serial);
  await page.getByLabel("Service", { exact: true }).selectOption({ index: 2 });
  await page.getByLabel("Problem reported", { exact: true }).fill("Skipping stitches");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Janome MC6700P/ })).toBeVisible();
  const ticketUrl = page.url();

  // Factory spec shown next to the readings
  await expect(page.getByText(/Factory: upper/)).toBeVisible();

  // Checklist
  const first = page.locator('input[id="chk-0"]');
  await first.check();
  await expect(page.getByText(/1\/\d+ done/)).toBeVisible();

  // Tension readings
  await page.getByLabel("Upper as found", { exact: true }).fill("40");
  await page.getByLabel("Upper as left", { exact: true }).fill("70");
  await page.getByLabel("Bobbin as left", { exact: true }).fill("12");
  await page.getByRole("button", { name: "Save tension readings" }).click();
  await expect(page.getByText("Readings saved")).toBeVisible();

  // Charges
  await page.getByLabel("Hours", { exact: true }).fill("0.5");
  await page.getByRole("button", { name: "Add labor" }).click();
  await expect(page.getByText("Repair labor")).toBeVisible();
  await page.getByLabel("Part", { exact: true }).fill(pn);
  await page.getByRole("button", { name: "Add part" }).click();
  await expect(page.getByText(`${pn} Bobbin case (test)`)).toBeVisible();

  // Photo
  await page.locator('input[type="file"][capture]').first().setInputFiles({ name: "m.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("Photo added")).toBeVisible();

  // Payment of the balance
  await page.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Payment recorded")).toBeVisible();

  // Status round trip: collected closes the ticket, on the bench opens it again (each saved, the page shows it).
  await page.locator("#status").selectOption("COLLECTED");
  await expect(page.getByText("Status: Collected by customer")).toBeVisible();
  await page.reload();
  await expect(page.locator("#status")).toHaveValue("COLLECTED");
  await page.locator("#status").selectOption("ON_BENCH");
  await expect(page.getByText("Status: On bench")).toBeVisible();

  // Accessories returned
  await page.getByLabel("Power cord", { exact: true }).check();
  await page.getByRole("button", { name: "Save returned" }).click();
  await expect(page.getByText(/1\/\d+ returned/)).toBeVisible();
  await page.screenshot({ path: "test-results/ticket.png", fullPage: true });

  // Machine page: photo, accessories, checklist, readings
  await page.getByRole("link", { name: "Machine history" }).click();
  await expect(page.getByText(`SN ${serial}`).first()).toBeVisible();
  await expect(page.getByRole("img", { name: "Check-in condition photo" })).toBeVisible();
  await expect(page.getByText("Service checklist (1/")).toBeVisible();
  await expect(page.getByText("returned").first()).toBeVisible();
  await page.screenshot({ path: "test-results/machine.png", fullPage: true });

  // Invoice
  await page.goto(ticketUrl + "/invoice");
  await expect(page.getByText("Balance due")).toBeVisible();

  // Stock went down
  await page.goto("/parts?q=" + pn);
  await expect(page.getByRole("cell", { name: "2", exact: true })).toBeVisible();

  // Specs search
  await page.goto("/specs?q=Tajima");
  await expect(page.getByText("120-140 g").first()).toBeVisible();

  // Sales log shows the payment
  await page.goto("/sales");
  await expect(page.getByText("E2E Customer").first()).toBeVisible();
});
