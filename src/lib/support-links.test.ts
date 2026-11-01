import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORT_LINKS } from "@/lib/support-links";

test("the support links are the YouTube channel and the donation page, both over https", () => {
  assert.equal(new URL(SUPPORT_LINKS.youtube).host, "www.youtube.com");
  assert.equal(new URL(SUPPORT_LINKS.donate).host, "buymeacoffee.com");
  for (const u of Object.values(SUPPORT_LINKS)) assert.equal(new URL(u).protocol, "https:");
});
