// Fabric Smarts (fabric-smarts-design.md): a bolt end cut into fat quarters, a whole collection added at once, slow fabric
// marked down (and the markdown undone), a reorder suggestion turned into a purchase order that is sent and received,
// and a kit made from a fabric. The fabric itself is made in the database (dated as needed); every step is done in the browser.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop; the spec turns counter sales on in the database.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, one, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);
test.describe.configure({ mode: "serial" });

const DAY = 86_400_000;
const code = (s: string) => `${s}${RUN}`.replace(/[^A-Z0-9]/gi, "").toUpperCase();

let shopId = "";
test.beforeAll(async () => {
  shopId = (await shopOf(OWNER)).shopId;
  await sql(`UPDATE "Shop" SET "sellsRetail" = true WHERE id = $1`, [shopId]);
});

async function fabric(pn: string, o: { qty: number; priceCents?: number; costCents?: number; ageDays?: number; supplier?: string; boltYards?: number; collection?: string }) {
  const created = new Date(Date.now() - (o.ageDays ?? 0) * DAY);
  const p = await insert<{ id: string }>("Part", {
    shopId,
    partNumber: pn,
    numberKeys: [pn],
    description: `Spec ${pn}`,
    kind: "FABRIC",
    unit: "yd",
    brand: "Spec Maker",
    collection: o.collection ?? "Spec Collection",
    priceCents: o.priceCents ?? 1200,
    costCents: o.costCents ?? 600,
    qtyOnHand: o.qty,
    supplier: o.supplier ?? null,
    boltYards: o.boltYards ?? 15,
    inPrint: "YES",
    createdAt: created,
    updatedAt: created,
  }).catch(async () =>
    insert<{ id: string }>("Part", { shopId, partNumber: pn, numberKeys: [pn], description: `Spec ${pn}`, kind: "FABRIC", unit: "yd", brand: "Spec Maker", collection: o.collection ?? "Spec Collection", priceCents: o.priceCents ?? 1200, costCents: o.costCents ?? 600, qtyOnHand: o.qty, supplier: o.supplier ?? null, boltYards: o.boltYards ?? 15, inPrint: "YES", createdAt: created }),
  );
  return p.id;
}

test("a bolt end cut into fat quarters", async ({ page }) => {
  const pn = code("BE");
  const id = await fabric(pn, { qty: 1 });
  await signIn(page, OWNER);
  await page.goto("/fabric");
  const row = page.getByRole("list", { name: "Bolt ends" }).getByRole("listitem").filter({ hasText: pn });
  await expect(row).toContainText("1 yd");
  await row.getByRole("button", { name: /^Cut into 4 fat quarters/ }).click();
  await expect(row).toHaveCount(0);
  const part = await one<{ qtyOnHand: number; fatQuarterId: string | null }>(`SELECT "qtyOnHand", "fatQuarterId" FROM "Part" WHERE id = $1`, [id]);
  expect(part?.qtyOnHand).toBe(0);
  expect(part?.fatQuarterId).toBeTruthy();
  const fq = await one<{ qtyOnHand: number }>(`SELECT "qtyOnHand" FROM "Part" WHERE id = $1`, [part!.fatQuarterId]);
  expect(fq?.qtyOnHand).toBe(4);
});

test("add a collection", async ({ page }) => {
  const a = code("CA");
  const b = code("CB");
  await signIn(page, OWNER);
  await page.goto("/fabric/collection");
  await page.getByLabel("Maker", { exact: true }).fill("Spec Maker");
  await page.getByLabel("Collection", { exact: true }).fill(`Spec Meadow ${RUN}`);
  await page.getByLabel("Designer", { exact: true }).fill("A. Designer");
  await page.getByLabel("Row 1 item number").fill(a);
  await page.getByLabel("Row 1 color").fill("Sky");
  await page.getByLabel("Row 1 yards received").fill("15");
  await page.getByLabel("Row 1 price per yard").fill("12.50");
  await page.getByLabel("Row 2 item number").fill(b);
  await page.getByLabel("Row 2 color").fill("Rose");
  await page.getByLabel("Row 2 yards received").fill("7.5");
  await page.getByLabel("Row 2 price per yard").fill("12.50");
  await page.getByRole("button", { name: "Add the collection" }).click();
  await expect(page).toHaveURL(/\/fabric$/);
  const rows = await sql<{ partNumber: string; qtyOnHand: number; collection: string; priceCents: number }>(`SELECT "partNumber", "qtyOnHand", collection, "priceCents" FROM "Part" WHERE "shopId" = $1 AND "partNumber" IN ($2, $3) ORDER BY "partNumber"`, [shopId, a, b]);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.qtyOnHand).sort((x, y) => x - y)).toEqual([7.5, 15]);
  expect(rows.every((r) => r.collection === `Spec Meadow ${RUN}` && r.priceCents === 1250)).toBe(true);
  // The same number again stops the whole add.
  await page.goto("/fabric/collection");
  await page.getByLabel("Maker", { exact: true }).fill("Spec Maker");
  await page.getByLabel("Collection", { exact: true }).fill("Again");
  await page.getByLabel("Row 1 item number").fill(a);
  await page.getByLabel("Row 1 color").fill("Sky");
  await page.getByLabel("Row 1 price per yard").fill("12.50");
  await page.getByRole("button", { name: "Add the collection" }).click();
  await expect(page.locator("[data-sonner-toast][data-type='error']").filter({ hasText: "already in inventory" }).first()).toBeVisible();
});

test("slow fabric: mark down, then undo", async ({ page }) => {
  const pn = code("SL");
  const id = await fabric(pn, { qty: 40, priceCents: 1000, costCents: 500, ageDays: 400 });
  await signIn(page, OWNER);
  await page.goto("/fabric?tab=slow");
  const row = page.getByRole("list", { name: "Slow fabric" }).getByRole("listitem").filter({ hasText: pn });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^Mark down \d+% to \$/ }).click();
  await expect(row).toContainText(/marked down 1 of 3/);
  const marked = await one<{ priceCents: number }>(`SELECT "priceCents" FROM "Part" WHERE id = $1`, [id]);
  expect(marked!.priceCents).toBeLessThan(1000);
  // Undo (the same day): a first tap asks, the second does it.
  const undo = row.getByRole("button", { name: /^Undo markdown/ });
  await undo.click();
  await undo.click();
  await expect(row).not.toContainText(/marked down/);
  expect((await one<{ priceCents: number }>(`SELECT "priceCents" FROM "Part" WHERE id = $1`, [id]))!.priceCents).toBe(1000);
});

test("reorder: a suggestion becomes a purchase order, sent and received", async ({ page }) => {
  const pn = code("RO");
  const supplier = `Spec Supplier ${RUN}`;
  const id = await fabric(pn, { qty: 3, supplier, ageDays: 70, collection: `Reorder ${RUN}` });
  // Bought 15 yards 70 days ago; 12 yards sold since, a little most days over the last three weeks.
  await sql(`INSERT INTO "StockMove" (id, "shopId", "partId", qty, reason, "createdAt") VALUES ($1, $2, $3, 15, 'RECEIVED', $4)`, [`mv${RUN}ro`.toLowerCase(), shopId, id, new Date(Date.now() - 70 * DAY)]);
  let n = (await one<{ n: number }>(`SELECT COALESCE(MAX(number), 0)::int AS n FROM "Sale" WHERE "shopId" = $1`, [shopId]))!.n;
  for (let d = 1; d <= 12; d++) {
    n += 1;
    const when = new Date(Date.now() - d * 1.5 * DAY);
    const sale = await insert<{ id: string }>("Sale", { shopId, number: n, subtotalCents: 1200, taxCents: 0, totalCents: 1200, taxRatePct: 0, createdAt: when });
    await insert("SaleLine", { saleId: sale.id, partId: id, description: `Spec ${pn}`, qty: 1, unit: "yd", unitPriceCents: 1200, costCents: 600, taxable: true, kind: "FABRIC" });
  }
  await signIn(page, OWNER);
  await page.goto("/fabric?tab=reorder");
  await page.getByLabel(`Order ${pn}`).check();
  await page.getByRole("button", { name: "Add ticked fabric to draft orders" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: pn }).getByText(/on a draft order/)).toBeVisible();
  await page.reload();
  await page.getByRole("row").filter({ hasText: supplier }).getByRole("link").first().click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`to ${supplier}`) })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /^Send order/ }).first().click();
  await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();
  // Receive what came: the field starts at what is outstanding.
  const got = page.getByLabel("Yards that came");
  await expect(got).toBeVisible();
  const outstanding = Number(await got.inputValue());
  expect(outstanding).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Receive these yards" }).click();
  await expect.poll(async () => (await one<{ qtyOnHand: number }>(`SELECT "qtyOnHand" FROM "Part" WHERE id = $1`, [id]))!.qtyOnHand).toBeCloseTo(3 + outstanding, 3);
  await expect(page.locator(".pill", { hasText: "Received" }).first()).toBeVisible();
});

test("make a kit from a fabric", async ({ page }) => {
  const pn = code("KT");
  const id = await fabric(pn, { qty: 10, priceCents: 1000, costCents: 500 });
  await signIn(page, OWNER);
  await page.goto("/fabric/kits/new");
  const name = `Spec Kit ${RUN}`;
  await page.getByLabel("Kit name").fill(name);
  await page.getByLabel("Fabric or notion (item number)").first().fill(pn);
  await page.getByLabel("Amount (yards or units)").first().fill("1.5");
  await page.getByLabel("...or where it comes from").fill("Spec pattern, own design");
  await page.getByLabel(/^Kit price/).fill("29.00");
  await page.getByRole("button", { name: "Make the kit recipe" }).click();
  await expect(page).toHaveURL(/\/fabric\/kits\/[a-z0-9]+$/);
  await page.getByLabel("Make this many kits").fill("2");
  await page.getByRole("button", { name: "Make kits" }).click();
  await expect(page.getByText(/2 in stock; the shelf/)).toBeVisible();
  expect((await one<{ qtyOnHand: number }>(`SELECT "qtyOnHand" FROM "Part" WHERE id = $1`, [id]))!.qtyOnHand).toBe(7);
});
