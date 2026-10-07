// The hosted server's own bucket requests (src/lib/offsite/s3.ts): the bucket's answer becomes a Response, or a plain
// error, never an exception that leaves the request hanging (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { responseOf } from "@/lib/offsite/s3";

const body = (s = "hello") => Readable.from([Buffer.from(s)]);

test("an ordinary answer keeps its status and body", async () => {
  const r = responseOf(200, body());
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "hello");
  assert.equal((await responseOf(403, body("<Code>AccessDenied</Code>")).text()).includes("AccessDenied"), true);
});

test("the statuses with no body get none (205 used to throw inside the request's callback)", () => {
  for (const s of [204, 205, 304]) {
    const r = responseOf(s, body());
    assert.equal(r.status, s);
    assert.equal(r.body, null);
  }
});

test("a status a Response can't carry is a plain error", () => {
  for (const s of [0, 101, 199, 600, 999]) assert.throws(() => responseOf(s, body()), /doesn't understand/);
});
