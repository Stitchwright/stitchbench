// The Foundry Account client against the stand-in service (scripts/test-mail/foundry-mock.mjs): sign up and in, the
// account, AI paid in credits, and every way the service can say no (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { startFoundryMock } from "../../../scripts/test-mail/foundry-mock.mjs";
import { checkCloudUrl, forgotPassword, getAccount, isFoundryError, OFFLINE_NOTICE, sendMessages, signIn, signOut, signUp, type FoundryError } from "./cloud";

type Mock = Awaited<ReturnType<typeof startFoundryMock>>;
const PASSWORD = "fire truck 1";
const ask = { model: "claude-opus-5-5", max_tokens: 200, messages: [{ role: "user", content: "How tight is the upper tension?" }] };

async function withMock(opts: Parameters<typeof startFoundryMock>[0], run: (mock: Mock, o: { baseUrl: string }) => Promise<void>) {
  const mock = await startFoundryMock({ port: 0, ...opts });
  try {
    await run(mock, { baseUrl: mock.url });
  } finally {
    await mock.close();
  }
}

async function failsWith(p: Promise<unknown>, kind: string, status: number): Promise<FoundryError> {
  try {
    await p;
  } catch (e) {
    assert.ok(isFoundryError(e), `a FoundryError, got ${String(e)}`);
    assert.equal(e.kind, kind);
    assert.equal(e.status, status);
    return e;
  }
  assert.fail("should have failed");
}

test("sign up gives a token and the account, with the sign-up credits; the email is tidied", async () => {
  await withMock({}, async (_m, o) => {
    const s = await signUp("  Denise@Example.COM ", PASSWORD, o);
    assert.match(s.token, /^sfs_[0-9a-f]{64}$/);
    assert.deepEqual(s.account, { id: 1, email: "denise@example.com", credits: 100 });
    assert.equal((await signUp("pat@example.com", PASSWORD, o)).account.id, 2, "ids count up and never change");
  });
});

test("sign up is refused for a taken email, a short password and a made-up address, in the service's words", async () => {
  await withMock({}, async (_m, o) => {
    await signUp("denise@example.com", PASSWORD, o);
    const taken = await failsWith(signUp("Denise@example.com", "another one", o), "refused", 409);
    assert.match(taken.message, /already an account/);
    const short = await failsWith(signUp("x@example.com", "short", o), "refused", 400);
    assert.match(short.message, /at least 8/);
    await failsWith(signUp("not an address", PASSWORD, o), "refused", 400);
  });
});

test("sign in works with the right password; a wrong one is signed-out, and five in a row lock the email", async () => {
  await withMock({}, async (_m, o) => {
    await signUp("denise@example.com", PASSWORD, o);
    assert.equal((await signIn("DENISE@example.com", PASSWORD, o)).account.id, 1);
    await failsWith(signIn("denise@example.com", "wrong one", o), "signed-out", 401);
    await failsWith(signIn("nobody@example.com", PASSWORD, o), "signed-out", 401);
    for (let i = 0; i < 4; i++) await failsWith(signIn("denise@example.com", "wrong again", o), "signed-out", 401);
    await failsWith(signIn("denise@example.com", PASSWORD, o), "wait", 429);
  });
});

test("the account shows the balance; after sign-out, or a password reset, the token is signed-out", async () => {
  await withMock({}, async (m, o) => {
    const s = await signUp("denise@example.com", PASSWORD, o);
    assert.deepEqual(await getAccount(s.token, o), s.account);
    await signOut(s.token, o);
    await failsWith(getAccount(s.token, o), "signed-out", 401);
    await signOut(s.token, o); // already ended: fine
    const t = await signIn("denise@example.com", PASSWORD, o);
    await fetch(`${m.url}/__expire`, { method: "POST", body: JSON.stringify({ email: "denise@example.com" }) });
    await failsWith(getAccount(t.token, o), "signed-out", 401);
    await failsWith(getAccount("sfs_made_up", o), "signed-out", 401);
  });
});

test("a forgotten password: the same answer whether or not there is an account", async () => {
  await withMock({}, async (m, o) => {
    await signUp("denise@example.com", PASSWORD, o);
    const known = await forgotPassword("denise@example.com", o);
    const unknown = await forgotPassword("nobody@example.com", o);
    assert.deepEqual(known, unknown);
    assert.equal(known.sent, true);
    assert.deepEqual(m.sent, [{ to: "denise@example.com" }], "only a real account is mailed");
    await failsWith(forgotPassword("not an address", o), "refused", 400);
  });
});

test("an AI request answers with its text and takes credits; the balance matches the account", async () => {
  await withMock({ respond: () => "About 40 to 60 grams." }, async (m, o) => {
    const s = await signUp("denise@example.com", PASSWORD, o);
    const a = await sendMessages(s.token, { ...ask, system: [{ type: "text", text: "You help sewing machine techs." }] }, o);
    assert.equal(a.text, "About 40 to 60 grams.");
    assert.equal(a.stopReason, "end_turn");
    assert.ok(a.usage.input > 0 && a.usage.output > 0);
    assert.ok(a.creditsSpent !== null && a.creditsSpent >= 1);
    assert.equal(a.creditsLeft, 100 - (a.creditsSpent ?? 0));
    assert.equal((await getAccount(s.token, o)).credits, a.creditsLeft);
    const seen = m.requests.find((r: { route: string }) => r.route === "POST /v1/messages");
    assert.equal(seen?.authorization, "Bearer sfs_…", "the mock log never holds the token");
  });
});

test("too few credits is no-credits and costs nothing; the service's other refusals are told apart", async () => {
  await withMock({ models: ["claude-opus-5-5"] }, async (m, o) => {
    const s = await signUp("denise@example.com", PASSWORD, o);
    await fetch(`${m.url}/__credits`, { method: "POST", body: JSON.stringify({ email: "denise@example.com", credits: 10 }) });
    await failsWith(sendMessages(s.token, ask, o), "no-credits", 402);
    assert.equal((await getAccount(s.token, o)).credits, 10);
    await fetch(`${m.url}/__credits`, { method: "POST", body: JSON.stringify({ email: "denise@example.com", credits: 100 }) });
    const model = await failsWith(sendMessages(s.token, { ...ask, model: "claude-haiku-4-5-20251001" }, o), "refused", 400);
    assert.match(model.message, /isn't offered/, "the allowlist is the service's (Opus only so far: see docs/plan.md)");
    await failsWith(sendMessages(s.token, { ...ask, max_tokens: 20000 }, o), "refused", 400);
    await failsWith(sendMessages(s.token, { ...ask, stream: true }, o), "refused", 400);
    await failsWith(sendMessages("sfs_made_up", ask, o), "signed-out", 401);
  });
});

test("a service without its AI key says not-open; a busy account is told to wait", async () => {
  await withMock({ ai: false }, async (_m, o) => {
    const s = await signUp("denise@example.com", PASSWORD, o);
    await failsWith(sendMessages(s.token, ask, o), "not-open", 503);
  });
  await withMock({ inFlight: 1, respond: () => ({ text: "slow", delayMs: 300 }) }, async (_m, o) => {
    const s = await signUp("denise@example.com", PASSWORD, o);
    const first = sendMessages(s.token, ask, o);
    await new Promise((r) => setTimeout(r, 80));
    await failsWith(sendMessages(s.token, ask, o), "wait", 429);
    assert.equal((await first).text, "slow");
  });
});

test("no answer at all is offline, with the wording every screen shows", async () => {
  const mock = await startFoundryMock({ port: 0 });
  const baseUrl = mock.url;
  await mock.close();
  const e = await failsWith(signIn("denise@example.com", PASSWORD, { baseUrl, timeoutMs: 2000 }), "offline", 0);
  assert.equal(e.message, OFFLINE_NOTICE);
  await failsWith(sendMessages("sfs_" + "0".repeat(64), ask, { baseUrl, timeoutMs: 2000 }), "offline", 0);
});

test("an answer that isn't the service's is broken, a redirect is not followed, and no error holds the token or password", async () => {
  const token = `sfs_${"a".repeat(64)}`;
  const say = (status: number, body: string, headers: Record<string, string> = {}) => async () => new Response(body, { status, headers });
  const o = (fetch: typeof globalThis.fetch) => ({ baseUrl: "http://127.0.0.1:1", fetch });
  await failsWith(signIn("a@b.co", PASSWORD, o(say(200, "<html>proxy login</html>"))), "broken", 0);
  await failsWith(signIn("a@b.co", PASSWORD, o(say(200, JSON.stringify({ token: "nope", account: { id: 1, email: "a@b.co" } })))), "broken", 0);
  await failsWith(signIn("a@b.co", PASSWORD, o(say(200, JSON.stringify({ token, account: { id: 0, email: "a@b.co" } })))), "broken", 0);
  await failsWith(getAccount(token, o(say(500, "boom"))), "broken", 500);
  await failsWith(getAccount(token, o(say(302, "", { location: "https://elsewhere.example/" }))), "broken", 302);
  await failsWith(sendMessages(token, ask, o(say(200, JSON.stringify({ nope: true })))), "broken", 0);
  const e = await failsWith(getAccount(token, o(say(401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "your sign-in has ended: sign in again" } })))), "signed-out", 401);
  for (const secret of [token, PASSWORD]) assert.ok(!e.message.includes(secret));
});

test("the request never follows redirects and carries the token only as a Bearer header", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const spy: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: 7, email: "a@b.co", credits: 5 }), { status: 200 });
  };
  const token = `sfs_${"b".repeat(64)}`;
  assert.deepEqual(await getAccount(token, { baseUrl: "https://cloud.example.com/", fetch: spy }), { id: 7, email: "a@b.co", credits: 5 });
  assert.equal(seen[0].url, "https://cloud.example.com/v1/account", "a trailing slash on the address is dropped");
  assert.equal(seen[0].init.redirect, "manual");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, `Bearer ${token}`);
  assert.ok(!seen[0].url.includes(token));
});

test("the service's address: https, or http for this computer; no passwords, queries or other schemes", () => {
  assert.equal(checkCloudUrl("https://cloud.stitchfoundry.app"), "https://cloud.stitchfoundry.app");
  assert.equal(checkCloudUrl("https://cloud.example.com/api/"), "https://cloud.example.com/api");
  assert.equal(checkCloudUrl("http://127.0.0.1:3405"), "http://127.0.0.1:3405");
  assert.equal(checkCloudUrl("http://localhost:8080"), "http://localhost:8080");
  for (const bad of ["", "cloud.stitchfoundry.app", "http://cloud.stitchfoundry.app", "ftp://x.example", "https://user:pw@x.example", "https://x.example/?a=1", "https://x.example/#top", "javascript:alert(1)"]) {
    assert.throws(() => checkCloudUrl(bad), `"${bad}"`);
  }
});
