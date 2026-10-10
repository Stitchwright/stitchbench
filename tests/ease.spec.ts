// What's new, Getting started and our answers in Help (docs/plans/ease-of-use-design.md sections 2 to 4). The test app
// needs no hub: the rows a sync would have made are put in with SQL. A new company with its own owner is made for the run
// (copying the E2E owner's password), so "no customers yet" is true and nothing of the shared E2E shop is touched.
//   E2E_BASE_URL=http://localhost:3300 npx playwright test tests/ease.spec.ts --workers 1
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, one, sql, type Login } from "./helpers";

test.describe.configure({ mode: "serial" });

const EMAIL = `ease-${RUN.toLowerCase()}@stitchbench.test`;
const WHO: Login = { email: EMAIL, password: OWNER.password };
let shopId = "";
let userId = "";

test.beforeAll(async () => {
  const owner = await one<{ passwordHash: string }>(`SELECT "passwordHash" FROM "User" WHERE email = $1`, [OWNER.email.toLowerCase()]);
  if (!owner) throw new Error("The E2E owner is missing: run npm run e2e:setup");
  const shop = await insert<{ id: string }>("Shop", { name: `Ease ${RUN}` });
  shopId = shop.id;
  // Made long ago, so it counts as someone who used the program before the card existed.
  const u = await insert<{ id: string }>("User", { shopId, email: EMAIL, name: "Ease Owner", passwordHash: owner.passwordHash, role: "OWNER", createdAt: new Date("2026-01-01T00:00:00Z") });
  userId = u.id;
});
test.afterAll(async () => {
  if (shopId) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
});

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(WHO.email);
  await page.getByLabel("Password", { exact: true }).fill(WHO.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
});

const seen = async () => (await one<{ whatsNewSeen: string | null }>(`SELECT "whatsNewSeen" FROM "User" WHERE id = $1`, [userId]))!.whatsNewSeen;

test("What's new shows once; Got it hides it for good", async ({ page }) => {
  await sql(`UPDATE "User" SET "whatsNewSeen" = '1.7.0' WHERE id = $1`, [userId]);
  await page.goto("/");
  const card = page.getByTestId("whats-new-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("New Help button")).toBeVisible();
  const got = card.getByRole("button", { name: "Got it" });
  expect((await got.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await got.click();
  await expect(card).toHaveCount(0);
  await expect.poll(seen).not.toBe("1.7.0");
  await page.reload();
  await expect(page.getByTestId("whats-new-card")).toHaveCount(0);
  // The page under Settings lists every version.
  await page.goto("/settings/whats-new");
  await expect(page.getByRole("heading", { name: "Version 1.7.1" })).toBeVisible();
});

test("a person made after the card shipped, with nothing recorded, gets no card", async ({ page }) => {
  await sql(`UPDATE "User" SET "whatsNewSeen" = NULL, "createdAt" = now() WHERE id = $1`, [userId]);
  await page.goto("/");
  await expect(page.getByTestId("whats-new-card")).toHaveCount(0);
  await expect.poll(seen).not.toBeNull();
  await sql(`UPDATE "User" SET "createdAt" = $2 WHERE id = $1`, [userId, new Date("2026-01-01T00:00:00Z")]);
});

test("a person made before it, with nothing recorded, sees 1.7.1 once", async ({ page }) => {
  await sql(`UPDATE "User" SET "whatsNewSeen" = NULL WHERE id = $1`, [userId]);
  await page.goto("/");
  await expect(page.getByTestId("whats-new-card")).toBeVisible();
});

test("Getting started: a tick changes after adding a customer; Hide this list hides it", async ({ page }) => {
  await sql(`UPDATE "Shop" SET "gettingStartedHiddenAt" = NULL WHERE id = $1`, [shopId]);
  await page.goto("/");
  const list = page.getByTestId("getting-started");
  await expect(list).toBeVisible();
  const first = page.getByTestId("start-customer");
  await expect(first).toHaveAttribute("data-done", "no");
  expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await insert("Customer", { shopId, name: `Ease Customer ${RUN}` });
  await page.reload();
  await expect(page.getByTestId("start-customer")).toHaveAttribute("data-done", "yes");
  await page.getByRole("button", { name: "Hide this list" }).click();
  await expect(page.getByTestId("getting-started")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("getting-started")).toHaveCount(0);
  const row = await one<{ gettingStartedHiddenAt: Date | null }>(`SELECT "gettingStartedHiddenAt" FROM "Shop" WHERE id = $1`, [shopId]);
  expect(row!.gettingStartedHiddenAt).not.toBeNull();
});

async function openHelp(page: Page) {
  await page.getByTestId("help-button").click();
  await expect(page.getByTestId("help-panel")).toBeVisible();
}

test("an answer shows a dot, shows in Help, and becomes read", async ({ page }) => {
  const now = Date.now();
  await insert("HelpReply", { shopId, hubId: `h-${RUN}-new`, kind: "idea", text: `Bigger print on tags ${RUN}`, reply: `Thank you, tags now print larger ${RUN}`, repliedAt: new Date(now - 60_000) });
  await insert("HelpReply", { shopId, hubId: `h-${RUN}-old`, kind: "help", text: `The list looked wrong ${RUN}`, reply: `Fixed in the last update ${RUN}`, repliedAt: new Date(now - 86_400_000), readAt: new Date(now - 3_600_000) });
  await page.goto("/customers");
  await expect(page.getByTestId("help-dot")).toBeVisible();
  await openHelp(page);
  const answers = page.getByTestId("help-answers");
  await expect(answers.getByText("We answered you")).toBeVisible();
  await expect(answers.getByText(`Thank you, tags now print larger ${RUN}`)).toBeVisible();
  // The older answer waits in the list.
  await page.getByTestId("help-history").getByText("Your notes and our answers").click();
  await expect(page.getByTestId("help-history").getByText(`Fixed in the last update ${RUN}`)).toBeVisible();
  // Read now: marked in the database, and the dot is gone after a fresh page load.
  await expect.poll(async () => (await one<{ n: string }>(`SELECT count(*) AS n FROM "HelpReply" WHERE "shopId" = $1 AND "readAt" IS NULL`, [shopId]))!.n).toBe("0");
  await page.reload();
  await expect(page.getByTestId("help-dot")).toHaveCount(0);
  await openHelp(page);
  await expect(page.getByTestId("help-answers")).toHaveCount(0);
  await page.getByTestId("help-history").getByText("Your notes and our answers").click();
  await expect(page.getByTestId("help-history").getByText(`Thank you, tags now print larger ${RUN}`)).toBeVisible();
});

