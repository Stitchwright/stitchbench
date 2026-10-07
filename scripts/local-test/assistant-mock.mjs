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
  return "unexpected request";
};

const mock = await startAnthropicMock({ port: Number(process.env.ANTHROPIC_MOCK_PORT) || 3404, respond: answer });
console.log(`anthropic mock (assistant spec) on ${mock.url}`);
