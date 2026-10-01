// Switching a paid module on or off for a company from the Companies screen, as the platform admin (the e2e owner,
// who is in PLATFORM_ADMIN_EMAILS on the test server). modules-design.md section 8 fixes the labels.
import { expect, type Page } from "@playwright/test";

export type ModuleName = "Vac Shop" | "Small Appliance Repair" | "Scheduling" | "Marketing";

/**
 * `on` true: "Turn on" with an end date 30 days out (the test build signs it with the development key); false: "Turn
 * off". `company` is the company's name as the Companies select shows it.
 */
export async function setModule(page: Page, company: string, key: ModuleName, on: boolean, lastDay?: string) {
  await page.goto("/companies");
  await page.getByLabel("Company", { exact: true }).selectOption({ label: company });
  await page.getByLabel("Module", { exact: true }).selectOption({ label: key });
  if (on) await page.getByLabel("On until (blank: no end date)").fill(lastDay ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  await page.getByRole("button", { name: on ? "Turn on" : "Turn off", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

/** "Let keys decide": removes the administrator's switch so only the company's own keys count. */
export async function clearModuleSwitch(page: Page, company: string, key: ModuleName) {
  await page.goto("/companies");
  await page.getByLabel("Company", { exact: true }).selectOption({ label: company });
  await page.getByLabel("Module", { exact: true }).selectOption({ label: key });
  await page.getByRole("button", { name: "Let keys decide", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}
