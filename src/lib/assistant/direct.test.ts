// The Assistant's direct AI path, the parts that need no database or network (npm run test:unit): which model a class uses,
// token caps, what a call costs a company on its own key, what looks like an Anthropic key, and one-at-a-time with an hourly cap.
import test from "node:test";
import assert from "node:assert/strict";
import { costMillicents, looksLikeAnthropicKey, maxTokensFor, modelFor, releaseSlot, takeSlot } from "./direct-math";

test("each class has its model, and an environment variable moves a class to another", () => {
  const keep = process.env.ASSISTANT_MODEL_READ;
  try {
    delete process.env.ASSISTANT_MODEL_READ;
    assert.equal(modelFor("draft"), "claude-sonnet-5-5");
    assert.equal(modelFor("suggest"), "claude-sonnet-5-5");
    assert.equal(modelFor("read"), "claude-haiku-4-5-20251001");
    assert.equal(modelFor("manuals"), "claude-opus-5-5");
    process.env.ASSISTANT_MODEL_READ = "  claude-sonnet-5-5 ";
    assert.equal(modelFor("read"), "claude-sonnet-5-5");
    process.env.ASSISTANT_MODEL_READ = "   ";
    assert.equal(modelFor("read"), "claude-haiku-4-5-20251001", "blank means the default");
  } finally {
    if (keep === undefined) delete process.env.ASSISTANT_MODEL_READ;
    else process.env.ASSISTANT_MODEL_READ = keep;
  }
});

test("a request is capped at its class's limit, and the packing-slip reader may go higher", () => {
  assert.equal(maxTokensFor("draft", "draft_work_done", 99999), 1500);
  assert.equal(maxTokensFor("draft", "draft_work_done", 300), 300);
  assert.equal(maxTokensFor("read", "read_plate", 5000), 600);
  assert.equal(maxTokensFor("read", "read_invoice", 5000), 2000);
  assert.equal(maxTokensFor("manuals", "ask_manuals", 5000), 2500);
  assert.equal(maxTokensFor("draft", "draft_work_done", 0), 1, "never zero");
});

test("what a call costs on the company's own key, in thousandths of a cent", () => {
  // Sonnet: $2 in, $0.20 cache read, $10 out per million tokens.
  assert.equal(costMillicents("claude-sonnet-5-5", { input: 1_000_000 }), 200_000);
  assert.equal(costMillicents("claude-sonnet-5-5", { output: 1_000_000 }), 1_000_000);
  assert.equal(costMillicents("claude-sonnet-5-5", { cacheRead: 1_000_000 }), 20_000);
  assert.equal(costMillicents("claude-sonnet-5-5", { cacheWrite: 1_000_000 }), 250_000, "a cache write is 1.25 x input");
  assert.equal(costMillicents("claude-opus-5-5", { input: 1000, output: 500 }), Math.round((1000 * 4 + 500 * 20) / 10));
  assert.equal(costMillicents("some-new-model", { input: 1_000_000 }), 200_000, "an unknown model costs as Sonnet");
  assert.equal(costMillicents("claude-sonnet-5-5", {}), 0);
});

test("only something shaped like an Anthropic key is accepted, and nothing that could carry a header or a line", () => {
  assert.equal(looksLikeAnthropicKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz_-0123456789"), true);
  assert.equal(looksLikeAnthropicKey("sk-ant-0123456789abcdef"), true);
  for (const bad of ["", "sk-ant-", "sk-ant-short", "sk_live_abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz", "sk-ant-abcdefghijklmnop\nx-evil: 1", "sk-ant-abcdefghijklmnop ", "sk-ant-abcdefgh ijklmnop", `sk-ant-${"a".repeat(400)}`]) {
    assert.equal(looksLikeAnthropicKey(bad), false, JSON.stringify(bad).slice(0, 40));
  }
});

test("a company asks one thing at a time, and at most 60 an hour", () => {
  const shop = "slot-test-shop";
  const t0 = 1_000_000_000;
  assert.equal(takeSlot(shop, t0), null);
  const busy = takeSlot(shop, t0 + 1);
  assert.match(busy?.message ?? "", /still answering/);
  releaseSlot(shop);
  assert.equal(takeSlot(shop, t0 + 2), null);
  releaseSlot(shop);
  for (let i = 3; i <= 60; i++) {
    assert.equal(takeSlot(shop, t0 + i), null, `call ${i}`);
    releaseSlot(shop);
  }
  assert.match(takeSlot(shop, t0 + 100)?.message ?? "", /Too many Assistant calls in the last hour \(60\)/);
  assert.equal(takeSlot(shop, t0 + 3_600_001 + 2), null, "an hour later the early ones no longer count");
  releaseSlot(shop);
  assert.equal(takeSlot("another-shop", t0), null, "another company has its own count");
  releaseSlot("another-shop");
});
