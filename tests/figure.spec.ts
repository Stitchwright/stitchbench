// Manual figures are drawn from the tech's own PDF. The folder picker can't be automated, so this
// puts one real manual in the browser's private file system (OPFS) and uses that as the "manuals folder".
// Needs MANUAL_PDF (a local PDF), MANUAL_BRAND, MANUAL_MODEL, and the E2E_* login.
import { test, expect } from "@playwright/test";
import { basename } from "node:path";

const pdf = process.env.MANUAL_PDF!;
const name = basename(pdf.split("\\").join("/"));
const brand = process.env.MANUAL_BRAND ?? "Janome";
const model = process.env.MANUAL_MODEL ?? "MC6700P";

test("draws a timing figure from the tech's own manual", async ({ page }) => {
  await page.addInitScript(() => {
    // stand-in for the real folder picker
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = () =>
      navigator.storage.getDirectory();
  });
  await page.route("**/__test/manual.pdf", (r) => r.fulfill({ path: pdf, contentType: "application/pdf" }));

  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(process.env.E2E_EMAIL!);
  await page.getByLabel("Password", { exact: true }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Bench" })).toBeVisible();

  await page.goto("/manuals");
  await page.evaluate(async (fileName) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("Janome", { create: true });
    const fh = await dir.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(await (await fetch("/__test/manual.pdf")).blob());
    await w.close();
  }, name);
  await page.getByRole("button", { name: "Connect manuals folder" }).click();
  await expect(page.getByText(/PDFs indexed/)).toBeVisible();

  await page.goto(`/models/${brand}/${model}`);
  await expect(page.getByRole("heading", { name: /Timing and adjustments/ })).toBeVisible();
  await expect(page.getByText(name).first()).toBeVisible();
  await page.getByRole("button", { name: "Show figure" }).first().click();
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  const w = await canvas.evaluate((c: HTMLCanvasElement) => c.width);
  expect(w).toBeGreaterThan(100);
  await canvas.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/figure.png", fullPage: false });
});
