// Retreats, trunk shows and other events (shop-features-round-2-design.md 4.5): the owner makes a retreat from Classes,
// "New retreat or event" (early-bird price, deposit, rooms and meals), signs Jane up with a single room, takes her deposit
// by card on the event's page, opens the room list; then a trunk show with a door price: "At the door", sells a ticket,
// checks someone in and draws a name, then "She's not here: draw again".
//   Runs on a TEST BUILD with Scheduling on for the company. Written against the code: expect label slips.
import { test, expect, type Page } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, newId, sql } from "./helpers";
import { setModule } from "./helpers/modules";

test.describe.configure({ mode: "serial" });

const PASSWORD = "e2e-password-1";
const company = `Ev ${RUN}`;
const owner = { email: `ev-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };
let shopId: string;
let admin: Page;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test.beforeAll(async ({ browser }) => {
  admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("retail");
  await admin.getByLabel("Owner's name").fill("Ev Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  await setModule(admin, company, "Scheduling", true);
  await insert("Customer", { id: newId(), shopId, name: `Jane Ev ${RUN}`, email: `jane-ev-${RUN.toLowerCase()}@customer.test`, notifyBy: "email" });
});

test.afterAll(async () => {
  if (!process.env.E2E_KEEP) await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
  await disconnect();
  await admin.context().close();
});

test("a retreat: early-bird, deposit, a single room, the room list", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/classes");
  await page.getByRole("link", { name: "New retreat or event" }).click();
  await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(`Fall Retreat ${RUN}`);
  await page.getByLabel("Price", { exact: true }).fill("395");
  await page.getByLabel("Seats").fill("20");
  await page.getByLabel("Early-bird price (optional)").fill("350");
  await page.getByLabel("Early-bird price until").fill(inDays(10));
  await page.getByLabel("Deposit each (optional)").fill("150");
  await page.getByLabel("Rooms, with any extra price").fill("Double, Single +120");
  await page.getByLabel("Meals, with any extra price").fill("All meals, None");
  await page.getByLabel("Date").fill(inDays(90));
  await page.getByRole("button", { name: "Create the event" }).click();
  await expect(page.getByRole("heading", { name: `Fall Retreat ${RUN}` })).toBeVisible();
  await expect(page.getByText(/Early-bird price \$350\.00/)).toBeVisible();

  await page.getByLabel("Find the customer").fill(`Jane Ev`);
  await page.getByRole("button", { name: new RegExp(`Jane Ev ${RUN}`) }).click();
  await page.getByLabel("Room", { exact: true }).selectOption("Single");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByText("Signed up")).toBeVisible();
  await expect(page.getByText(/Owes \$470\.00 of \$470\.00/).first()).toBeVisible();
  await page.getByRole("button", { name: "Take the deposit ($150.00)" }).click();
  await expect(page.getByText(/\$150\.00 taken/)).toBeVisible();
  await expect(page.getByText(/Owes \$320\.00 of \$470\.00/).first()).toBeVisible();

  await page.getByRole("link", { name: "Room and meal lists" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Room list: Fall Retreat ${RUN}`) })).toBeVisible();
  await expect(page.getByText("Single (1)")).toBeVisible();
});

test("a trunk show at the door: a ticket, check-in, the drawing", async ({ browser }) => {
  const page = await login(browser, owner);
  await page.goto("/classes/new?kind=EVENT");
  await page.getByLabel("Name", { exact: true }).fill(`Trunk Show ${RUN}`);
  await page.getByLabel("Price", { exact: true }).fill("10");
  await page.getByLabel("Seats").fill("50");
  await page.getByLabel("Price at the door (optional)").fill("15");
  await page.getByLabel("Date").fill(inDays(3));
  await page.getByRole("button", { name: "Create the event" }).click();
  await page.getByRole("link", { name: "At the door" }).click();
  await expect(page.getByText(/Nobody is signed up yet/)).toBeVisible();
  await page.getByLabel("New customer name").fill(`Dora Door ${RUN}`);
  await page.getByLabel("Phone").fill("555-300-1000");
  await page.getByRole("button", { name: "Sell the ticket" }).click();
  await expect(page.getByText(/Ticket sold to Dora Door/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Here (tap to undo)" })).toBeVisible();
  await page.getByLabel("The prize").fill("Fat quarter bundle");
  await page.getByRole("button", { name: "Draw a name" }).click();
  await expect(page.getByText(`Dora Door ${RUN}`).first()).toBeVisible();
});
