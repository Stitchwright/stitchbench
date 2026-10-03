// The test-mode card (handoff item 15): a Brother NV1500D's machine page shows both of its modes (test mode, touch panel
// calibration) with the steps, the tests and the manual page, and its timing row's "test mode 36" links to test 36 in the
// card; /specs lists the test modes. Needs the test modes loaded (npm run db:seed) and the E2E logins (npm run e2e:setup).
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, remove, shopOf, signIn } from "./helpers";

test.afterAll(disconnect);

test("the machine page shows the test-mode card, linked from the timing rows", async ({ page }) => {
  const { shopId } = await shopOf(OWNER);
  const customer = await insert<{ id: string }>("Customer", { shopId, name: `Test Mode ${RUN}` });
  const machine = await insert<{ id: string }>("Machine", { shopId, customerId: customer.id, brand: "Brother", model: "NV1500D", modelKey: "NV1500D" });
  try {
    await signIn(page, OWNER);
    await page.goto(`/machines/${machine.id}`);
    const card = page.locator("section#test-mode");
    await expect(card.getByRole("heading", { name: "Test modes (2)" })).toBeVisible();
    await expect(card.getByRole("heading", { name: "Test mode", exact: true })).toBeVisible();
    await expect(card.getByRole("heading", { name: "Touch panel calibration" })).toBeVisible();
    await expect(card.getByRole("heading", { name: "To enter" }).first()).toBeVisible();
    await expect(card.getByRole("heading", { name: "To leave" }).first()).toBeVisible();
    await expect(card.getByRole("heading", { name: /^Tests \(\d+\)$/ }).first()).toBeVisible();
    const test36 = card.getByRole("row").filter({ has: page.getByRole("cell", { name: "36", exact: true }) });
    await expect(test36).toHaveCount(1);

    // A timing row's "test mode 36" goes to that test in the card.
    const link = page.getByRole("link", { name: "test mode 36" }).first();
    await expect(link).toHaveAttribute("href", /^#sm-[0-9a-f]+-t\d+$/);
    await link.click();
    await expect(page).toHaveURL(/#sm-[0-9a-f]+-t\d+$/);
    await expect(test36).toBeInViewport();

    // The list on /specs, searchable by model.
    await page.goto("/specs?tab=modes&q=NV1500D");
    await expect(page.getByRole("heading", { name: "Touch panel calibration" })).toBeVisible();
  } finally {
    await remove("Machine", machine.id);
    await remove("Customer", customer.id);
  }
});
