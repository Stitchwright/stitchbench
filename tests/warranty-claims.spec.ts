// Warranty claims (shop-features-round-2-design.md 9.1): a ticket line claimed from the maker charges nothing and starts
// a claim; Paperwork → Warranty claims shows it by maker; the claim is marked sent, then paid short.
// E2E_EMAIL / E2E_PASSWORD: the owner of the E2E shop (scripts/e2e-setup.ts). Rows made here are removed at the end.
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, shopOf, signIn, sql } from "./helpers";

test.afterAll(disconnect);

test("claim a line from the maker, send the claim, record a short payment", async ({ page }) => {
  const owner = await shopOf(OWNER);
  const machine = await insert<{ id: string }>("Machine", { shopId: owner.shopId, brand: `Claimco${RUN}`, model: "WC100", modelKey: "WC100" });
  const max = (await sql<{ n: number }>(`SELECT COALESCE(MAX(number), 0) + 1000 AS n FROM "Ticket" WHERE "shopId" = $1`, [owner.shopId]))[0].n;
  const ticket = await insert<{ id: string }>("Ticket", { shopId: owner.shopId, number: max, machineId: machine.id, updatedAt: new Date() });
  await insert("TicketLine", { ticketId: ticket.id, kind: "PART", description: `Hook ${RUN}`, qty: 1, unitPriceCents: 4500 });
  try {
    await signIn(page, OWNER);
    await page.goto(`/tickets/${ticket.id}`);
    await page.getByRole("button", { name: "Claim it from the maker" }).click();
    await expect(page.getByText(/Claimed from the maker/)).toBeVisible();
    await page.getByRole("link", { name: new RegExp(`claim #\\d+ to Claimco${RUN}`) }).click();

    await expect(page.getByRole("heading", { name: new RegExp(`Claim #\\d+ to Claimco${RUN}`) })).toBeVisible();
    await page.getByLabel("Their claim number (optional)").fill("BR-1");
    await page.getByRole("button", { name: "Mark it sent" }).click();
    await expect(page.getByText("Sent, waiting")).toBeVisible();
    await page.getByLabel("Amount ($)").fill("40");
    await page.getByRole("button", { name: "Record what came in" }).click();
    await expect(page.getByText("$5.00 short")).toBeVisible();

    await page.goto("/paperwork/warranty");
    await expect(page.getByRole("link", { name: `Claimco${RUN}` })).toBeVisible();
  } finally {
    await sql(`DELETE FROM "WarrantyClaim" WHERE "shopId" = $1 AND maker = $2`, [owner.shopId, `Claimco${RUN}`]);
    await sql(`DELETE FROM "Ticket" WHERE id = $1`, [ticket.id]);
    await sql(`DELETE FROM "Machine" WHERE id = $1`, [machine.id]);
  }
});
