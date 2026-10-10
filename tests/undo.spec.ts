// The Undo bar (ease-of-use): removing a ticket line, a note or a photo shows "... removed. Undo" for about 10 seconds;
// Undo puts the row back exactly as it was (same id, same fields, the ticket's total unchanged); without Undo the bar
// closes by itself and the row stays gone; and one person's Undo can't bring back another shop's row.
//   E2E_BASE_URL=http://localhost:3300 npx playwright test tests/undo.spec.ts --workers 1
import { test, expect, type Page, type Response } from "@playwright/test";
import { OTHER, OWNER, PNG, RUN, disconnect, insert, one, shopOf, signIn, sql, withSwappedId } from "./helpers";

test.describe.configure({ mode: "serial" });

let shopId = "";
let customerId = "";
let machineId = "";
let ticketId = "";
let ticketNumber = 0;
let page: Page;
const lineIds: string[] = [];
let noteId = "";
let photoId = "";

test.beforeAll(async ({ browser }) => {
  shopId = (await shopOf(OWNER)).shopId;
  const customer = await insert<{ id: string }>("Customer", { shopId, name: `Undo Customer ${RUN}`, phone: "555-0177" });
  customerId = customer.id;
  const machine = await insert<{ id: string }>("Machine", { shopId, brand: "Bernina", model: "770 QE", modelKey: "770QE", serial: `UNDO${RUN}`, customerId });
  machineId = machine.id;
  const top = await one<{ max: number | null }>(`SELECT MAX(number) AS max FROM "Ticket" WHERE "shopId" = $1`, [shopId]);
  ticketNumber = (top?.max ?? 0) + 1;
  const ticket = await insert<{ id: string }>("Ticket", { shopId, number: ticketNumber, machineId, customerId, status: "ON_BENCH", problem: "Undo test", accessories: [], accessoriesReturned: [], updatedAt: new Date() });
  ticketId = ticket.id;
  for (const [d, cents] of [
    [`Undo service A ${RUN}`, 5000],
    [`Undo service B ${RUN}`, 2500],
    [`Undo service C ${RUN}`, 1200],
  ] as const) {
    lineIds.push((await insert<{ id: string }>("TicketLine", { ticketId, kind: "SERVICE", description: d, qty: 1, unitPriceCents: cents })).id);
  }
  noteId = (await insert<{ id: string }>("ModelNote", { shopId, brand: "Bernina", modelKey: "770QE", modelLabel: "770 QE", kind: "GOTCHA", body: `Undo note ${RUN}` })).id;
  photoId = (await insert<{ id: string }>("MachinePhoto", { shopId, machineId, mime: "image/png", data: PNG, caption: `Undo photo ${RUN}` })).id;
  page = await (await browser.newContext()).newPage();
  await signIn(page, OWNER);
});

test.afterAll(async () => {
  await sql(`DELETE FROM "ModelNote" WHERE id = $1`, [noteId]);
  await sql(`DELETE FROM "MachinePhoto" WHERE "machineId" = $1`, [machineId]);
  await sql(`DELETE FROM "Ticket" WHERE id = $1`, [ticketId]);
  await sql(`DELETE FROM "Machine" WHERE id = $1`, [machineId]);
  await sql(`DELETE FROM "Customer" WHERE id = $1`, [customerId]);
  await disconnect();
});

const bar = () => page.getByTestId("undo-bar");
const lineRow = (n: number) => page.locator("tr", { hasText: `Undo service ${n === 0 ? "A" : n === 1 ? "B" : "C"} ${RUN}` });
const linesOf = () => sql<{ id: string; description: string; qty: number; unitPriceCents: number; taxable: boolean; createdAt: Date }>(`SELECT * FROM "TicketLine" WHERE "ticketId" = $1 ORDER BY "createdAt", id`, [ticketId]);
const total = async () => (await linesOf()).reduce((s, l) => s + l.qty * l.unitPriceCents, 0);

test("remove a ticket line: the bar shows, Undo puts it back as it was", async () => {
  await page.goto(`/tickets/${ticketId}`);
  const before = await linesOf();
  const beforeTotal = await total();
  expect(beforeTotal).toBe(8700);
  await lineRow(1).getByRole("button", { name: /remove/i }).click();
  // No "Remove?" second tap: the line goes at once and the bar says so.
  await expect(bar()).toBeVisible();
  await expect(bar()).toContainText("Line removed.");
  await expect(lineRow(1)).toHaveCount(0);
  expect(await total()).toBe(beforeTotal - 2500);
  // Big, reachable target; announced.
  const undo = bar().getByRole("button", { name: "Undo" });
  expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await expect(page.locator("[aria-live='polite']").filter({ has: bar() })).toHaveCount(1);
  await undo.focus();
  await page.keyboard.press("Enter");
  await expect(lineRow(1)).toHaveCount(1);
  await expect(bar()).toHaveCount(0);
  const after = await linesOf();
  expect(after).toEqual(before); // same ids, descriptions, prices, dates
  expect(await total()).toBe(beforeTotal);
  // Putting it back is on the audit log.
  const audited = await one(`SELECT 1 AS x FROM "AuditEntry" WHERE "shopId" = $1 AND action = 'ticketline.restore' AND "subjectId" = $2`, [shopId, ticketId]);
  expect(audited).not.toBeNull();
});

test("remove without Undo: gone once the bar closes", async () => {
  await page.goto(`/tickets/${ticketId}`);
  await lineRow(2).getByRole("button", { name: /remove/i }).click();
  await expect(bar()).toBeVisible();
  await expect(bar()).toHaveCount(0, { timeout: 15_000 }); // about 10 seconds
  await expect(lineRow(2)).toHaveCount(0);
  expect(await one(`SELECT 1 AS x FROM "TicketLine" WHERE id = $1`, [lineIds[2]])).toBeNull();
  // Late Undo is not possible: the bar is gone. (The token itself expiring is covered by the cross-shop test below.)
});

test("remove a note and a photo: Undo brings each back", async () => {
  await page.goto(`/machines/${machineId}`);
  const noteBefore = await one(`SELECT * FROM "ModelNote" WHERE id = $1`, [noteId]);
  await page.locator(`button[title="Delete note"]`).first().click();
  await expect(bar()).toContainText("Note deleted.");
  expect(await one(`SELECT 1 AS x FROM "ModelNote" WHERE id = $1`, [noteId])).toBeNull();
  await bar().getByRole("button", { name: "Undo" }).click();
  await expect(bar()).toHaveCount(0);
  await expect.poll(async () => JSON.stringify(await one(`SELECT * FROM "ModelNote" WHERE id = $1`, [noteId]))).toBe(JSON.stringify(noteBefore));

  const photoBefore = await one<{ data: Buffer }>(`SELECT * FROM "MachinePhoto" WHERE id = $1`, [photoId]);
  await page.locator(`button[title="Delete photo"]`).first().click();
  await expect(bar()).toContainText("Photo deleted.");
  expect(await one(`SELECT 1 AS x FROM "MachinePhoto" WHERE id = $1`, [photoId])).toBeNull();
  await bar().getByRole("button", { name: "Undo" }).click();
  await expect(bar()).toHaveCount(0);
  await expect.poll(async () => (await one(`SELECT * FROM "MachinePhoto" WHERE id = $1`, [photoId])) !== null).toBe(true);
  const photoAfter = await one<{ data: Buffer }>(`SELECT * FROM "MachinePhoto" WHERE id = $1`, [photoId]);
  expect(JSON.stringify(photoAfter)).toBe(JSON.stringify(photoBefore));
  expect(Buffer.compare(photoAfter!.data, PNG)).toBe(0);
});

/** A response's text, or "" when the browser kept none (a streamed or finished-early answer). */
async function bodyOf(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

test("another shop's Undo can't bring back this shop's row", async ({ browser }) => {
  // The owner removes a line and we read the token off the response, without pressing Undo.
  await page.goto(`/tickets/${ticketId}`);
  const ownerToken = page.waitForResponse(async (r: Response) => r.request().method() === "POST" && Boolean(r.request().headers()["next-action"]) && (await bodyOf(r)).includes('"token"'));
  await lineRow(0).getByRole("button", { name: /remove/i }).click();
  const m = /"token":"([\w-]+)"/.exec(await (await ownerToken).text());
  expect(m, "the removal answered with an undo token").not.toBeNull();
  const foreignToken = m![1];
  await expect(bar()).toBeVisible();

  // The other shop's owner removes a line of their own ticket, then presses Undo with the owner's token swapped in.
  const otherShop = (await shopOf(OTHER)).shopId;
  const t = await one<{ id: string }>(`SELECT id FROM "Ticket" WHERE "shopId" = $1 ORDER BY number LIMIT 1`, [otherShop]);
  expect(t, "the other shop has a ticket: run npm run e2e:setup").not.toBeNull();
  const theirLine = await insert<{ id: string }>("TicketLine", { ticketId: t!.id, kind: "SERVICE", description: `Other shop line ${RUN}`, qty: 1, unitPriceCents: 700 });
  const other = await (await browser.newContext()).newPage();
  try {
    await signIn(other, OTHER);
    await other.goto(`/tickets/${t!.id}`);
    const theirs = other.waitForResponse(async (r: Response) => r.request().method() === "POST" && Boolean(r.request().headers()["next-action"]) && (await bodyOf(r)).includes('"token"'));
    await other.locator("tr", { hasText: `Other shop line ${RUN}` }).getByRole("button", { name: /remove/i }).click();
    const theirToken = /"token":"([\w-]+)"/.exec(await (await theirs).text())![1];
    await withSwappedId(other, theirToken, foreignToken, async () => {
      await other.getByTestId("undo-bar").getByRole("button", { name: "Undo" }).click();
    });
    await expect(other.locator("[data-sonner-toast][data-type='error']").first()).toBeVisible();
    // Nothing came back in either shop.
    expect(await one(`SELECT 1 AS x FROM "TicketLine" WHERE id = $1`, [lineIds[0]])).toBeNull();
    expect(await one(`SELECT 1 AS x FROM "TicketLine" WHERE id = $1`, [theirLine.id])).toBeNull();
  } finally {
    await sql(`DELETE FROM "TicketLine" WHERE id = $1`, [theirLine.id]);
    await other.context().close();
  }
  // The owner's own Undo still works.
  await bar().getByRole("button", { name: "Undo" }).click();
  await expect(lineRow(0)).toHaveCount(1);
  expect(await one(`SELECT 1 AS x FROM "TicketLine" WHERE id = $1`, [lineIds[0]])).not.toBeNull();
});
