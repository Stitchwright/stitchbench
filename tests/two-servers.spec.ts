// Two servers on one database (scheduling-messaging-design.md 15.10, e2e-docs acceptance 2): 30 queued notices arrive
// in the sink exactly once each. Start the same test build twice against the same DATABASE_URL (ports 3500 and 3501,
// MESSAGE_WORKER_SECONDS=2, SMTP_ALLOW_HOSTS at the sink) and set E2E_SECOND_URL to the second one; without it the
// spec is skipped. The rows are queued straight into the outbox (the workers' claim is what is under test).
import { test, expect } from "@playwright/test";
import { OWNER, RUN, disconnect, insert, login, sql } from "./helpers";
import { setModule } from "./helpers/modules";
import { clearSink, eventually, sinkMessages } from "./helpers/messaging";

const PASSWORD = "e2e-password-1";
const SINK_SMTP = process.env.SMTP_SINK_PORT ?? "2525";
const SECOND = process.env.E2E_SECOND_URL;
const COUNT = 30;
const company = `Two ${RUN}`;
const owner = { email: `two-${RUN.toLowerCase()}@stitchbench.test`, password: PASSWORD };

test("30 queued notices go out exactly once across two servers", async ({ browser }) => {
  test.skip(!SECOND, "needs E2E_SECOND_URL (a second server on the same database)");
  test.setTimeout(300_000);
  const admin = await login(browser, OWNER);
  await admin.goto("/companies");
  await admin.getByLabel("Company name").fill(company);
  await admin.getByLabel("Kind of shop").selectOption("repair");
  await admin.getByLabel("Owner's name").fill("Two Owner");
  await admin.getByLabel("Owner's email (their login)").fill(owner.email);
  await admin.getByLabel("Temporary password (8+ characters)").fill(PASSWORD);
  await admin.getByRole("button", { name: "Create company" }).click();
  await expect(admin.getByText("Company created")).toBeVisible();
  const shopId = (await sql<{ id: string }>(`SELECT id FROM "Shop" WHERE name = $1`, [company]))[0].id;
  await setModule(admin, company, "Marketing", true);
  await admin.context().close();
  try {
    const page = await login(browser, owner);
    await page.goto("/settings/messages");
    await page.getByLabel("Send email", { exact: true }).check();
    await page.getByLabel("Provider").selectOption("other");
    await page.getByLabel("Mail server").fill("127.0.0.1");
    await page.getByLabel("Port").fill(SINK_SMTP);
    await page.getByLabel("Security").selectOption("none");
    await page.getByLabel("User name").fill("sink-user");
    await page.getByLabel("Password").fill("sink-secret-pass-77");
    await page.getByLabel("From address").fill(owner.email);
    await page.getByRole("button", { name: "Save email settings" }).click();
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
    // The second server answers too.
    expect((await page.request.get(`${SECOND}/login`)).status()).toBe(200);
    await page.context().close();

    await clearSink();
    const addresses = Array.from({ length: COUNT }, (_, i) => `two-${RUN.toLowerCase()}-${i}@customer.test`);
    const c = await insert<{ id: string }>("Customer", { shopId, name: `Two Customer ${RUN}`, email: addresses[0], notifyBy: "email" });
    for (const [i, address] of addresses.entries()) {
      await insert("OutMessage", { shopId, channel: "email", purpose: "notice", kind: "ready", customerId: c.id, address, subject: `Ready ${i}`, body: `Your machine is ready (${i}).`, status: "QUEUED", dedupeKey: `two:${RUN}:${i}`, sendAfter: new Date().toISOString() });
    }
    // Both workers run every 2 s: everything should be out well within a minute.
    const got = await eventually(
      async () => {
        const mine = (await sinkMessages()).filter((m) => m.to.some((t) => addresses.includes(t)));
        return mine.length >= COUNT ? mine : null;
      },
      120_000,
      2_000,
    );
    // Give a duplicate a chance to show up, then count: each address exactly once.
    await new Promise((r) => setTimeout(r, 10_000));
    const all = (await sinkMessages()).filter((m) => m.to.some((t) => addresses.includes(t)));
    const perAddress = new Map<string, number>();
    for (const m of all) for (const t of m.to) if (addresses.includes(t)) perAddress.set(t, (perAddress.get(t) ?? 0) + 1);
    expect(all.length).toBe(COUNT);
    expect([...perAddress.values()].every((n) => n === 1)).toBe(true);
    expect(got.length).toBe(COUNT);
    const rows = await sql<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM "OutMessage" WHERE "shopId" = $1 GROUP BY status`, [shopId]);
    expect(rows).toEqual([{ status: "SENT", n: COUNT }]);
  } finally {
    await sql(`DELETE FROM "Shop" WHERE id = $1`, [shopId]);
    await disconnect();
  }
});
