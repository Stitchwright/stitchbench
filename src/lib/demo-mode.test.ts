import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEMO_BLOCKED, demoAddress, demoAllowWrite, demoRefuses, isDemo, messagesSwitchedOff } from "./demo-mode";

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  for (const [k, v] of Object.entries(vars)) put(k, v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) put(k, v);
  }
};

test("nothing changes unless DEMO_MODE is on", () => {
  withEnv({ DEMO_MODE: undefined, MESSAGES: undefined }, () => {
    assert.equal(isDemo(), false);
    assert.equal(demoRefuses("changePassword"), false);
    assert.equal(messagesSwitchedOff(), false);
  });
  withEnv({ DEMO_MODE: "off" }, () => assert.equal(isDemo(), false));
});

test("a demo refuses the listed actions and only those, sends no messages", () => {
  withEnv({ DEMO_MODE: "on", MESSAGES: undefined }, () => {
    assert.equal(isDemo(), true);
    for (const name of DEMO_BLOCKED) assert.equal(demoRefuses(name), true, name);
    assert.equal(demoRefuses("addPayment"), false, "selling still works");
    assert.equal(demoRefuses("saveShop"), false, "shop details can be edited (the reset undoes it)");
    assert.equal(messagesSwitchedOff(), true);
  });
  withEnv({ DEMO_MODE: "ON " }, () => assert.equal(isDemo(), true, "case and spaces do not matter"));
  withEnv({ DEMO_MODE: undefined, MESSAGES: "off" }, () => assert.equal(messagesSwitchedOff(), true, "MESSAGES=off still works on its own"));
});

test("every blocked name is a real server action, so the list cannot drift", () => {
  const dir = path.resolve(import.meta.dirname, "../actions");
  const source = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  // safe() reads the function's own name, or the name given to safe.whileLapsed("name"); an anonymous arrow would slip past the list.
  for (const name of DEMO_BLOCKED) assert.match(source, new RegExp(`function ${name}\\(|safe\\.whileLapsed\\("${name}"\\)`), `no action named ${name}`);
});

test("writes are limited per address, and the limit forgets after a minute", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 90; i++) assert.equal(demoAllowWrite("1.2.3.4", t0 + i), true);
  assert.equal(demoAllowWrite("1.2.3.4", t0 + 100), false, "the 91st in a minute is refused");
  assert.equal(demoAllowWrite("5.6.7.8", t0 + 100), true, "another address is not held up");
  assert.equal(demoAllowWrite("1.2.3.4", t0 + 61_000), true, "a minute later it is allowed again");
  assert.equal(demoAddress("9.9.9.9, 10.0.0.1"), "9.9.9.9");
  assert.equal(demoAddress(null), "unknown");
});

test("safe() itself refuses a blocked action in a demo before anything else runs, and lets others through", async () => {
  // action.ts reaches the database client when imported; nothing here connects to it.
  process.env.DATABASE_URL ??= "postgresql://demo:demo@localhost:5432/demo";
  const { safe } = await import("./action");
  let ran = false;
  const blocked = safe(async function changePassword() {
    ran = true;
  });
  const r = await withEnv({ DEMO_MODE: "on" }, () => blocked());
  assert.equal(ran, false, "the action did not run");
  assert.match(String(r.error), /isn't available in the demo/);
  const named = safe.whileLapsed("activateLicense")(async () => {
    ran = true;
  });
  const r2 = await withEnv({ DEMO_MODE: "on" }, () => named());
  assert.equal(ran, false, "an action named through safe.whileLapsed is refused too");
  assert.match(String(r2.error), /isn't available in the demo/);
});
