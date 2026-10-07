// The Anthropic stand-in for tests/assistant.spec.ts: the hub's Messages API calls go here (ANTHROPIC_API_BASE=http://127.0.0.1:3404,
// ANTHROPIC_API_KEY=sk-ant-spec on the test hub). It answers by what the request is: a plate photo, a "work done" draft, or a
// question about the manuals (the first page offered, cited). Anything else gets "unexpected request".
//   node scripts/local-test/assistant-mock.mjs        (port ANTHROPIC_MOCK_PORT, default 3404)
import { startAnthropicMock } from "../test-mail/anthropic-mock.mjs";

const answer = (rec) => {
  if (rec.system.startsWith("You read the rating plate")) return '{"brand":"Janome","model":"MC6700P","serial":"SPEC123456","machineType":"Embroidery","confidence":"sure"}';
  if (rec.system.startsWith("You answer a repair technician's question")) {
    const ref = /\[(m\d+)\]/.exec(rec.userText)?.[1];
    if (!ref) return '{"found":false}';
    return JSON.stringify({ found: true, answer: `Loosen the timing screw and set the hook to the needle [${ref}].`, sources: [ref] });
  }
  if (rec.system.startsWith("You help the staff")) return "We replaced the bobbin case and reset the hook timing, then tested the stitch.";
  // Phase 4 (shop-features-round-2-design.md section 5): Ask your shop picks best sellers and words the first row.
  if (rec.system.startsWith("You pick which")) return /unicorn/i.test(rec.userText) ? '{"report":"none"}' : '{"report":"best_sellers","from":"2020-01-01","to":"2099-12-31","kind":"FABRIC","collection":"Kona Solids","top":5}';
  if (rec.system.startsWith("You answer a shop owner")) return `The best seller was ${/1\. ([^\n]+)/.exec(rec.userText)?.[1] ?? "nothing"}.`;
  // Marketing drafts.
  if (rec.system.includes("email to the shop's customers")) return "Subject: New fabric is in\n\nHi {first_name},\n\nFresh fabric just arrived.\n\n{shop_name}";
  if (rec.system.includes("describing this class")) return "Learn to bind a quilt in one evening.";
  if (rec.system.includes("online store")) return "A soft quilting cotton in a deep navy.";
  if (rec.system.includes("social media post")) return "New in! Come see us. #quilting";
  if (rec.system.startsWith("You look at photos of a used machine")) return "Light scratches on the bed, bobbin cover missing.";
  // Quilt from stock: the first fabric on the list for every part asked.
  if (rec.system.startsWith("You help a quilt shop pick")) {
    const roles = [...rec.userText.matchAll(/^- (.+): needs /gm)].map((m) => m[1]);
    return JSON.stringify({ picks: roles.map((role) => ({ role, ref: "f1", why: "Calm and creamy beside the focus" })) });
  }
  return "unexpected request";
};

const mock = await startAnthropicMock({ port: Number(process.env.ANTHROPIC_MOCK_PORT) || 3404, respond: answer });
console.log(`anthropic mock (assistant spec) on ${mock.url}`);
