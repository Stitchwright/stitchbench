// The Assistant without StitchHub's proxy (docs/plan.md FA-4, FOUNDRY_AI=on), driving runAssistant, assistantAvailable and
// the source settings against the stand-in Foundry Account service (scripts/test-mail/foundry-mock.mjs, which offers Opus only,
// as the real one does so far) and the stand-in Anthropic API (anthropic-mock.mjs), with the dev database:
//   1. the switch: off by default (the hub path is the other check, assistant-hub.ts)
//   2. nothing to pay with: no call, and a plain sentence for why; the Assistant module needs no key (off: it still does)
//   3. Foundry credits: the class's model refused by the service, Opus asked instead and remembered; the cached system prompt,
//      the photo on the last message, the token as a Bearer header; the row's credits and the balance agree
//   4. not enough credits, no internet, a busy company, and an account that stopped being accepted
//   5. the company's own key: sealed in the database, calls go to Anthropic with it and never to the service, cost kept,
//      a refused key / out of credit / no internet in plain words, no Foundry Account needed
//   6. who may change the source, and what is refused (a bad key, "own" with none, removing the key while it is in use)
// The hub is never joined in this check, so a call that touched it would fail: none does.
//   npm run check scripts/checks/assistant-direct.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { startAnthropicMock } from "../test-mail/anthropic-mock.mjs";
import { startFoundryMock } from "../test-mail/foundry-mock.mjs";
import { foundryAiOn } from "@/lib/foundry/mode";
import { linkFoundry, unlinkFoundry } from "@/lib/foundry/link";
import { assistantAvailable, runAssistant } from "@/lib/assistant/client";
import { OFFLINE_NOTICE } from "@/lib/foundry/cloud";
import { saveSource, sourceView } from "@/lib/assistant/source";
import type { Built } from "@/lib/assistant/prompts";
import { isUserError } from "@/lib/user-error";
import { checkShop, cleanup } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const FPASS = "fire truck 1";
const OWN_KEY = "sk-ant-check0000000000000000000000";

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  set(vars);
  try {
    return await fn();
  } finally {
    set(was);
  }
}

async function failsWith(p: Promise<unknown>, re: RegExp, label: string) {
  try {
    await p;
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

const built = (cls: Built["cls"] = "draft", feature: Built["feature"] = "draft_work_done"): Built => ({
  feature,
  cls,
  system: "You help sewing machine techs write invoice wording.",
  messages: [{ role: "user", content: "Cleaned, oiled, checked the timing. Bobbin case cracked, replaced." }],
  maxTokens: 400,
});
const PHOTO = { mediaType: "image/jpeg" as const, data: "A".repeat(400) };

async function main() {
  assert.ok(process.env.AUTH_SECRET, "AUTH_SECRET (from .env) is needed to seal secrets");
  const foundry = await startFoundryMock({ port: 0, firstId: 3_000_000 + crypto.randomInt(1_000_000), respond: () => "Cleaned and oiled; replaced the cracked bobbin case." });
  const anthropic = await startAnthropicMock({ port: 0, key: OWN_KEY, respond: () => "Cleaned and oiled; replaced the cracked bobbin case." });
  const deadF = await startFoundryMock({ port: 0 });
  const deadA = await startAnthropicMock({ port: 0 });
  const deadFoundryUrl = deadF.url;
  const deadAnthropicUrl = deadA.url;
  await deadF.close();
  await deadA.close();
  const shop = await checkShop();
  const owner = { id: shop.user.id, shopId: shop.shopId, name: shop.user.name, role: "OWNER" as const };
  const tech = { ...owner, role: "TECH" as const };
  const run = (b: Built = built(), photo?: typeof PHOTO) => runAssistant({ shopId: shop.shopId, userId: owner.id, built: b, photo, needsModule: false });
  const env = { FOUNDRY_AI: "on", FOUNDRY_CLOUD_URL: foundry.url, ANTHROPIC_API_BASE: anthropic.url, STITCH_DESKTOP: undefined, FOUNDRY_LINK: undefined };
  try {
    // 1. The switch.
    await withEnv({ FOUNDRY_AI: undefined }, async () => assert.equal(foundryAiOn(), false));
    for (const [v, want] of [["on", true], [" ON ", true], ["off", false], ["yes", false], ["", false]] as const) await withEnv({ FOUNDRY_AI: v }, async () => assert.equal(foundryAiOn(), want, `"${v}"`));
    ok("FOUNDRY_AI is off unless it says on");

    await withEnv(env, async () => {
      // The Assistant add-on's key no longer applies when the AI is paid per use (checks run with PROGRAM_FREE=off).
      const mod = await assistantAvailable(shop.shopId, { module: true });
      assert.equal(!mod.ok && mod.why, "foundry", "the module is on without a key; what's missing is something to pay with");
      await withEnv({ FOUNDRY_AI: "off" }, async () => {
        const old = await assistantAvailable(shop.shopId, { module: true });
        assert.equal(!old.ok && old.why, "module", "with the switch off the Assistant still needs its own key");
      });

      // 2. Nothing to pay with.
      const a = await assistantAvailable(shop.shopId, { module: false });
      assert.equal(!a.ok && a.why, "foundry");
      await failsWith(run(), /Foundry Account|Foundry credits|own Anthropic key/, "no link, no key");
      assert.equal(await db.assistantCall.count({ where: { shopId: shop.shopId } }), 0, "nothing was sent, so nothing is logged (as before)");
      assert.equal(foundry.requests.filter((r: { route: string }) => r.route === "POST /v1/messages").length, 0, "no request was made");
      ok("nothing to pay with: no request and a plain sentence");

      // 3. Foundry credits.
      await linkFoundry(owner, { email: "denise@example.com", password: FPASS, create: true });
      assert.deepEqual(await assistantAvailable(shop.shopId, { module: false }), { ok: true });
      const first = await run(built("draft"), undefined);
      assert.equal(first.text, "Cleaned and oiled; replaced the cracked bobbin case.");
      const msgs = () => foundry.requests.filter((r: { route: string }) => r.route === "POST /v1/messages") as { authorization: string | null; body: Record<string, unknown> }[];
      assert.equal(msgs().length, 2, "the draft class's Sonnet was refused, Opus asked instead");
      assert.equal(msgs()[0].body.model, "claude-sonnet-5-5");
      assert.equal(msgs()[1].body.model, "claude-opus-5-5");
      assert.equal(msgs()[1].authorization, "Bearer sfs_…");
      assert.deepEqual((msgs()[1].body.system as { cache_control?: unknown }[])[0].cache_control, { type: "ephemeral" }, "the system prompt is cached");
      assert.equal(msgs()[1].body.max_tokens, 400);
      const row = await db.assistantCall.findUniqueOrThrow({ where: { id: first.row.id } });
      assert.equal(row.model, "claude-opus-5-5");
      assert.ok((row.credits ?? 0) >= 1, "credits taken are kept");
      assert.equal(row.costMillicents, 0);
      assert.equal(row.error, null);
      const before = msgs().length;
      await run(built("draft"), PHOTO);
      assert.equal(msgs().length, before + 1, "a refused model is remembered: one request, straight to Opus");
      const photoRequest = msgs()[msgs().length - 1];
      const plate = msgs().length;
      await run(built("read", "read_plate"));
      assert.equal(msgs().length, plate + 2, "another class's model (Haiku) is refused once too, then Opus");
      await run(built("read", "read_plate"));
      assert.equal(msgs().length, plate + 3, "and remembered");
      const withPhoto = photoRequest.body.messages as { content: { type: string }[] }[];
      assert.deepEqual(withPhoto[withPhoto.length - 1].content.map((c) => c.type), ["image", "text"], "the photo rides on the last message");
      const view = await sourceView(shop.shopId);
      assert.equal(view.source, "foundry");
      assert.equal(view.paying, "company");
      const spent = (await db.assistantCall.findMany({ where: { shopId: shop.shopId, error: null } })).reduce((s, c) => s + (c.credits ?? 0), 0);
      assert.equal(view.credits, 100 - spent, "the balance is what the credits taken leave");
      ok("Foundry credits: the refused model falls back and is remembered, the prompt is cached, the photo attached, credits and balance agree");

      // 4. The ways it can fail.
      await fetch(`${foundry.url}/__credits`, { method: "POST", body: JSON.stringify({ email: "denise@example.com", credits: 10 }) });
      await failsWith(run(), /Not enough Foundry credits/, "too few credits");
      await fetch(`${foundry.url}/__credits`, { method: "POST", body: JSON.stringify({ email: "denise@example.com", credits: 100 }) });
      await withEnv({ FOUNDRY_CLOUD_URL: deadFoundryUrl }, async () => {
        await failsWith(run(), new RegExp(OFFLINE_NOTICE.slice(0, 30)), "no internet");
      });
      // Busy: a company asks one thing at a time.
      await fetch(`${foundry.url}/__next`, { method: "POST", body: JSON.stringify({ text: "slow answer", delayMs: 400 }) });
      const slow = run();
      await new Promise((r) => setTimeout(r, 120));
      await failsWith(run(), /still answering/, "one at a time");
      assert.equal((await slow).text, "slow answer");
      // The service stops accepting the token: the link says so and the Assistant says what to do.
      await fetch(`${foundry.url}/__expire`, { method: "POST", body: JSON.stringify({ email: "denise@example.com" }) });
      await failsWith(run(), /sign-in has ended/, "token refused");
      assert.equal((await db.foundryLink.findUniqueOrThrow({ where: { shopId: shop.shopId } })).state, "signed-out");
      const closed = await assistantAvailable(shop.shopId, { module: false });
      assert.equal(!closed.ok && closed.why, "foundry");
      ok("too few credits, no internet, a busy company and a refused sign-in each say what to do; none costs anything");

      // 5. The company's own key.
      await unlinkFoundry(owner);
      const foundryCalls = foundry.requests.length;
      await failsWith(saveSource(owner, { source: "own", key: "", removeKey: false }), /Paste your Anthropic key/, "own with no key");
      await failsWith(saveSource(owner, { source: "own", key: "not a key", removeKey: false }), /doesn't look like an Anthropic key/, "a bad key");
      await failsWith(saveSource(tech, { source: "own", key: OWN_KEY, removeKey: false }), /owner or an admin/, "a tech");
      await saveSource(owner, { source: "own", key: OWN_KEY, removeKey: false });
      const saved = await db.assistantSettings.findUniqueOrThrow({ where: { shopId: shop.shopId } });
      assert.equal(saved.aiSource, "own");
      assert.ok(saved.ownKey?.startsWith("v1.") && !saved.ownKey.includes(OWN_KEY) && !saved.ownKey.includes("check0000"), "the key is sealed, not plain");
      assert.ok(await db.auditEntry.findFirst({ where: { shopId: shop.shopId, action: "assistant.source" } }), "an audit entry");
      assert.deepEqual(await assistantAvailable(shop.shopId, { module: false }), { ok: true }, "no Foundry Account is needed for the company's own key");
      const own = await run(built("manuals", "ask_manuals"));
      assert.equal(own.text, "Cleaned and oiled; replaced the cracked bobbin case.");
      const seen = (anthropic.requests as { model: string; headers: Record<string, string> }[])[anthropic.requests.length - 1];
      assert.equal(seen.model, "claude-opus-5-5", "the class's own model, no fallback");
      assert.equal(seen.headers["x-api-key"], OWN_KEY);
      assert.equal(foundry.requests.length, foundryCalls, "the Foundry service was not asked at all");
      const ownRow = await db.assistantCall.findUniqueOrThrow({ where: { id: own.row.id } });
      assert.equal(ownRow.credits, null);
      assert.ok(ownRow.costMillicents > 0, "what it cost the company's own account is kept");
      assert.equal((await sourceView(shop.shopId)).keyEnds, OWN_KEY.slice(-4), "only the last four characters are ever shown");
      await fetch(`${anthropic.url}/__next`, { method: "POST", body: JSON.stringify({ status: 401 }) });
      await failsWith(run(), /Anthropic refused your key/, "a refused key");
      await fetch(`${anthropic.url}/__next`, { method: "POST", body: JSON.stringify({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } }) });
      await failsWith(run(), /out of credit/, "out of credit");
      await withEnv({ ANTHROPIC_API_BASE: deadAnthropicUrl }, async () => failsWith(run(), /needs the internet/, "no internet on the own-key path"));
      ok("the company's own key: sealed, used straight against Anthropic, never the service, no Foundry Account needed, failures in plain words");

      // 6. Changing it.
      await failsWith(saveSource(owner, { source: "own", key: "", removeKey: true }), /Paste your Anthropic key/, "removing the key while it is in use");
      await saveSource(owner, { source: "foundry", key: "", removeKey: false });
      assert.equal((await db.assistantSettings.findUniqueOrThrow({ where: { shopId: shop.shopId } })).ownKey, saved.ownKey, "switching back keeps the key");
      await saveSource(owner, { source: "foundry", key: "", removeKey: true });
      assert.equal((await db.assistantSettings.findUniqueOrThrow({ where: { shopId: shop.shopId } })).ownKey, null);
      await failsWith(saveSource(owner, { source: "nope", key: "", removeKey: false }), /Choose/, "an unknown source");
      ok("switching sources keeps or removes the key as asked, and refuses what makes no sense");
    });
    console.log(`\n${steps} steps passed.`);
  } finally {
    await db.foundryLink.deleteMany({ where: { shopId: shop.shopId } });
    await foundry.close();
    await anthropic.close();
    await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
