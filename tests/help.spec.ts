// The Help button and the error alerts (docs/plans/help-feedback-design.md section 6), against the test hub on :3200
// (start_hub.bat) and the test app on :3300 (start_hubtest.bat, which sets HELP_TEST_ERRORS=1), the install joined to
// the hub. Open the panel; send "Something's wrong" with and without the picture, an idea and a rating; see each on the
// hub's admin API (GET /v1/admin/feedback). Then a test-only action throws twice: the hub has it once, with count 2,
// and without the phone or card number its message had.
//   HUB_URL=http://localhost:3200 HUB_ADMIN_TOKEN=... E2E_BASE_URL=http://localhost:3300 npx playwright test tests/help.spec.ts --workers 1
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, shopOf, sql } from "./helpers";

const HUB = (process.env.HUB_URL ?? "http://localhost:3200").replace(/\/+$/, "");
const ADMIN = process.env.HUB_ADMIN_TOKEN ?? "local-test-admin-token-123";

type Item = { id: string; kind: string; body?: Record<string, unknown> | null; count?: number; hasPicture?: boolean; picture?: unknown };

test.describe.configure({ mode: "serial" });

let shopId = "";
test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
});
test.afterAll(async () => {
  if (shopId) await sql(`DELETE FROM "HelpOutbox" WHERE "shopId" = $1 AND "createdAt" > now() - interval '1 hour' AND "payload"::text LIKE $2`, [shopId, `%${RUN}%`]);
  await disconnect();
});

/** The hub's feedback list as its admin sees it. */
async function hubItems(kind: string): Promise<Item[]> {
  const r = await fetch(`${HUB}/v1/admin/feedback?status=&kind=${kind}`, { headers: { authorization: `Bearer ${ADMIN}` } });
  expect(r.ok, `hub admin feedback list answered ${r.status}`).toBeTruthy();
  const j = (await r.json()) as Item[] | { items?: Item[]; feedback?: Item[] };
  return Array.isArray(j) ? j : (j.items ?? j.feedback ?? []);
}

/** The hub's row whose body mentions `tag`, once it has arrived (the program sends it in the background). */
async function arrived(kind: string, tag: string): Promise<Item> {
  let found: Item | undefined;
  await expect
    .poll(
      async () => {
        found = (await hubItems(kind)).find((i) => JSON.stringify(i.body ?? i).includes(tag));
        return Boolean(found);
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);
  return found!;
}

async function hasPicture(item: Item): Promise<boolean> {
  const r = await fetch(`${HUB}/v1/admin/feedback/${item.id}/picture`, { headers: { authorization: `Bearer ${ADMIN}` } });
  return r.ok && (r.headers.get("content-type") ?? "").startsWith("image/jpeg");
}

async function openHelp(page: Page, choice: RegExp) {
  await page.getByTestId("help-button").click();
  await expect(page.getByTestId("help-panel")).toBeVisible();
  await page.getByRole("button", { name: choice }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
});

test("the Help button opens three choices; not on print views", async ({ page }) => {
  await page.goto("/customers");
  await page.getByTestId("help-button").click();
  const panel = page.getByTestId("help-panel");
  for (const name of ["Something's wrong", "I have an idea", "Rate the program"]) await expect(panel.getByRole("button", { name })).toBeVisible();
  // Big targets: 48px at least.
  const box = await panel.getByRole("button", { name: "I have an idea" }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(48);
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await page.goto("/shifts/print");
  await expect(page.getByTestId("help-button")).toHaveCount(0);
});

test("Something's wrong, with the picture", async ({ page }) => {
  const tag = `HELPPIC${RUN}`;
  await page.goto("/customers");
  await openHelp(page, /Something's wrong/);
  await expect(page.getByAltText("The picture that will be sent")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("It may show customer details. Untick to leave it out.")).toBeVisible();
  await expect(page.getByLabel("Email me back at")).toHaveValue(OWNER.email);
  await page.getByLabel("What happened?").fill(`The list looks wrong ${tag}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("help-sent")).toContainText("It's on its way to the");
  const item = await arrived("help", tag);
  expect(item.kind).toBe("help");
  expect(JSON.stringify(item.body ?? item)).toContain('"path":"/customers"');
  expect(await hasPicture(item)).toBe(true);
});

test("Something's wrong, without the picture and no reply address", async ({ page }) => {
  const tag = `HELPNOPIC${RUN}`;
  await page.goto("/customers");
  await openHelp(page, /Something's wrong/);
  const tick = page.getByLabel("Include a picture of this screen");
  await expect(page.getByAltText("The picture that will be sent")).toBeVisible({ timeout: 20_000 });
  await tick.uncheck();
  await expect(page.getByAltText("The picture that will be sent")).toHaveCount(0);
  await page.getByLabel("Email me back at").fill("");
  await page.getByLabel("What happened?").fill(`Nothing to see ${tag}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("help-sent")).toBeVisible();
  const item = await arrived("help", tag);
  expect(await hasPicture(item)).toBe(false);
  expect(JSON.stringify(item.body ?? item)).not.toContain(OWNER.email);
});

test("I have an idea", async ({ page }) => {
  const tag = `IDEA${RUN}`;
  await page.goto("/");
  await openHelp(page, /I have an idea/);
  // Required: Send without words says so.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("help-sent")).toHaveCount(0);
  await page.getByLabel("What would make the program better for you?").fill(`Bigger print on tags ${tag}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("help-sent")).toBeVisible();
  const item = await arrived("idea", tag);
  expect(JSON.stringify(item.body ?? item)).toContain(OWNER.email);
});

test("Rate the program", async ({ page }) => {
  const tag = `RATE${RUN}`;
  await page.goto("/");
  await openHelp(page, /Rate the program/);
  await page.getByRole("button", { name: "4 stars" }).click();
  await page.getByLabel("Anything you'd like to tell us?").fill(`Lovely ${tag}`);
  await page.getByLabel("You may quote me with my shop's name").check();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("help-sent")).toBeVisible();
  const item = await arrived("rating", tag);
  const body = JSON.stringify(item.body ?? item);
  expect(body).toContain('"stars":4');
  expect(body).toContain('"quoteOk":true');
});

test("an error thrown twice reaches the hub once, counted 2, without customer data", async ({ page }) => {
  const tag = `ERR${RUN}`;
  for (let i = 0; i < 2; i++) {
    const r = await page.request.post(`/api/help/test-error?tag=${tag}`);
    expect(r.status(), "start the test app with HELP_TEST_ERRORS=1").toBe(500);
  }
  let rows: Item[] = [];
  await expect
    .poll(
      async () => {
        rows = (await hubItems("error")).filter((i) => JSON.stringify(i.body ?? i).includes(tag));
        return rows.length === 1 ? Number(rows[0].count) : -rows.length;
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] },
    )
    .toBe(2);
  const body = JSON.stringify(rows[0].body ?? rows[0]);
  expect(body).toContain("[phone]");
  expect(body).not.toContain("555-123-4567");
  expect(body).not.toContain("4111 1111");
  // The action's name isn't checked: a production build minifies function names (the page, from the Referer, says where).
  expect(body).toContain("Help test error");
});
