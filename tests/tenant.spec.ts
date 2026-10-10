// Tenant isolation: signed in as the second company's owner (E2E Other Shop, from scripts/e2e-setup.ts), every page,
// route and server action tried with the E2E shop's ids answers 404 or "not found", shows nothing of that shop's, and
// leaves its rows exactly as they were. The E2E shop's rows under attack are made here and taken away at the end; the
// other shop's own rows come from the setup script. The actions are replayed the way a crafted request would do it: the
// page's own action, with the other shop's id swapped into the request body (helpers.ts withSwappedId).
import { test, expect, type Page } from "@playwright/test";
import { disconnect, expectRefused, insert, login, one, OTHER, OWNER, PNG, remove, RUN, shopOf, sql, withSwappedId } from "./helpers";

// What scripts/e2e-setup.ts calls the other shop's records.
const OTHER_SHOP = { customer: "Other Shop Customer", serial: "OTHER-0001", ticketNumber: 1, partNumber: "OTHER-001" };

type Ids = { customer: string; machine: string; ticket: string; line: string; payment: string; photo: string; part: string };

test.describe.configure({ mode: "serial" });

let page: Page;
let victim: Ids; // the E2E shop's rows
let own: Ids; // the other shop's rows
let before: string;

/** Everything about the E2E shop's rows that a leaked action could change. */
async function snapshot() {
  const [customer, machine, ticket, lines, payments, part, moves, photos] = await Promise.all([
    sql(`SELECT * FROM "Customer" WHERE id = $1`, [victim.customer]),
    sql(`SELECT * FROM "Machine" WHERE id = $1`, [victim.machine]),
    sql(`SELECT * FROM "Ticket" WHERE id = $1`, [victim.ticket]),
    sql(`SELECT * FROM "TicketLine" WHERE "ticketId" = $1 ORDER BY "createdAt", id`, [victim.ticket]),
    sql(`SELECT * FROM "Payment" WHERE "ticketId" = $1 ORDER BY "paidAt", id`, [victim.ticket]),
    sql(`SELECT * FROM "Part" WHERE id = $1`, [victim.part]),
    sql(`SELECT * FROM "StockMove" WHERE "partId" = $1 ORDER BY "createdAt", id`, [victim.part]),
    sql(`SELECT id, caption, kind, "ticketId" FROM "MachinePhoto" WHERE "machineId" = $1 OR "ticketId" = $2 ORDER BY "createdAt", id`, [victim.machine, victim.ticket]),
  ]);
  return JSON.stringify({ customer, machine, ticket, lines, payments, part, moves, photos });
}

test.beforeAll(async ({ browser }) => {
  // The E2E shop's rows: a customer with a machine, a ticket with a line, a payment and a photo, and a part.
  const shopId = (await shopOf(OWNER)).shopId;
  const customer = await insert<{ id: string }>("Customer", { shopId, name: `Tenant Victim ${RUN}`, phone: "555-0199" });
  const machine = await insert<{ id: string }>("Machine", { shopId, brand: "Bernina", model: "770 QE", modelKey: "770QE", serial: `TEN${RUN}`, customerId: customer.id });
  const top = await one<{ max: number | null }>(`SELECT MAX(number) AS max FROM "Ticket" WHERE "shopId" = $1`, [shopId]);
  const ticket = await insert<{ id: string }>("Ticket", {
    shopId,
    number: (top?.max ?? 0) + 1,
    machineId: machine.id,
    customerId: customer.id,
    status: "ON_BENCH",
    problem: "Tenant test",
    accessories: [],
    accessoriesReturned: [],
    updatedAt: new Date(),
  });
  const line = await insert<{ id: string }>("TicketLine", { ticketId: ticket.id, kind: "SERVICE", description: "Tenant test service", qty: 1, unitPriceCents: 5000 });
  const payment = await insert<{ id: string }>("Payment", { ticketId: ticket.id, method: "CASH", amountCents: 1000, note: "Tenant test deposit" });
  const photo = await insert<{ id: string }>("MachinePhoto", { shopId, machineId: machine.id, ticketId: ticket.id, mime: "image/png", data: PNG, caption: "Tenant test photo" });
  const part = await insert<{ id: string }>("Part", {
    shopId,
    partNumber: `TEN-${RUN}`,
    description: "Tenant test part",
    qtyOnHand: 5,
    costCents: 500,
    priceCents: 900,
    altNumbers: [],
    numberKeys: [`TEN${RUN}`],
  });
  victim = { customer: customer.id, machine: machine.id, ticket: ticket.id, line: line.id, payment: payment.id, photo: photo.id, part: part.id };

  // The other shop's own rows, from the setup script.
  const otherShop = (await shopOf(OTHER)).shopId;
  expect(otherShop, "the other owner has a shop of its own").not.toBe(shopId);
  const t = await one<{ id: string; machineId: string }>(`SELECT id, "machineId" FROM "Ticket" WHERE "shopId" = $1 AND number = $2`, [otherShop, OTHER_SHOP.ticketNumber]);
  const c = await one<{ id: string }>(`SELECT id FROM "Customer" WHERE "shopId" = $1 AND name = $2`, [otherShop, OTHER_SHOP.customer]);
  const p = await one<{ id: string }>(`SELECT id FROM "Part" WHERE "shopId" = $1 AND "partNumber" = $2`, [otherShop, OTHER_SHOP.partNumber]);
  if (!t || !c || !p) throw new Error("The other shop's records are missing: run npm run e2e:setup");
  const l = await one<{ id: string }>(`SELECT id FROM "TicketLine" WHERE "ticketId" = $1 ORDER BY "createdAt" LIMIT 1`, [t.id]);
  const pay = await one<{ id: string }>(`SELECT id FROM "Payment" WHERE "ticketId" = $1 ORDER BY "paidAt" LIMIT 1`, [t.id]);
  const ph = await one<{ id: string }>(`SELECT id FROM "MachinePhoto" WHERE "machineId" = $1 ORDER BY "createdAt" LIMIT 1`, [t.machineId]);
  if (!l || !pay || !ph) throw new Error("The other shop's ticket has no line, payment or photo: run npm run e2e:setup");
  own = { customer: c.id, machine: t.machineId, ticket: t.id, line: l.id, payment: pay.id, photo: ph.id, part: p.id };

  before = await snapshot();
  page = await login(browser, OTHER);
});

test.afterAll(async () => {
  await page?.context().close();
  if (victim) {
    await remove("Ticket", victim.ticket); // its lines and payments go with it
    await remove("Machine", victim.machine); // and its photos
    await remove("Customer", victim.customer);
    await remove("Part", victim.part);
  }
  await disconnect();
});

test("the E2E shop's pages answer 404 by id, and its own pages open", async () => {
  const foreign = [`/tickets/${victim.ticket}`, `/tickets/${victim.ticket}/invoice`, `/machines/${victim.machine}`, `/customers/${victim.customer}`, `/parts/${victim.part}`];
  for (const url of foreign) {
    const r = await page.goto(url);
    expect(r?.status(), url).toBe(404);
    await expect(page.getByText("Tenant").first()).toHaveCount(0);
  }
  // A label sheet asked for with another shop's part id prints nothing of it.
  await page.goto(`/labels?id=${victim.part}&format=thermal`);
  await expect(page.locator(".label")).toHaveCount(0);
  await expect(page.getByText(`TEN-${RUN}`)).toHaveCount(0);
  // The same pages for the other shop's own rows are there (so the 404s above are the scoping, not a broken page).
  for (const url of [`/tickets/${own.ticket}`, `/machines/${own.machine}`, `/customers/${own.customer}`, `/parts/${own.part}`]) {
    const r = await page.goto(url);
    expect(r?.status(), url).toBe(200);
  }
});

test("the photo API neither serves nor takes photos for the E2E shop's rows", async () => {
  const mine = await page.request.get(`/api/photos/${own.photo}`);
  expect(mine.status()).toBe(200);
  expect(mine.headers()["content-type"]).toContain("image/png");
  const theirs = await page.request.get(`/api/photos/${victim.photo}`);
  expect(theirs.status()).toBe(404);
  expect((await theirs.body()).length).toBeLessThan(100);

  const file = { name: "m.png", mimeType: "image/png", buffer: PNG };
  const onTheirMachine = await page.request.post("/api/photos", { multipart: { machineId: victim.machine, file } });
  expect(onTheirMachine.status()).toBe(404);
  const onTheirTicket = await page.request.post("/api/photos", { multipart: { machineId: own.machine, ticketId: victim.ticket, file } });
  expect(onTheirTicket.status()).toBe(404);
  const onTheirMachineMyTicket = await page.request.post("/api/photos", { multipart: { machineId: victim.machine, ticketId: own.ticket, file } });
  expect(onTheirMachineMyTicket.status()).toBe(404);
  expect(await snapshot()).toBe(before);
});

test("ticket actions replayed with the E2E shop's ids are refused", async () => {
  await page.goto(`/tickets/${own.ticket}`);
  // The icon buttons have no accessible name (an icon and a title): by title.
  const button = (title: string) => page.locator(`button[title="${title}"]`).first();

  // The bill: a line and a payment, by their own ids.
  await withSwappedId(page, own.line, victim.line, async () => {
    await button("Remove line").click(); // one tap: removing a line has Undo, not a second tap
  });
  await expectRefused(page, "Line not found.");
  await withSwappedId(page, own.payment, victim.payment, async () => {
    await button("Remove payment").click(); // one tap: a cash payment's removal has Undo, not a second tap
  });
  await expectRefused(page, "Payment not found.");

  // The ticket, by its id: status, checklist, a payment, a fee, its text.
  await withSwappedId(page, own.ticket, victim.ticket, async () => {
    await page.locator("#status").selectOption("COLLECTED");
  });
  await expectRefused(page, "Ticket not found.");
  await expect(page.locator("#status")).toHaveValue("ON_BENCH");
  await page.reload();
  await withSwappedId(page, own.ticket, victim.ticket, async () => {
    await page.locator('input[id="chk-0"]').check();
  });
  await expectRefused(page, "Ticket not found.");
  await page.reload();
  await withSwappedId(page, own.ticket, victim.ticket, async () => {
    await page.locator("#amount").fill("5.00");
    await page.getByRole("button", { name: "Record payment" }).click();
  });
  await expectRefused(page, "Ticket not found.");
  await page.reload();
  await withSwappedId(page, own.ticket, victim.ticket, async () => {
    await page.locator('input[name="price"][aria-label="Amount"]').fill("5.00");
    await page.getByRole("button", { name: "Add", exact: true }).first().click();
  });
  await expectRefused(page, "Ticket not found.");
  await page.reload();
  await withSwappedId(page, own.ticket, victim.ticket, async () => {
    await page.locator("#diagnosis").fill(`Written from the other shop ${RUN}`);
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
  });
  await expectRefused(page, "Ticket not found.");

  // The photo, by its id.
  await page.reload();
  await withSwappedId(page, own.photo, victim.photo, async () => {
    await button("Delete photo").click(); // one tap: deleting a photo has Undo
  });
  await expectRefused(page, "Photo not found.");

  expect(await snapshot()).toBe(before);
  // The other shop's own rows weren't touched by the refusals either.
  expect((await one<{ status: string }>(`SELECT status FROM "Ticket" WHERE id = $1`, [own.ticket]))?.status).toBe("ON_BENCH");
  expect(await one(`SELECT id FROM "TicketLine" WHERE id = $1`, [own.line])).not.toBeNull();
  expect(await one(`SELECT id FROM "Payment" WHERE id = $1`, [own.payment])).not.toBeNull();
  expect(await one(`SELECT id FROM "MachinePhoto" WHERE id = $1`, [own.photo])).not.toBeNull();
});

test("machine, customer and part edits replayed with the E2E shop's ids are refused", async () => {
  await page.goto(`/machines/${own.machine}`);
  await withSwappedId(page, own.machine, victim.machine, async () => {
    await page.locator("#brand").fill("Written from the other shop");
    await page.getByRole("button", { name: "Save", exact: true }).click();
  });
  await expectRefused(page, "Machine not found.");

  await page.goto(`/customers/${own.customer}`);
  await withSwappedId(page, own.customer, victim.customer, async () => {
    await page.locator("#name").fill("Written from the other shop");
    await page.getByRole("button", { name: "Save", exact: true }).click();
  });
  await expectRefused(page, "Customer not found.");

  await page.goto(`/parts/${own.part}`);
  await withSwappedId(page, own.part, victim.part, async () => {
    await page.locator("#description").fill("Written from the other shop");
    await page.getByRole("button", { name: "Save", exact: true }).click();
  });
  await expectRefused(page, "Part not found.");
  await page.reload();
  await withSwappedId(page, own.part, victim.part, async () => {
    await page.getByLabel("Quantity received").fill("3");
    await page.getByRole("button", { name: "Receive", exact: true }).click();
  });
  await expectRefused(page, "Part not found.");

  expect(await snapshot()).toBe(before);
  expect((await one<{ brand: string }>(`SELECT brand FROM "Machine" WHERE id = $1`, [own.machine]))?.brand).toBe("Janome");
  expect((await one<{ name: string }>(`SELECT name FROM "Customer" WHERE id = $1`, [own.customer]))?.name).toBe(OTHER_SHOP.customer);
  const p = await one<{ description: string; qtyOnHand: number }>(`SELECT description, "qtyOnHand" FROM "Part" WHERE id = $1`, [own.part]);
  expect(p?.description).toBe("Bobbin case (other shop)");
  expect(p?.qtyOnHand).toBe(4);
});
