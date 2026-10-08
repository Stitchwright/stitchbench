// The stand-in hub in front of the Anthropic mock (scripts/test-mail/anthropic-mock.mjs), for the phase 4 AI checks
// (shop-features-round-2-design.md section 5): the same shape as the one in assistant.check.ts, in one place.
//   const h = await startAssistantHub((rec) => "answer");   // rec: { system, userText, hasImage }
//   ... h.calls (what the hub received), h.next.push({ status: 402, error: "..." })
//   await h.close()                                         // stops both and puts the HubState row back
// No test spends money: nothing here reaches the real API.
import assert from "node:assert/strict";
import http from "node:http";
import { db } from "@/lib/db";
import { hubState } from "@/lib/hub";
import { isUserError } from "@/lib/user-error";
import { grantDevLicense } from "../license/dev";
import { startAnthropicMock } from "../test-mail/anthropic-mock.mjs";

export type HubCall = { auth: string | null; shop: string | null; body: Record<string, unknown> & { feature: string; model: string; system: string; messages: { role: string; content: string }[]; image?: { mediaType: string; data: string } } };
type Rec = { system: string; userText: string; hasImage: boolean };

const MODEL = { draft: "claude-sonnet-5-5", suggest: "claude-sonnet-5-5", read: "claude-haiku-4-5-20251001", manuals: "claude-opus-5-5" } as Record<string, string>;
export const PHOTO = Buffer.alloc(900, 7).toString("base64");

export async function startAssistantHub(respond: (rec: Rec) => string) {
  const mock = await startAnthropicMock({ port: 0, key: "sk-ant-check-0000000000", respond: (rec: Rec) => respond(rec) });
  const calls: HubCall[] = [];
  const next: { status: number; error: string }[] = [];
  const counts = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return send(200, { ok: true });
    if (req.url === "/v1/assistant" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HubCall["body"] & { maxTokens: number };
      calls.push({ auth: req.headers.authorization ?? null, shop: (req.headers["x-shop-ref"] as string) ?? null, body });
      const scripted = next.shift();
      if (scripted) return send(scripted.status, { error: scripted.error });
      const last = body.messages[body.messages.length - 1];
      const content = body.image ? [{ type: "image", source: { type: "base64", media_type: body.image.mediaType, data: body.image.data } }, { type: "text", text: last.content }] : last.content;
      const r = await fetch(`${mock.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-check-0000000000", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL[body.model], max_tokens: body.maxTokens, system: [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content }] }),
      });
      const a = (await r.json()) as { content: { text: string }[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };
      const shop = String(body.shopRef);
      counts.set(shop, (counts.get(shop) ?? 0) + 1);
      return send(200, {
        text: a.content[0].text,
        stopReason: a.stop_reason,
        usage: { input: a.usage.input_tokens, cacheRead: a.usage.cache_read_input_tokens, output: a.usage.output_tokens },
        costMillicents: 450,
        model: MODEL[body.model],
        free: !body.key,
        month: "2026-10",
        calls: counts.get(shop),
        limit: 300,
      });
    }
    send(404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const saved = await hubState();
  const net = (globalThis as unknown as { __hubNet?: { offlineSince: number | null; checkedAt: number; lastOk: number } }).__hubNet;
  await db.hubState.upsert({ where: { id: 1 }, create: { id: 1, url, installKey: "ik_check", scope: "member", installId: "inst_check" }, update: { url, installKey: "ik_check", scope: "member", installId: "inst_check" } });
  if (net) Object.assign(net, { offlineSince: null, checkedAt: 0, lastOk: Date.now() });
  return {
    url,
    calls,
    next,
    /** The last request the hub got, as text (to look for what must never be sent). */
    lastSent: () => JSON.stringify(calls.at(-1)?.body ?? {}),
    close: async () => {
      await new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r())));
      await mock.close().catch(() => {});
      if (saved) await db.hubState.update({ where: { id: 1 }, data: { url: saved.url, installKey: saved.installKey, installId: saved.installId, scope: saved.scope } }).catch(() => {});
      else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => {});
    },
  };
}

/** The Assistant module on for a company (a dev key that started two days ago). */
export async function assistantOn(shopId: string) {
  await grantDevLicense(shopId, ["assistant"], { from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) });
}

export async function expectUserError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: threw ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, `${label}: wrong message`);
    return;
  }
  assert.fail(`${label}: nothing was refused`);
}

let steps = 0;
export const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
export const stepCount = () => steps;
