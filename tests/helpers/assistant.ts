// The Assistant for the e2e shop in the phase 4 AI specs (shop-features-round-2-design.md section 5), as
// tests/assistant.spec.ts does it: a development key through the owner's CLI (module on) and the test hub's comp (the
// call is allowed without paying). The hub's Anthropic stand-in is scripts/local-test/assistant-mock.mjs on :3404 (the test
// hub started with ANTHROPIC_API_BASE=http://127.0.0.1:3404 ANTHROPIC_API_KEY=sk-ant-spec). assistantOff() takes the key away.
import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
import { one, sql } from "../helpers";

const HUB = process.env.HUB_URL ?? "http://localhost:3200";
const ADMIN = process.env.HUB_ADMIN_TOKEN ?? "local-test-admin-token-123";
const ymd = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** `also`: other modules on the same key (marketing, scheduling), for pages that need them. */
export async function assistantOn(shopId: string, also: string[] = []) {
  execFileSync("npx", ["tsx", "scripts/license/dev.ts", "--grant", shopId, "--modules", ["assistant", ...also].join(","), "--from", ymd(-2), "--until", ymd(60), "--grace", "14"], { stdio: "pipe", shell: process.platform === "win32" });
  const installId = (await one<{ installId: string }>(`SELECT "installId" FROM "HubState" WHERE id = 1`))?.installId;
  expect(installId, "this install must be joined to the test hub").toBeTruthy();
  const comp = await fetch(`${HUB}/v1/admin/assistant/comp`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ installId, shopRef: shopId, until: ymd(60) }) });
  expect(comp.ok, "the hub's comp").toBe(true);
}

export async function assistantOff(shopId: string) {
  await sql(`DELETE FROM "License" WHERE "shopId" = $1`, [shopId]);
  await sql(`DELETE FROM "AssistantSettings" WHERE "shopId" = $1`, [shopId]);
}
