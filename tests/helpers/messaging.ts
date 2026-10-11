// The SMTP sink and Twilio mock (scripts/test-mail) as the messaging specs see them, and the Messages page's "Send
// now". Ports from SMTP_SINK_HTTP (default 2580) and TWILIO_MOCK_PORT (default 3401), as in design section 16.2.
import { expect, type Page } from "@playwright/test";

const sinkHttp = () => `http://127.0.0.1:${process.env.SMTP_SINK_HTTP ?? "2580"}`;
const mockHttp = () => `http://127.0.0.1:${process.env.TWILIO_MOCK_PORT ?? "3401"}`;

export type SinkMessage = { from: string; to: string[]; user: string | null; raw: string; at: string };
export type MockSent = { sid: string; to: string; from: string; body: string; at: string };

/** Every email the sink has received. */
export async function sinkMessages(): Promise<SinkMessage[]> {
  const r = await fetch(`${sinkHttp()}/`);
  return (await r.json()) as SinkMessage[];
}

export async function clearSink(): Promise<void> {
  await fetch(`${sinkHttp()}/`, { method: "DELETE" });
}

/** Every text the mock was asked to send. */
export async function mockSent(): Promise<MockSent[]> {
  const r = await fetch(`${mockHttp()}/__sent`);
  return (await r.json()) as MockSent[];
}

export async function clearMockSent(): Promise<void> {
  await fetch(`${mockHttp()}/__sent`, { method: "DELETE" });
}

/** A reply a customer texted to the shop's Twilio number (`to` defaults to the mock's shop number used by the specs). */
export async function mockInbound(from: string, body: string, to = process.env.TWILIO_TEST_FROM ?? "+12125550100", at?: Date): Promise<void> {
  await fetch(`${mockHttp()}/__inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ From: from, To: to, Body: body, ...(at ? { at: at.toISOString() } : {}) }),
  });
}

/**
 * The Messages page's "Send now" (under Troubleshooting; admins), then waits for the worker's answer toast. Without
 * Marketing there is no Messages page (the ready notices are in the base and the worker still sends them every few
 * seconds on the test server), so there is nothing to tap.
 */
export async function sendNow(page: Page): Promise<void> {
  await page.goto("/messages");
  const details = page.locator("details", { hasText: "Troubleshooting" });
  const off = page.getByText(/isn't switched on for this company/);
  await expect(details.or(off).first()).toBeVisible();
  if (await off.count()) return;
  await details.locator("summary").click();
  await details.getByRole("button", { name: "Send now" }).click();
  await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
}

/** Polls until `check` passes or the time runs out (the worker runs every few seconds on a test server). */
export async function eventually<T>(check: () => Promise<T | null | false | undefined>, ms = 30_000, every = 1_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, every));
  }
}
