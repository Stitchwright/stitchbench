// The quilt planner (shop-features-round-2-design.md 5.3, no AI): a pattern's yardage typed once on its page, then
// Fabric → Plan a quilt: the pattern and size give the yards, a fabric from the shelf for each part, the pull list with
// its total, Add all to the sale (the register opens with the yards on it) and Make it a kit (the kit builder opens with
// the lines). A plain quilt works out its own yards.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.describe.configure({ mode: "serial" });

let shopId = "";
let patternId = "";
const bg = `Spec Cream ${RUN}`;
const focus = `Spec Navy ${RUN}`;

test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
  patternId = (await insert<{ id: string }>("Part", { shopId, partNumber: `QP-${RUN}`, numberKeys: [`QP${RUN}`], description: `Spec Easy Street ${RUN}`, kind: "PATTERN", qtyOnHand: 2, priceCents: 1400 })).id;
  await insert("Part", { shopId, partNumber: `QB-${RUN}`, numberKeys: [`QB${RUN}`], description: bg, kind: "FABRIC", unit: "yd", qtyOnHand: 10, priceCents: 1000, colorTags: ["cream"] });
  await insert("Part", { shopId, partNumber: `QF-${RUN}`, numberKeys: [`QF${RUN}`], description: focus, kind: "FABRIC", unit: "yd", qtyOnHand: 6, priceCents: 1200, colorTags: ["navy"] });
});

test.afterAll(async () => {
  await disconnect();
});

test("a pattern's yardage, typed once from its back", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto(`/parts/${patternId}`);
  await page.getByLabel("One size a line, as the back of the pattern says").fill("Throw: background 2 1/4 yd, focus 1 yd");
  await page.getByRole("button", { name: "Save the yardage" }).click();
  await expect(page.getByText("Saved 2 lines of yardage.")).toBeVisible();
  await page.getByLabel("One size a line, as the back of the pattern says").fill("Throw: background a little");
  await page.getByRole("button", { name: "Save the yardage" }).click();
  await expect(page.getByText(/couldn't be read/)).toBeVisible();
});

test("plan from the pattern: the pull list, the register and the kit builder", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto(`/fabric/quilt?pattern=${patternId}`);
  await expect(page.getByRole("heading", { name: "Plan a quilt" })).toBeVisible();
  await expect(page.getByLabel("Yards needed")).toContainText("background: 2 1/4 yd");
  await page.getByLabel("Find a fabric (name, number, collection or color)").fill(RUN.toLowerCase());
  await page.getByLabel("background (2 1/4 yd)").selectOption({ label: new RegExp(bg) });
  await page.getByLabel("focus (1 yd)").selectOption({ label: new RegExp(focus) });
  const list = page.getByRole("table", { name: "Pull list" });
  await expect(list).toContainText(bg);
  // 2 1/4 x $10 + 1 x $12 + the pattern $14
  await expect(list).toContainText("$48.50");
  await page.getByRole("link", { name: "Make it a kit" }).click();
  await expect(page.getByRole("heading", { name: "New kit" })).toBeVisible();
  await expect(page.getByLabel(/Pattern item/)).toHaveValue(`QP-${RUN}`);
  await page.goBack();
  await page.getByLabel("background (2 1/4 yd)").selectOption({ label: new RegExp(bg) });
  await page.getByLabel("focus (1 yd)").selectOption({ label: new RegExp(focus) });
  await page.getByRole("link", { name: "Add all to the sale" }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByText(bg).first()).toBeVisible();
  await expect(page.getByText(focus).first()).toBeVisible();
});

test("a plain quilt works out its own yards", async ({ page }) => {
  await signIn(page, OWNER);
  await page.goto("/fabric/quilt");
  await page.getByText("A plain quilt").click();
  await page.getByLabel("Quilt size").selectOption("throw");
  await page.getByLabel("Block size (inches, finished)").fill("6");
  await page.getByLabel("Fabrics in the blocks").fill("4");
  await expect(page.getByText("10 blocks across and 12 down (120 blocks)")).toBeVisible();
  await expect(page.getByLabel("Yards needed")).toContainText("Focus: 1 1/8 yd");
  await expect(page.getByLabel("Yards needed")).toContainText("Backing: 3 7/8 yd");
});
